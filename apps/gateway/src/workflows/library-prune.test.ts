import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Data, Effect, Layer, Schema } from "effect";
import { Workflow, WorkflowEngine } from "effect/workflow";
import { expect } from "vite-plus/test";
import {
  type LibraryCapturePruneCandidate,
  LibraryCapturePrunePlan,
} from "../library-capture-prune-records.ts";
import {
  type LibraryCapturePruneRequest,
  LibraryCapturePruning,
} from "../library-capture-pruning.ts";
import { LibraryControl } from "../library-control.ts";
import { GlobalRecoveryAuthority } from "../library-recovery-authority.ts";
import { LibraryRecoveryStore, type LibraryControlDatabase } from "../library-recovery-store.ts";
import { LibraryArchiveError } from "../library-retained-archive-store.ts";
import { LibraryPruneSweep, LibraryPruneSweepResult } from "./library-prune.ts";

const Candidate = Data.taggedEnum<LibraryCapturePruneCandidate>();

const Probe = Workflow.make("LibraryPruneSelectionTest", {
  payload: { id: Schema.String },
  success: LibraryPruneSweepResult,
  error: Schema.String,
  idempotencyKey: ({ id }) => id,
});

const fixture = Effect.gen(function* () {
  const sql = yield* Effect.acquireRelease(
    Effect.sync(() => new DatabaseSync(":memory:")),
    (database) => Effect.sync(() => database.close()),
  );

  const database: LibraryControlDatabase = {
    query: (statement, ...bindings) =>
      Schema.decodeUnknownSync(Schema.Array(Schema.JsonObject))(
        sql.prepare(statement).all(...bindings),
      ),
    transaction: (body) => {
      sql.exec("BEGIN IMMEDIATE");

      try {
        const result = body();
        sql.exec("COMMIT");

        return result;
      } catch (cause) {
        sql.exec("ROLLBACK");
        throw cause;
      }
    },
  };

  sql.exec(
    "CREATE TABLE recovery_control (id INTEGER PRIMARY KEY,epoch INTEGER,operation_id TEXT,mode TEXT)",
  );
  sql.exec("INSERT INTO recovery_control VALUES (1,0,NULL,'ready')");
  sql.exec("CREATE TABLE recovery_runs (workflow TEXT,id TEXT,epoch INTEGER,review INTEGER)");

  const authority = yield* GlobalRecoveryAuthority.pipe(
    Effect.provide(GlobalRecoveryAuthority.layer(database, () => 100)),
  );

  const store = yield* LibraryRecoveryStore.pipe(
    Effect.provide(LibraryRecoveryStore.layer(database, authority)),
  );

  const cursors: Array<string | null> = [];
  const attempts: Array<LibraryCapturePruneRequest> = [];
  let abandoned = 0;

  const control = Layer.succeed(LibraryControl, {
    ...store,
    complete: () => Effect.die("Unexpected global completion"),
    completePublication: () => Effect.die("Unexpected publication"),
    capturePruneCandidates: ({ after }) =>
      Effect.sync(() => {
        cursors.push(after);

        return after === null
          ? { items: [], next: "start" }
          : {
              items: [
                Candidate.New({ captureId: "eligible", archiveId: "archive" }),
                Candidate.Resume({
                  operationId: "original-id",
                  captureId: "pending",
                  archiveId: "original-archive",
                }),
                Candidate.BlockedExpired({
                  operationId: "expired-id",
                  captureId: "expired",
                  archiveId: "expired-archive",
                }),
              ],
              next: null,
            };
      }),
  });

  const pruning = Layer.succeed(LibraryCapturePruning, {
    prune: (request) =>
      Effect.gen(function* () {
        attempts.push(request);

        if (request.operationId === "original-id")
          return yield* new LibraryArchiveError({ reason: "conflict" });

        return LibraryCapturePrunePlan.make({
          request: {
            pruneId: request.operationId,
            captureId: request.captureId,
            archiveId: request.archiveId,
            codeDigest: "a".repeat(64),
            manifestDigest: "b".repeat(64),
          },
          phase: "complete",
          reservedAt: 100,
          expiresAt: 200,
          capturedAt: 0,
          objectCount: 1,
        });
      }),
    abandon: () =>
      Effect.sync(() => {
        abandoned += 1;
      }).pipe(Effect.andThen(new LibraryArchiveError({ reason: "conflict" }))),
  });

  const sweep = LibraryPruneSweep.layer.pipe(Layer.provide([control, pruning]));

  const live = Probe.toLayer(() => LibraryPruneSweep.use((service) => service.run())).pipe(
    Layer.provide(sweep),
    Layer.provideMerge(WorkflowEngine.layerMemory),
  );

  return { live, cursors, attempts, abandoned: () => abandoned };
});

it.effect(
  "scheduled selection accepts a literal start cursor and replays exact requests without abandoning expired work",
  () =>
    Effect.gen(function* () {
      const state = yield* fixture;

      const result = yield* Effect.gen(function* () {
        const first = yield* Probe.execute({ id: "daily" });
        const replay = yield* Probe.execute({ id: "daily" });

        expect(replay).toEqual(first);

        return first;
      }).pipe(Effect.provide(state.live));

      expect(state.cursors).toEqual([null, "start"]);
      expect(state.attempts).toEqual([
        {
          operationId: "prune-5e7c712206b5706b3bf0bb4d984e740ac7dd7d192b141bb8f55555acb7e68ee4",
          captureId: "eligible",
          archiveId: "archive",
        },
        { operationId: "original-id", captureId: "pending", archiveId: "original-archive" },
      ]);
      expect(state.abandoned()).toBe(0);
      expect(result).toEqual({
        pages: 2,
        completed: 1,
        deferred: 1,
        blockedExpired: 1,
        refusals: [
          {
            request: {
              operationId: "original-id",
              captureId: "pending",
              archiveId: "original-archive",
            },
            reason: "conflict",
          },
          {
            request: {
              operationId: "expired-id",
              captureId: "expired",
              archiveId: "expired-archive",
            },
            reason: "expired",
          },
        ],
      });
    }).pipe(Effect.scoped),
);
