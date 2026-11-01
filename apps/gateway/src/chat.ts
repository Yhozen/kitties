import { makeStorageAdmin } from "./storage-admin.ts";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { WorkflowEngine } from "effect/workflow";
import * as Effect from "effect/Effect";
import { Turn } from "./turn-definition.ts";

interface Row {
  [key: string]: string | number | null;
  id: string;
  payload: string;
  status: string;
  run_id: string | null;
  answer: string;
  at: number;
}
const makeChat = Effect.gen(function* () {
  const state = yield* Cloudflare.DurableObjectState;
  const engine = yield* WorkflowEngine.WorkflowEngine;
  const env = (yield* Cloudflare.WorkerEnvironment) as { KITTIES_KEK: string };
  return Effect.sync(() => {
    const sql = state.raw.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL,run_id TEXT,answer TEXT NOT NULL DEFAULT '',at INTEGER NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL,at INTEGER NOT NULL)",
    );
    sql.exec("CREATE TABLE IF NOT EXISTS chat_state (key TEXT PRIMARY KEY,body TEXT NOT NULL)");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS rounds (id TEXT NOT NULL,round INTEGER NOT NULL,attempt INTEGER NOT NULL,history TEXT,PRIMARY KEY(id,round))",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS model_rounds (id TEXT NOT NULL,round INTEGER NOT NULL,history TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,round))",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS tool_results (id TEXT NOT NULL,call_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,call_id))",
    );
    const event = (body: unknown): void => {
      sql.exec("INSERT INTO events(body,at) VALUES (?,?)", JSON.stringify(body), Date.now());
    };
    const pump = Effect.gen(function* () {
      const row = sql
        .exec<Row>(
          "SELECT * FROM messages WHERE status IN ('queued','running') ORDER BY at,rowid LIMIT 1",
        )
        .toArray()[0];
      if (!row) return;
      const executionId = yield* Turn.execute(
        JSON.parse(row.payload) as typeof Turn.payloadSchema.Type,
        { discard: true },
      ).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine));
      sql.exec(
        "UPDATE messages SET status='running',run_id=? WHERE id=? AND status='queued'",
        executionId,
        row.id,
      );
    });
    const safePump = pump.pipe(
      Effect.catchCause(() => Effect.promise(() => state.raw.storage.setAlarm(Date.now() + 5000))),
    );
    return {
      ...makeStorageAdmin(state, env.KITTIES_KEK, [
        "messages",
        "events",
        "chat_state",
        "rounds",
        "model_rounds",
        "tool_results",
      ]),
      enqueue: (payload: typeof Turn.payloadSchema.Type, start = true) =>
        Effect.gen(function* () {
          if (
            sql
              .exec("SELECT key FROM chat_state WHERE key=?", `cancel:${payload.messageId}`)
              .toArray().length
          )
            return { conflict: false, duplicate: false, cancelled: true };
          const body = JSON.stringify(payload);
          const row = sql
            .exec<Row>("SELECT * FROM messages WHERE id=?", payload.messageId)
            .toArray()[0];
          if (row && row.payload !== body)
            return { conflict: true, duplicate: false, cancelled: false };
          if (!row) {
            state.raw.storage.transactionSync(() => {
              sql.exec(
                "INSERT INTO messages(id,payload,status,at) VALUES (?,?,'queued',?)",
                payload.messageId,
                body,
                Date.now(),
              );
              event({
                type: "message",
                messageId: payload.messageId,
                kittyId: payload.kittyId,
                text: payload.text,
              });
            });
          }
          // Delegation owns child starts so the workflow engine records the correct parent.
          if (!start) {
            const runId = yield* Turn.executionId(payload);
            sql.exec(
              "UPDATE messages SET status='running',run_id=? WHERE id=? AND status='queued'",
              runId,
              payload.messageId,
            );
            return { conflict: false, duplicate: !!row, cancelled: false };
          }
          // Durable wake precedes the acknowledgment: a lost HTTP response cannot lose a turn.
          yield* Effect.promise(() => state.raw.storage.setAlarm(Date.now() + 1));
          // The alarm is the recovery path; start the durable run immediately on a warm request.
          yield* safePump;
          return { conflict: false, duplicate: !!row, cancelled: false };
        }),
      messages: () =>
        Effect.sync(() =>
          sql
            .exec<Row>("SELECT * FROM messages ORDER BY at,rowid LIMIT 200")
            .toArray()
            .map((row) => ({
              ...row,
              payload: JSON.parse(row.payload) as typeof Turn.payloadSchema.Type,
            })),
        ),
      snapshot: () =>
        Effect.sync(() => ({
          messages: sql
            .exec<Row>("SELECT * FROM messages ORDER BY at,rowid LIMIT 200")
            .toArray()
            .map((row) => ({
              ...row,
              payload: JSON.parse(row.payload) as typeof Turn.payloadSchema.Type,
            })),
          cursor: sql
            .exec<{ seq: number }>("SELECT COALESCE(MAX(seq),0) AS seq FROM events")
            .toArray()[0]!.seq,
        })),
      run: (id: string) =>
        Effect.sync(
          () => sql.exec<Row>("SELECT * FROM messages WHERE id=?", id).toArray()[0] ?? null,
        ),
      events: (after: number) =>
        Effect.sync(() =>
          sql
            .exec<{ seq: number; body: string }>(
              "SELECT seq,body FROM events WHERE seq>? ORDER BY seq LIMIT 1000",
              after,
            )
            .toArray(),
        ),
      roundResult: (id: string, round: number) =>
        Effect.sync(
          () =>
            !!sql
              .exec(
                "SELECT id FROM rounds WHERE id=? AND round=? AND history IS NOT NULL",
                id,
                round,
              )
              .toArray().length,
        ),
      beginRound: (id: string, round: number) =>
        Effect.sync(() =>
          state.raw.storage.transactionSync(() => {
            const completed = sql
              .exec<{ history: string; body: string }>(
                "SELECT history,body FROM model_rounds WHERE id=? AND round=?",
                id,
                round,
              )
              .toArray()[0];
            if (completed)
              return {
                completed: true,
                cancelled: false,
                attempt: 0,
                history: null as string | null,
                previous: null as { history: string; body: string } | null,
              };
            const row = sql.exec<Row>("SELECT * FROM messages WHERE id=?", id).toArray()[0];
            if (!row || row.status === "cancelled")
              return {
                completed: false,
                cancelled: true,
                attempt: 0,
                history: null as string | null,
                previous: null as { history: string; body: string } | null,
              };
            sql.exec(
              "INSERT INTO rounds VALUES (?,?,1,NULL) ON CONFLICT(id,round) DO UPDATE SET attempt=attempt+1",
              id,
              round,
            );
            const attempt = sql
              .exec<{ attempt: number }>(
                "SELECT attempt FROM rounds WHERE id=? AND round=?",
                id,
                round,
              )
              .toArray()[0]!.attempt;
            sql.exec(
              "INSERT OR IGNORE INTO chat_state VALUES (?,?)",
              `answer:${id}:${round}`,
              row.answer,
            );
            const prefix = sql
              .exec<{ body: string }>(
                "SELECT body FROM chat_state WHERE key=?",
                `answer:${id}:${round}`,
              )
              .toArray()[0]!.body;
            sql.exec("UPDATE messages SET answer=? WHERE id=? AND status='running'", prefix, id);
            event({ type: "round_reset", messageId: id, round, attempt, prefix });
            const previous =
              round > 0
                ? (sql
                    .exec<{ history: string; body: string }>(
                      "SELECT history,body FROM model_rounds WHERE id=? AND round=?",
                      id,
                      round - 1,
                    )
                    .toArray()[0] ?? null)
                : null;
            const history =
              previous?.history ??
              sql
                .exec<{ body: string }>("SELECT body FROM chat_state WHERE key='history'")
                .toArray()[0]?.body ??
              null;
            return { completed: false, cancelled: false, attempt, history, previous };
          }),
        ),
      modelRound: (id: string, round: number) =>
        Effect.sync(
          () =>
            sql
              .exec<{ history: string; body: string }>(
                "SELECT history,body FROM model_rounds WHERE id=? AND round=?",
                id,
                round,
              )
              .toArray()[0] ?? null,
        ),
      replay: () =>
        Effect.sync(() => {
          const result: { messageId: string; callId: string; screenshot: string }[] = [];
          for (const row of sql
            .exec<{ id: string; call_id: string; body: string }>(
              "SELECT id,call_id,body FROM tool_results ORDER BY rowid DESC LIMIT 1000",
            )
            .toArray()
            .reverse()) {
            const value = JSON.parse(row.body) as { result?: { screenshot?: unknown } };
            if (
              typeof value.result?.screenshot === "string" &&
              /^screenshots\/[a-zA-Z0-9_-]+\/[0-9]+\/[a-zA-Z0-9_.-]+$/.test(value.result.screenshot)
            )
              result.push({
                messageId: row.id,
                callId: row.call_id,
                screenshot: value.result.screenshot,
              });
          }
          return result;
        }),
      retire: () =>
        Effect.sync(() =>
          state.raw.storage.transactionSync(() => {
            const rows = sql
              .exec<Row>("SELECT * FROM messages WHERE status IN ('queued','running')")
              .toArray();
            for (const row of rows) {
              sql.exec("INSERT OR IGNORE INTO chat_state VALUES (?, 'true')", `cancel:${row.id}`);
              event({ type: "cancelled", messageId: row.id });
            }
            sql.exec("UPDATE messages SET status='cancelled' WHERE status IN ('queued','running')");
            return rows.flatMap((row) => (row.run_id ? [row.run_id] : []));
          }),
        ),
      toolResult: (id: string, callId: string) =>
        Effect.sync(
          () =>
            sql
              .exec<{ body: string }>(
                "SELECT body FROM tool_results WHERE id=? AND call_id=?",
                id,
                callId,
              )
              .toArray()[0]?.body ?? null,
        ),
      saveToolResult: (id: string, callId: string, body: string) =>
        Effect.sync(() => {
          if (body.length > 128000) throw Error("OUTPUT_LIMIT");
          sql.exec("INSERT OR IGNORE INTO tool_results VALUES (?,?,?)", id, callId, body);
          event({ type: "tool_result", messageId: id, callId, result: JSON.parse(body) });
        }),
      publish: (body: string) => Effect.sync(() => event(JSON.parse(body))),
      resetRound: (id: string, round: number) =>
        Effect.sync(() => {
          sql.exec(
            "INSERT INTO rounds VALUES (?,?,1,NULL) ON CONFLICT(id,round) DO UPDATE SET attempt=attempt+1",
            id,
            round,
          );
          const attempt = sql
            .exec<{ attempt: number }>(
              "SELECT attempt FROM rounds WHERE id=? AND round=?",
              id,
              round,
            )
            .toArray()[0]!.attempt;
          // Preserve text from earlier rounds; only the retried round is replaced.
          sql.exec(
            "INSERT OR IGNORE INTO chat_state VALUES (?,?)",
            `answer:${id}:${round}`,
            sql.exec<Row>("SELECT * FROM messages WHERE id=?", id).toArray()[0]?.answer ?? "",
          );
          const prefix = sql
            .exec<{ body: string }>(
              "SELECT body FROM chat_state WHERE key=?",
              `answer:${id}:${round}`,
            )
            .toArray()[0]!.body;
          sql.exec("UPDATE messages SET answer=? WHERE id=? AND status='running'", prefix, id);
          event({ type: "round_reset", messageId: id, round, attempt, prefix });
          return attempt;
        }),
      append: (id: string, text: string, round: number, attempt: number) =>
        Effect.sync(() => {
          const row = sql
            .exec<Row>("SELECT * FROM messages WHERE id=? AND status='running'", id)
            .toArray()[0];
          const current = sql
            .exec<{ attempt: number }>(
              "SELECT attempt FROM rounds WHERE id=? AND round=?",
              id,
              round,
            )
            .toArray()[0];
          if (!row || current?.attempt !== attempt) return;
          if (row.answer.length + text.length > 256000) throw Error("OUTPUT_LIMIT");
          sql.exec("UPDATE messages SET answer=answer||? WHERE id=?", text, id);
          event({ type: "delta", messageId: id, round, attempt, text });
        }),
      history: () =>
        Effect.sync(
          () =>
            sql
              .exec<{ body: string }>("SELECT body FROM chat_state WHERE key='history'")
              .toArray()[0]?.body ?? null,
        ),
      completeRound: (id: string, round: number, attempt: number, body: string) =>
        Effect.sync(() => {
          if (body.length > 1500000) throw Error("HISTORY_LIMIT");
          state.raw.storage.transactionSync(() => {
            const active = sql
              .exec<Row>("SELECT * FROM messages WHERE id=? AND status='running'", id)
              .toArray()[0];
            const current = sql
              .exec<{ attempt: number }>(
                "SELECT attempt FROM rounds WHERE id=? AND round=?",
                id,
                round,
              )
              .toArray()[0];
            if (!active || current?.attempt !== attempt) return;
            sql.exec("UPDATE rounds SET history='complete' WHERE id=? AND round=?", id, round);
            sql.exec(
              "INSERT INTO chat_state VALUES ('history',?) ON CONFLICT(key) DO UPDATE SET body=excluded.body",
              body,
            );
          });
        }),
      saveModelRound: (id: string, round: number, attempt: number, history: string, body: string) =>
        Effect.sync(() => {
          if (history.length > 1500000 || body.length > 128000) throw Error("HISTORY_LIMIT");
          return state.raw.storage.transactionSync(() => {
            const row = sql
              .exec<Row>("SELECT * FROM messages WHERE id=? AND status='running'", id)
              .toArray()[0];
            const current = sql
              .exec<{ attempt: number }>(
                "SELECT attempt FROM rounds WHERE id=? AND round=?",
                id,
                round,
              )
              .toArray()[0];
            if (!row || current?.attempt !== attempt) return false;
            sql.exec(
              "INSERT OR IGNORE INTO model_rounds VALUES (?,?,?,?)",
              id,
              round,
              history,
              body,
            );
            sql.exec("UPDATE rounds SET history='complete' WHERE id=? AND round=?", id, round);
            return true;
          });
        }),
      commitHistory: (id: string, body: string) =>
        Effect.sync(() => {
          if (body.length > 1500000) throw Error("HISTORY_LIMIT");
          const row = sql
            .exec<Row>("SELECT * FROM messages WHERE id=? AND status='running'", id)
            .toArray()[0];
          if (row)
            sql.exec(
              "INSERT INTO chat_state VALUES ('history',?) ON CONFLICT(key) DO UPDATE SET body=excluded.body",
              body,
            );
        }),
      resolveTurn: (id: string, answer: string, status: string) =>
        Effect.gen(function* () {
          state.raw.storage.transactionSync(() => {
            const row = sql.exec<Row>("SELECT * FROM messages WHERE id=?", id).toArray()[0];
            if (!row || !["queued", "running"].includes(row.status)) return;
            sql.exec("UPDATE messages SET answer=?,status=? WHERE id=?", answer, status, id);
            event({ type: "round_reset", messageId: id, attempt: -1, prefix: answer });
            event({ type: status, messageId: id });
          });
          yield* Effect.promise(() => state.raw.storage.setAlarm(Date.now() + 1));
        }),
      finish: (id: string, status: string) =>
        Effect.gen(function* () {
          state.raw.storage.transactionSync(() => {
            if (status === "cancelled")
              sql.exec("INSERT OR IGNORE INTO chat_state VALUES (?, 'true')", `cancel:${id}`);
            const row = sql.exec<Row>("SELECT * FROM messages WHERE id=?", id).toArray()[0];
            if (row?.status !== "running" && row?.status !== "queued") return;
            sql.exec("UPDATE messages SET status=? WHERE id=?", status, id);
            event({ type: status, messageId: id });
          });
          yield* Effect.promise(() => state.raw.storage.setAlarm(Date.now() + 1));
        }),
      alarm: () => safePump,
    };
  });
});
type ChatShape = Effect.Success<Effect.Success<typeof makeChat>>;
export class ChatDO extends Cloudflare.DurableObject<ChatDO, ChatShape>()("ChatDO") {}
export const ChatDOLive = ChatDO.make(makeChat);
