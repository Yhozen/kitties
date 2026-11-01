import * as Cloudflare from "@alchemy.run/cloudflare";
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import * as Migrator from "@effect/sql-sqlite-do/SqliteMigrator";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

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
    return {
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
export class KittyDO extends Cloudflare.DurableObject<KittyDO>()("KittyDO", makeActor) {}
export class ChatDO extends Cloudflare.DurableObject<ChatDO>()("ChatDO", makeActor) {}
