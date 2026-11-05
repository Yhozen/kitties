import * as Data from "effect/Data";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { WorkflowEngine } from "effect/workflow";
import { LibraryControl } from "../library-control.ts";
import { LibraryCapturePruneRequest, LibraryCapturePruning } from "../library-capture-pruning.ts";
import { libraryImageDigest } from "../library-image.ts";
import { RecoveryOperationId, RecoveryOrdinal } from "../library-recovery-records.ts";
import { guardedActivities } from "../recovery-guard.ts";

const RefusalReason = Schema.Literals(["invalid", "conflict", "incomplete", "expired", "limit"]);
const Refusal = Schema.Struct({ request: LibraryCapturePruneRequest, reason: RefusalReason });

export const LibraryPruneSweepResult = Schema.Struct({
  pages: RecoveryOrdinal,
  completed: RecoveryOrdinal,
  deferred: RecoveryOrdinal,
  blockedExpired: RecoveryOrdinal,
  refusals: Schema.Array(Refusal).check(Schema.isMaxLength(64)),
});

const Selected = Schema.Union([
  Schema.TaggedStruct("Ready", { request: LibraryCapturePruneRequest }),
  Schema.TaggedStruct("BlockedExpired", { request: LibraryCapturePruneRequest }),
]);

const Selection = Data.taggedEnum<typeof Selected.Type>();

const SelectedPage = Schema.Struct({
  items: Schema.Array(Selected).check(Schema.isMaxLength(64)),
  next: Schema.NullOr(RecoveryOperationId),
});

const Outcome = Schema.Union([
  Schema.TaggedStruct("Completed", {}),
  Schema.TaggedStruct("Deferred", { reason: RefusalReason }),
]);

const Result = Data.taggedEnum<typeof Outcome.Type>();
const activity = guardedActivities(Effect.void);
const unavailable = () => "PURGE_UNAVAILABLE";

/** Capture the ports once; the caller runs this exact Activity program inside Purge. */
const makeLibraryPruneSweep = Effect.gen(function* () {
  const control = yield* LibraryControl;
  const pruning = yield* LibraryCapturePruning;

  const run = Effect.fn("pruneLibraryCaptures")(function* () {
    let after: string | null = null;
    let pages = 0;
    let completed = 0;
    let deferred = 0;
    let blockedExpired = 0;
    const refusals: Array<typeof Refusal.Type> = [];

    while (true) {
      const cursor: string | null = after;

      // Persist the exact hashed requests before any reservation or remote read.
      const page: typeof SelectedPage.Type = yield* activity({
        name: cursor === null ? "library/candidates/initial" : `library/candidates/after/${cursor}`,
        success: SelectedPage,
        execute: Effect.gen(function* () {
          const candidates = yield* control
            .capturePruneCandidates({ after: cursor })
            .pipe(Effect.mapError(unavailable));

          const items: Array<typeof Selected.Type> = [];

          for (const candidate of candidates.items) {
            const request = yield* Match.value(candidate).pipe(
              Match.tag("New", ({ captureId, archiveId }) =>
                libraryImageDigest(
                  JSON.stringify(["library-capture-prune-v1", captureId, archiveId]),
                ).pipe(
                  Effect.mapError(unavailable),
                  Effect.map((digest) => ({
                    operationId: `prune-${digest}`,
                    captureId,
                    archiveId,
                  })),
                ),
              ),
              Match.orElse(({ operationId, captureId, archiveId }) =>
                Effect.succeed({ operationId, captureId, archiveId }),
              ),
            );

            items.push(
              Predicate.isTagged(candidate, "BlockedExpired")
                ? Selection.BlockedExpired({ request })
                : Selection.Ready({ request }),
            );
          }

          return { items, next: candidates.next };
        }),
      });

      pages += 1;

      for (const candidate of page.items) {
        if (Predicate.isTagged(candidate, "BlockedExpired")) {
          blockedExpired += 1;

          if (refusals.length < 64)
            refusals.push({ request: candidate.request, reason: "expired" });
          continue;
        }

        const outcome = yield* activity({
          name: `library/prune/${candidate.request.operationId}`,
          success: Outcome,
          execute: pruning.prune(candidate.request).pipe(
            Effect.as(Result.Completed()),
            Effect.catch((error) =>
              Match.value(error.reason).pipe(
                Match.whenOr("storage", "timeout", () => Effect.fail(unavailable())),
                Match.orElse((reason) => Effect.succeed(Result.Deferred({ reason }))),
              ),
            ),
          ),
        });

        if (Predicate.isTagged(outcome, "Deferred")) {
          deferred += 1;

          if (refusals.length < 64)
            refusals.push({ request: candidate.request, reason: outcome.reason });
        } else completed += 1;
      }

      if (page.next === null) break;

      if (cursor !== null && page.next <= cursor)
        return yield* Effect.fail("LIBRARY_PRUNE_INVALID_CURSOR");
      after = page.next;
    }

    return LibraryPruneSweepResult.make({ pages, completed, deferred, blockedExpired, refusals });
  });

  return { run };
});

export class LibraryPruneSweep extends Context.Service<
  LibraryPruneSweep,
  {
    readonly run: () => Effect.Effect<
      typeof LibraryPruneSweepResult.Type,
      string,
      WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
    >;
  }
>()("@kitties/gateway/LibraryPruneSweep") {
  static readonly layer = Layer.effect(LibraryPruneSweep, makeLibraryPruneSweep);
}
