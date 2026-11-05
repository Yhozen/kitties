import { libraryControlReply } from "./library-control-wire.ts";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { LibraryRecoveryStore, nativeLibraryControlDatabase } from "./library-recovery-store.ts";
import { GlobalRecoveryAuthority } from "./library-recovery-authority.ts";
import { LibraryRecoveryError } from "./library-recovery-records.ts";

export class RecoveryDO extends Cloudflare.DurableObject<RecoveryDO>()(
  "RecoveryDO",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      const database = nativeLibraryControlDatabase(state.raw.storage);

      const authority = yield* GlobalRecoveryAuthority.pipe(
        Effect.provide(GlobalRecoveryAuthority.layer(database, Date.now)),
      );

      const library = yield* LibraryRecoveryStore.pipe(
        Effect.provide(LibraryRecoveryStore.layer(database, authority)),
        Effect.orDie,
      );

      return yield* Effect.sync(() => {
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
          libraryCompletePublication: (id: string) =>
            libraryControlReply(
              Effect.try({
                try: () => database.transaction(() => authority.completePublication(id)),
                catch: (cause) =>
                  Schema.is(LibraryRecoveryError)(cause)
                    ? cause
                    : new LibraryRecoveryError({ reason: "storage" }),
              }).pipe(Effect.asVoid),
            ),
          libraryComplete: (id: string) =>
            libraryControlReply(
              Effect.try({
                try: () => database.transaction(() => authority.completeGlobal(id)),
                catch: (cause) =>
                  Schema.is(LibraryRecoveryError)(cause)
                    ? cause
                    : new LibraryRecoveryError({ reason: "storage" }),
              }),
            ),
          libraryStatus: () => libraryControlReply(library.status),
          libraryInitialize: (...args: Parameters<typeof library.initialize>) =>
            libraryControlReply(library.initialize(...args)),
          libraryFinishImport: (...args: Parameters<typeof library.finishImport>) =>
            libraryControlReply(library.finishImport(...args)),
          libraryAdmit: (...args: Parameters<typeof library.admit>) =>
            libraryControlReply(library.admit(...args)),
          libraryResolve: (...args: Parameters<typeof library.resolve>) =>
            libraryControlReply(library.resolve(...args)),
          libraryRegister: (...args: Parameters<typeof library.register>) =>
            libraryControlReply(library.register(...args)),
          libraryLookup: (...args: Parameters<typeof library.lookup>) =>
            libraryControlReply(library.lookup(...args)),
          libraryInventory: (...args: Parameters<typeof library.inventory>) =>
            libraryControlReply(library.inventory(...args)),
          libraryRecoverySet: (...args: Parameters<typeof library.recoverySet>) =>
            libraryControlReply(library.recoverySet(...args)),
          libraryPublication: (...args: Parameters<typeof library.publication>) =>
            libraryControlReply(library.publication(...args)),
          libraryImage: (...args: Parameters<typeof library.image>) =>
            libraryControlReply(library.image(...args)),
          libraryAuthorizeCapture: (...args: Parameters<typeof library.authorizeCapture>) =>
            libraryControlReply(library.authorizeCapture(...args)),
          libraryProgress: (...args: Parameters<typeof library.progress>) =>
            libraryControlReply(library.progress(...args)),
          libraryBeginFreeze: (...args: Parameters<typeof library.beginFreeze>) =>
            libraryControlReply(library.beginFreeze(...args)),
          libraryAcknowledgeFreeze: (...args: Parameters<typeof library.acknowledgeFreeze>) =>
            libraryControlReply(library.acknowledgeFreeze(...args)),
          libraryRecordImage: (...args: Parameters<typeof library.recordImage>) =>
            libraryControlReply(library.recordImage(...args)),
          librarySeal: (...args: Parameters<typeof library.seal>) =>
            libraryControlReply(library.seal(...args)),
          libraryPrepareRestore: (...args: Parameters<typeof library.prepareRestore>) =>
            libraryControlReply(library.prepareRestore(...args)),
          libraryRecordLoaded: (...args: Parameters<typeof library.recordLoaded>) =>
            libraryControlReply(library.recordLoaded(...args)),
          libraryBeginActivation: (...args: Parameters<typeof library.beginActivation>) =>
            libraryControlReply(library.beginActivation(...args)),
          libraryAcknowledgeActive: (...args: Parameters<typeof library.acknowledgeActive>) =>
            libraryControlReply(library.acknowledgeActive(...args)),
          libraryPublish: (...args: Parameters<typeof library.publish>) =>
            libraryControlReply(library.publish(...args)),
          status: () => Effect.sync(control),
          chatgptContext: () =>
            Effect.try({
              try: () =>
                state.raw.storage.transactionSync(() => {
                  const current = control();

                  if (current.mode !== "ready") throw Error("CHATGPT_RECOVERY_FENCED");
                  sql.exec(
                    "INSERT OR IGNORE INTO recovery_records VALUES ('chatgpt-host','owner',?)",
                    `urn:uuid:${crypto.randomUUID()}`,
                  );

                  const hostId = sql
                    .exec<{ body: string }>(
                      "SELECT body FROM recovery_records WHERE kind='chatgpt-host' AND id='owner'",
                    )
                    .toArray()[0]!.body;

                  return { epoch: current.epoch, hostId };
                }),
              catch: () => "CHATGPT_RECOVERY_FENCED",
            }),
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
                sql.exec(
                  "UPDATE recovery_runs SET review=1 WHERE workflow=? AND id=?",
                  workflow,
                  id,
                );

              return allowed;
            }),
          begin: (id: string) =>
            Effect.try({
              try: () => database.transaction(() => authority.beginGlobal(id)),
              catch: (cause) =>
                Schema.is(LibraryRecoveryError)(cause)
                  ? cause
                  : new LibraryRecoveryError({ reason: "storage" }),
            }),
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
            Effect.try({
              try: () => database.transaction(() => authority.completeGlobal(id)),
              catch: (cause) =>
                Schema.is(LibraryRecoveryError)(cause)
                  ? cause
                  : new LibraryRecoveryError({ reason: "storage" }),
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
    });
  }),
) {}
