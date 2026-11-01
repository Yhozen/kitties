import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
export class RecoveryDO extends Cloudflare.DurableObject<RecoveryDO>()(
  "RecoveryDO",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.sync(() => {
      const sql = state.raw.storage.sql;
      sql.exec(
        "CREATE TABLE IF NOT EXISTS recovery_control (id INTEGER PRIMARY KEY,epoch INTEGER NOT NULL,operation_id TEXT,mode TEXT NOT NULL)",
      );
      sql.exec("INSERT OR IGNORE INTO recovery_control VALUES (1,0,NULL,'ready')");
      sql.exec(
        "CREATE TABLE IF NOT EXISTS recovery_objects (kind TEXT NOT NULL,name TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(kind,name))",
      );
      sql.exec(
        "CREATE TABLE IF NOT EXISTS recovery_runs (workflow TEXT NOT NULL,id TEXT NOT NULL,epoch INTEGER NOT NULL,review INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(workflow,id))",
      );
      sql.exec(
        "CREATE TABLE IF NOT EXISTS recovery_records (kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id))",
      );
      const control = () =>
        sql
          .exec<{ epoch: number; operation_id: string | null; mode: string }>(
            "SELECT * FROM recovery_control WHERE id=1",
          )
          .toArray()[0]!;
      return {
        status: () => Effect.sync(control),
        objects: () =>
          Effect.sync(() =>
            sql
              .exec<{ kind: string; name: string }>(
                "SELECT kind,name FROM recovery_objects ORDER BY kind,name",
              )
              .toArray(),
          ),
        register: (kind: string, name: string) =>
          Effect.sync(() => {
            sql.exec(
              "INSERT OR IGNORE INTO recovery_objects VALUES (?,?,?)",
              kind,
              name,
              Date.now(),
            );
          }),
        registerMany: (entries: readonly { kind: string; name: string }[]) =>
          Effect.sync(() =>
            state.raw.storage.transactionSync(() => {
              for (const entry of entries)
                sql.exec(
                  "INSERT OR IGNORE INTO recovery_objects VALUES (?,?,?)",
                  entry.kind,
                  entry.name,
                  Date.now(),
                );
            }),
          ),
        permit: (workflow: string, id: string, startedAt: number) =>
          Effect.sync(() => {
            const c = control();
            let row = sql
              .exec<{ epoch: number; review: number }>(
                "SELECT epoch,review FROM recovery_runs WHERE workflow=? AND id=?",
                workflow,
                id,
              )
              .toArray()[0];
            // A known run needs a fresh fence read, not a write transaction on every
            // activity. Registration is atomic on its first check only.
            if (!row) {
              state.raw.storage.transactionSync(() => {
                sql.exec(
                  "INSERT INTO recovery_runs(workflow,id,epoch) VALUES (?,?,?)",
                  workflow,
                  id,
                  c.epoch,
                );
                sql.exec(
                  "INSERT OR IGNORE INTO recovery_objects VALUES ('workflow',?,?)",
                  `${workflow}/${id}`,
                  Date.now(),
                );
              });
              row = { epoch: c.epoch, review: 0 };
            }
            const allowed = c.mode === "ready" && row.epoch === c.epoch && startedAt >= c.epoch;
            if (!allowed && row.review !== 1)
              sql.exec("UPDATE recovery_runs SET review=1 WHERE workflow=? AND id=?", workflow, id);
            return allowed;
          }),
        begin: (id: string) =>
          Effect.sync(() =>
            state.raw.storage.transactionSync(() => {
              const c = control();
              if (c.operation_id === id) return c;
              if (c.mode !== "ready") throw Error("RECOVERY_BUSY");
              sql.exec(
                "UPDATE recovery_control SET epoch=?,operation_id=?,mode='recovering' WHERE id=1",
                Math.max(c.epoch + 1, Date.now()),
                id,
              );
              sql.exec("UPDATE recovery_runs SET review=1 WHERE epoch<?", control().epoch);
              return control();
            }),
          ),
        claim: (kind: string, id: string, body: string) =>
          Effect.sync(() =>
            state.raw.storage.transactionSync(() => {
              const previous = sql
                .exec<{ body: string }>(
                  "SELECT body FROM recovery_records WHERE kind=? AND id=?",
                  kind,
                  id,
                )
                .toArray()[0];
              if (previous) return previous.body === body;
              sql.exec("INSERT INTO recovery_records VALUES (?,?,?)", kind, id, body);
              return true;
            }),
          ),
        complete: (id: string) =>
          Effect.sync(() => {
            sql.exec("UPDATE recovery_control SET mode='ready' WHERE id=1 AND operation_id=?", id);
            return control();
          }),
        reviews: () =>
          Effect.sync(() =>
            sql
              .exec<{ workflow: string; id: string; epoch: number }>(
                "SELECT workflow,id,epoch FROM recovery_runs WHERE review=1 ORDER BY workflow,id",
              )
              .toArray(),
          ),
        save: (kind: string, id: string, body: string) =>
          Effect.sync(() => {
            sql.exec(
              "INSERT INTO recovery_records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
              kind,
              id,
              body,
            );
          }),
        read: (kind: string, id: string) =>
          Effect.sync(
            () =>
              sql
                .exec<{ body: string }>(
                  "SELECT body FROM recovery_records WHERE kind=? AND id=?",
                  kind,
                  id,
                )
                .toArray()[0]?.body ?? null,
          ),
        list: (kind: string) =>
          Effect.sync(() =>
            sql
              .exec<{ id: string; body: string }>(
                "SELECT id,body FROM recovery_records WHERE kind=? ORDER BY id DESC LIMIT 100",
                kind,
              )
              .toArray(),
          ),
      };
    });
  }),
) {}
