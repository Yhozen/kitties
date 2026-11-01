import * as Cloudflare from "@alchemy.run/cloudflare";
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import * as Migrator from "@effect/sql-sqlite-do/SqliteMigrator";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { freshMemory, updateMemory, type Memory, type MemoryCommand } from "./memory.ts";
import { authorization, type RuleMode } from "./approval-policy.ts";

const makeActor = Effect.gen(function* () {
  const state = yield* Cloudflare.DurableObjectState;
  return Effect.gen(function* () {
    const database = yield* Layer.buildWithScope(
      SqliteClient.layer({ storage: state.raw.storage }),
      yield* Effect.scope,
    );
    const sql = Context.get(database, SqlClient.SqlClient);
    yield* Migrator.run({
      loader: Migrator.fromRecord({
        "1_initial": Effect.gen(function* () {
          const db = yield* SqlClient.SqlClient;
          yield* db`CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(kind,id))`;
          yield* db`CREATE TABLE probe_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, step INTEGER NOT NULL)`;
        }),
      }),
    }).pipe(Effect.provide(database), Effect.orDie);
    state.raw.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS charges (id TEXT PRIMARY KEY,day TEXT NOT NULL,kitty TEXT NOT NULL,tokens INTEGER NOT NULL,actions INTEGER NOT NULL)",
    );
    state.raw.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS connector_effects (id TEXT PRIMARY KEY,digest TEXT NOT NULL,status TEXT NOT NULL,result TEXT,at INTEGER NOT NULL)",
    );
    state.raw.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS capacity_leases (kitty TEXT PRIMARY KEY,generation INTEGER NOT NULL,operation_id TEXT NOT NULL,remote_id TEXT,at INTEGER NOT NULL)",
    );
    state.raw.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS webhook_deliveries (id TEXT PRIMARY KEY,digest TEXT NOT NULL,body TEXT NOT NULL,at INTEGER NOT NULL)",
    );
    const prepareTurn = (id: string, kittyId: string, health: string) =>
      Effect.sync(() =>
        state.raw.storage.transactionSync(() => {
          const raw = state.raw.storage.sql;
          const get = (kind: string, key: string) =>
            raw
              .exec<{ body: string }>("SELECT body FROM records WHERE kind=? AND id=?", kind, key)
              .toArray()[0]?.body;
          let body = get("turn-config", id);
          if (!body) {
            const kittyBody = get("kitty", kittyId);
            if (!kittyBody) throw Error("KITTY_NOT_FOUND");
            const kitty = JSON.parse(kittyBody) as import("./entities.ts").KittyProfile;
            const provider = kitty.providerId ? get("provider", kitty.providerId) : undefined;
            body = JSON.stringify({
              kitty,
              desktop: get("desktop-enabled", kittyId) === "true",
              provider: provider ? JSON.parse(provider) : null,
              connections: raw
                .exec<{ body: string }>(
                  "SELECT body FROM records WHERE kind='connection' ORDER BY id LIMIT 64",
                )
                .toArray()
                .map((row) => JSON.parse(row.body)),
              memory: get("memory", kittyId) ? JSON.parse(get("memory", kittyId)!) : freshMemory(),
              skills: raw
                .exec<{ body: string }>("SELECT body FROM records WHERE kind='skill' ORDER BY id")
                .toArray()
                .map((row) => JSON.parse(row.body))
                .filter((skill) => skill.status === "accepted")
                .slice(0, 8),
            });
            raw.exec("INSERT INTO records VALUES ('turn-config',?,?,?)", id, body, Date.now());
          }
          raw.exec(
            "INSERT INTO records VALUES ('run-health',?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at",
            id,
            health,
            Date.now(),
          );
          return (
            (JSON.parse(body) as { kitty: { limits?: { max_rounds: number } } }).kitty.limits
              ?.max_rounds ?? 12
          );
        }),
      );
    const turnContext = (id: string, day: string) =>
      Effect.sync(() => {
        const raw = state.raw.storage.sql,
          body = raw
            .exec<{ body: string }>(
              "SELECT body FROM records WHERE kind='turn-config' AND id=?",
              id,
            )
            .toArray()[0]?.body;
        if (!body) throw Error("CONFIG_NOT_FOUND");
        const kitty = (JSON.parse(body) as { kitty: { id: string } }).kitty.id;
        const spent = raw
          .exec<{ tokens: number; actions: number }>(
            "SELECT COALESCE(SUM(tokens),0) AS tokens,COALESCE(SUM(actions),0) AS actions FROM charges WHERE day=? AND kitty=?",
            day,
            kitty,
          )
          .toArray()[0]!;
        return { body, spent };
      });
    return {
      queueNotice: (
        eventId: string,
        kind: string,
        title: string,
        url: string,
        immediate: boolean,
      ) =>
        Effect.sync(() =>
          state.raw.storage.transactionSync(() => {
            const raw = state.raw.storage.sql,
              get = (type: string, id: string) =>
                raw
                  .exec<{ body: string }>(
                    "SELECT body FROM records WHERE kind=? AND id=?",
                    type,
                    id,
                  )
                  .toArray()[0]?.body;
            const prefs = get("settings", "notifications");
            if (!prefs) return;
            const settings = JSON.parse(prefs) as { enabled: boolean; events: string[] };
            if (!settings.enabled || !settings.events.includes(kind)) return;
            if (get("notification-event", eventId)) return;
            const at = Date.now(),
              fold = get("notification-fold", kind),
              previous = fold ? (JSON.parse(fold) as { id: string; dueAt: number }) : null;
            const batchId = !immediate && previous && previous.dueAt > at ? previous.id : eventId;
            const saved = get("notification-batch", batchId);
            const batch = saved
              ? (JSON.parse(saved) as {
                  title: string;
                  url: string;
                  dueAt: number;
                  count: number;
                  status: string;
                })
              : {
                  title: title.slice(0, 500),
                  url,
                  dueAt: at + (immediate ? 0 : 600000),
                  count: 0,
                  status: "pending",
                };
            batch.count++;
            raw.exec(
              "INSERT INTO records VALUES ('notification-event',?,?,?)",
              eventId,
              batchId,
              at,
            );
            raw.exec(
              "INSERT INTO records VALUES ('notification-batch',?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at",
              batchId,
              JSON.stringify(batch),
              at,
            );
            if (!immediate)
              raw.exec(
                "INSERT INTO records VALUES ('notification-fold',?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at",
                kind,
                JSON.stringify({ id: batchId, dueAt: batch.dueAt }),
                at,
              );
          }),
        ),
      authorizeTool: (kittyId: string, policyKey: string, always: boolean, free: boolean) =>
        Effect.sync(() => {
          const raw = state.raw.storage.sql,
            get = (kind: string, id: string) =>
              raw
                .exec<{ body: string }>("SELECT body FROM records WHERE kind=? AND id=?", kind, id)
                .toArray()[0]?.body;
          const rule = get("approval-rule", policyKey),
            trust = get("approval-trust", policyKey),
            memory = get("memory", kittyId);
          return authorization({
            always,
            free,
            mode: rule ? (JSON.parse(rule) as { mode: RuleMode }).mode : undefined,
            streak: trust ? (JSON.parse(trust) as { streak: number }).streak : 0,
            demand: memory ? (JSON.parse(memory) as Memory).profile.demand : 3,
          });
        }),
      claimWebhook: (id: string, digest: string, body: string) =>
        Effect.sync(() =>
          state.raw.storage.transactionSync(() => {
            const raw = state.raw.storage.sql;
            raw.exec(
              "INSERT OR IGNORE INTO webhook_deliveries VALUES (?,?,?,?)",
              id,
              digest,
              body,
              Date.now(),
            );
            const row = raw
              .exec<{ digest: string; body: string }>(
                "SELECT digest,body FROM webhook_deliveries WHERE id=?",
                id,
              )
              .toArray()[0]!;
            return { conflict: row.digest !== digest, body: row.body };
          }),
        ),
      saveGoal: (id: string, body: string) =>
        Effect.sync(() =>
          state.raw.storage.transactionSync(() => {
            const raw = state.raw.storage.sql;
            const old = raw
              .exec<{ body: string }>("SELECT body FROM records WHERE kind='goal' AND id=?", id)
              .toArray()[0];
            const previous = old ? (JSON.parse(old.body) as import("./entities.ts").Goal) : null;
            const goal = {
              ...JSON.parse(body),
              id,
              revision: (previous?.revision ?? 0) + 1,
              chatId: previous?.chatId ?? `goal-${id}`,
              updatedAt: Date.now(),
            } as import("./entities.ts").Goal;
            raw.exec(
              "INSERT INTO records VALUES ('goal',?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at",
              id,
              JSON.stringify(goal),
              Date.now(),
            );
            return goal;
          }),
        ),
      advanceGoalSlot: (id: string, revision: number, slot: number, next: number) =>
        Effect.sync(() =>
          state.raw.storage.transactionSync(() => {
            const raw = state.raw.storage.sql,
              row = raw
                .exec<{ body: string }>("SELECT body FROM records WHERE kind='goal' AND id=?", id)
                .toArray()[0];
            if (!row) return;
            const goal = JSON.parse(row.body) as import("./entities.ts").Goal;
            if (goal.revision !== revision || !goal.enabled || goal.nextSlot > slot) return;
            raw.exec(
              "UPDATE records SET body=?,updated_at=? WHERE kind='goal' AND id=?",
              JSON.stringify({ ...goal, nextSlot: next }),
              Date.now(),
              id,
            );
          }),
        ),
      prepareTurn,
      turnContext,
      beginTurnRound: (id: string, kittyId: string, health: string, day: string) =>
        prepareTurn(id, kittyId, health).pipe(Effect.flatMap(() => turnContext(id, day))),
      reserveCapacity: (
        kitty: string,
        generation: number,
        operationId: string,
        activeIds: readonly string[],
      ) =>
        Effect.sync(() =>
          state.raw.storage.transactionSync(() => {
            const raw = state.raw.storage.sql;
            const existing = raw
              .exec<{ operation_id: string; remote_id: string | null; generation: number }>(
                "SELECT operation_id,remote_id,generation FROM capacity_leases WHERE kitty=?",
                kitty,
              )
              .toArray()[0];
            if (existing?.operation_id === operationId) return true;
            if (
              existing?.remote_id &&
              existing.generation === generation &&
              activeIds.includes(existing.remote_id)
            ) {
              raw.exec(
                "UPDATE capacity_leases SET operation_id=?,at=? WHERE kitty=?",
                operationId,
                Date.now(),
                kitty,
              );
              return true;
            }
            if (existing) throw Error("CAPACITY_LEASE_CONFLICT");
            const reservations = raw
              .exec<{ remote_id: string | null }>("SELECT remote_id FROM capacity_leases")
              .toArray();
            const unobserved = reservations.filter(
              (row) => !row.remote_id || !activeIds.includes(row.remote_id),
            ).length;
            if (new Set(activeIds).size + unobserved >= 5) return false;
            raw.exec(
              "INSERT INTO capacity_leases VALUES (?,?,?,NULL,?)",
              kitty,
              generation,
              operationId,
              Date.now(),
            );
            return true;
          }),
        ),
      bindCapacity: (kitty: string, operationId: string, remoteId: string) =>
        Effect.sync(() => {
          state.raw.storage.sql.exec(
            "UPDATE capacity_leases SET remote_id=?,at=? WHERE kitty=? AND operation_id=?",
            remoteId,
            Date.now(),
            kitty,
            operationId,
          );
        }),
      releaseCapacity: (kitty: string, remoteId: string) =>
        Effect.sync(() => {
          state.raw.storage.sql.exec(
            "DELETE FROM capacity_leases WHERE kitty=? AND remote_id=?",
            kitty,
            remoteId,
          );
        }),
      capacityLeases: () =>
        Effect.sync(() =>
          state.raw.storage.sql
            .exec<{
              kitty: string;
              generation: number;
              operation_id: string;
              remote_id: string | null;
              at: number;
            }>("SELECT * FROM capacity_leases")
            .toArray(),
        ),
      memory: (id: string) =>
        Effect.sync(() => {
          const row = state.raw.storage.sql
            .exec<{ body: string }>("SELECT body FROM records WHERE kind='memory' AND id=?", id)
            .toArray()[0];
          return row ? (JSON.parse(row.body) as Memory) : freshMemory();
        }),
      applyDistillation: (runId: string, kittyId: string, command: string) =>
        Effect.sync(() =>
          state.raw.storage.transactionSync(() => {
            const raw = state.raw.storage.sql;
            if (
              raw.exec("SELECT id FROM records WHERE kind='distilled' AND id=?", runId).toArray()
                .length
            )
              return;
            const row = raw
              .exec<{ body: string }>(
                "SELECT body FROM records WHERE kind='memory' AND id=?",
                kittyId,
              )
              .toArray()[0];
            const next = updateMemory(
              row ? (JSON.parse(row.body) as Memory) : freshMemory(),
              JSON.parse(command) as MemoryCommand,
            );
            raw.exec(
              "INSERT INTO records VALUES ('memory',?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at",
              kittyId,
              JSON.stringify(next),
              Date.now(),
            );
            raw.exec("INSERT INTO records VALUES ('distilled',?,?,?)", runId, kittyId, Date.now());
          }),
        ),
      mutateMemory: (id: string, body: string) =>
        Effect.sync(() =>
          state.raw.storage.transactionSync(() => {
            const raw = state.raw.storage.sql;
            const row = raw
              .exec<{ body: string }>("SELECT body FROM records WHERE kind='memory' AND id=?", id)
              .toArray()[0];
            const next = updateMemory(
              row ? (JSON.parse(row.body) as Memory) : freshMemory(),
              JSON.parse(body) as MemoryCommand,
            );
            raw.exec(
              "INSERT INTO records VALUES ('memory',?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at",
              id,
              JSON.stringify(next),
              Date.now(),
            );
            return next;
          }),
        ),
      beginEffect: (id: string, digest: string) =>
        Effect.sync(() => {
          const raw = state.raw.storage.sql;
          raw.exec(
            "INSERT OR IGNORE INTO connector_effects VALUES (?,?,'started',NULL,?)",
            id,
            digest,
            Date.now(),
          );
          const row = raw
            .exec<{ digest: string; status: string; result: string | null }>(
              "SELECT digest,status,result FROM connector_effects WHERE id=?",
              id,
            )
            .toArray()[0]!;
          if (row.digest !== digest) throw Error("INTENT_CONFLICT");
          // created is returned only by the transaction that inserted the intent.
          return row;
        }),
      claimEffect: (id: string, digest: string) =>
        Effect.sync(() => {
          const raw = state.raw.storage.sql;
          return state.raw.storage.transactionSync(() => {
            const row = raw
              .exec<{ digest: string; status: string; result: string | null }>(
                "SELECT digest,status,result FROM connector_effects WHERE id=?",
                id,
              )
              .toArray()[0];
            if (row) {
              if (row.digest !== digest) throw Error("INTENT_CONFLICT");
              return { ...row, claimed: false };
            }
            raw.exec(
              "INSERT INTO connector_effects VALUES (?,?,'started',NULL,?)",
              id,
              digest,
              Date.now(),
            );
            return { digest, status: "started", result: null, claimed: true };
          });
        }),
      completeEffect: (id: string, result: string) =>
        Effect.sync(() => {
          if (result.length > 128000) throw Error("OUTPUT_LIMIT");
          state.raw.storage.sql.exec(
            "UPDATE connector_effects SET status='completed',result=? WHERE id=? AND status='started'",
            result,
            id,
          );
        }),
      decideHelp: (id: string, decision: string) =>
        Effect.sync(() =>
          state.raw.storage.transactionSync(() => {
            const sql = state.raw.storage.sql,
              saved = sql
                .exec<{ body: string }>(
                  "SELECT body FROM records WHERE kind='desktop-help' AND id=?",
                  id,
                )
                .toArray()[0];
            if (!saved) return false;
            const row = JSON.parse(saved.body) as { status: string; expiresAt: number };
            if (row.status === decision) return true;
            if (row.status !== "pending" || row.expiresAt <= Date.now()) return false;
            sql.exec(
              "UPDATE records SET body=?,updated_at=? WHERE kind='desktop-help' AND id=?",
              JSON.stringify({ ...row, status: decision }),
              Date.now(),
              id,
            );
            return true;
          }),
        ),
      decideApproval: (id: string, decision: boolean, digest: string) =>
        Effect.sync(() =>
          state.raw.storage.transactionSync(() => {
            const raw = state.raw.storage.sql;
            const row = raw
              .exec<{ body: string }>("SELECT body FROM records WHERE kind='approval' AND id=?", id)
              .toArray()[0];
            if (!row) return null;
            const value = JSON.parse(row.body) as import("./entities.ts").ApprovalRecord;
            if (value.digest !== digest) return null;
            const desired = decision ? "approved" : "denied";
            if (value.status === desired) return value;
            if (value.status !== "pending") return null;
            value.status = value.expiresAt <= Date.now() ? "expired" : desired;
            if (value.status !== "expired" && value.policyKey) {
              const key = value.policyKey;
              // This transition runs once, in the same transaction as the decision.
              const previous = raw
                .exec<{ body: string }>(
                  "SELECT body FROM records WHERE kind='approval-trust' AND id=?",
                  key,
                )
                .toArray()[0];
              const streak = decision
                ? (previous ? (JSON.parse(previous.body) as { streak: number }).streak : 0) + 1
                : 0;
              raw.exec(
                "INSERT INTO records VALUES ('approval-trust',?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at",
                key,
                JSON.stringify({ streak }),
                Date.now(),
              );
            }
            raw.exec(
              "UPDATE records SET body=?,updated_at=? WHERE kind='approval' AND id=?",
              JSON.stringify(value),
              Date.now(),
              id,
            );
            return value.status === "expired" ? null : value;
          }),
        ),
      expireApproval: (id: string) =>
        Effect.sync(() => {
          const raw = state.raw.storage.sql;
          const row = raw
            .exec<{ body: string }>("SELECT body FROM records WHERE kind='approval' AND id=?", id)
            .toArray()[0];
          if (!row) return;
          const value = JSON.parse(row.body) as import("./entities.ts").ApprovalRecord;
          if (value.status === "pending" && value.expiresAt <= Date.now()) {
            value.status = "expired";
            raw.exec(
              "UPDATE records SET body=?,updated_at=? WHERE kind='approval' AND id=?",
              JSON.stringify(value),
              Date.now(),
              id,
            );
          }
        }),
      insert: (kind: string, id: string, body: string) =>
        sql`INSERT OR IGNORE INTO records VALUES (${kind},${id},${body},${Date.now()})`.pipe(
          Effect.asVoid,
        ),
      charge: (id: string, day: string, kitty: string, tokens: number, actions: number) =>
        Effect.sync(() => {
          state.raw.storage.sql.exec(
            "INSERT OR IGNORE INTO charges VALUES (?,?,?,?,?)",
            id,
            day,
            kitty,
            tokens,
            actions,
          );
          return state.raw.storage.sql
            .exec<{ tokens: number; actions: number }>(
              "SELECT COALESCE(SUM(tokens),0) AS tokens,COALESCE(SUM(actions),0) AS actions FROM charges WHERE day=? AND kitty=?",
              day,
              kitty,
            )
            .toArray()[0]!;
        }),
      spent: (day: string, kitty: string) =>
        Effect.sync(
          () =>
            state.raw.storage.sql
              .exec<{ tokens: number; actions: number }>(
                "SELECT COALESCE(SUM(tokens),0) AS tokens,COALESCE(SUM(actions),0) AS actions FROM charges WHERE day=? AND kitty=?",
                day,
                kitty,
              )
              .toArray()[0]!,
        ),
      read: (kind: string, id: string) =>
        sql<{ body: string }>`SELECT body FROM records WHERE kind=${kind} AND id=${id}`.pipe(
          Effect.map((rows) => rows[0]?.body ?? null),
        ),
      write: (kind: string, id: string, body: string) =>
        sql`INSERT INTO records (kind,id,body,updated_at) VALUES (${kind},${id},${body},${Date.now()}) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at`.pipe(
          Effect.asVoid,
        ),
      list: (kind: string) =>
        sql<{
          id: string;
          body: string;
        }>`SELECT id,body FROM records WHERE kind=${kind} ORDER BY id`,
      remove: (kind: string, id: string) =>
        sql`DELETE FROM records WHERE kind=${kind} AND id=${id}`.pipe(Effect.asVoid),
      recordProbeCall: (runId: string, step: number) =>
        sql`INSERT INTO probe_calls (run_id,step) VALUES (${runId},${step})`.pipe(Effect.asVoid),
      probeCalls: (runId: string) =>
        sql<{
          step: number;
          calls: number;
        }>`SELECT step,COUNT(*) AS calls FROM probe_calls WHERE run_id=${runId} GROUP BY step ORDER BY step`,
    };
  });
});

export class HomeDO extends Cloudflare.DurableObject<HomeDO>()("HomeDO", makeActor) {}
export { KittyDO } from "./kitty.ts";
export { ChatDO } from "./chat.ts";
