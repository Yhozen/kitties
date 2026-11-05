import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { LibraryControl } from "./library-control.ts";
import { LibraryObjectAdministration } from "./library-recovery-host.ts";
import { type LibraryAdminRequest } from "./library-object-admin.ts";
import { LibraryRecoveryError, RecoveryOperationId } from "./library-recovery-records.ts";
import { LibraryArchiveError } from "./library-retained-archive-store.ts";
import { LibraryRetainedArchive } from "./library-retained-archive.ts";
import {
  LibraryArchivePruneRequest,
  LibraryCapturePrunePlan,
} from "./library-capture-prune-records.ts";

export const LibraryCapturePruneRequest = Schema.Struct({
  operationId: RecoveryOperationId,
  captureId: RecoveryOperationId,
  archiveId: RecoveryOperationId,
});

export type LibraryCapturePruneRequest = typeof LibraryCapturePruneRequest.Type;

export const LibraryCapturePruningPolicy = Context.Reference<{
  readonly callMs: number;
  readonly totalMs: number;
}>("@kitties/gateway/LibraryCapturePruningPolicy", {
  defaultValue: () => ({ callMs: 5000, totalMs: 120000 }),
});

const Admin = Data.taggedEnum<LibraryAdminRequest>();
const unavailable = () => new LibraryArchiveError({ reason: "storage" });
const incomplete = () => new LibraryArchiveError({ reason: "incomplete" });

const fromRecovery = (error: LibraryRecoveryError) =>
  new LibraryArchiveError({
    reason: Match.value(error.reason).pipe(
      Match.whenOr("invalid", "storage", "incomplete", (reason) => reason),
      Match.orElse((): "conflict" => "conflict"),
    ),
  });

const sameRequest = (plan: LibraryCapturePrunePlan, request: LibraryCapturePruneRequest) =>
  plan.request.pruneId === request.operationId &&
  plan.request.captureId === request.captureId &&
  plan.request.archiveId === request.archiveId;

/** Permanent journal cursors own progress; deadlines never release a pending barrier. */
export class LibraryCapturePruning extends Context.Service<
  LibraryCapturePruning,
  {
    readonly prune: (
      request: LibraryCapturePruneRequest,
    ) => Effect.Effect<LibraryCapturePrunePlan, LibraryArchiveError>;
    readonly abandon: (
      request: LibraryCapturePruneRequest,
    ) => Effect.Effect<LibraryCapturePrunePlan, LibraryArchiveError>;
  }
>()("@kitties/gateway/LibraryCapturePruning") {
  static readonly layer = Layer.effect(
    LibraryCapturePruning,
    Effect.gen(function* () {
      const control = yield* LibraryControl;
      const archive = yield* LibraryRetainedArchive;
      const admin = yield* LibraryObjectAdministration;
      const policy = yield* LibraryCapturePruningPolicy;

      const read = <A>(effect: Effect.Effect<A, LibraryRecoveryError>) =>
        effect.pipe(
          Effect.mapError(fromRecovery),
          Effect.catchDefect(unavailable),
          Effect.timeoutOrElse({ duration: policy.callMs, orElse: unavailable }),
        );

      const decode = (input: LibraryCapturePruneRequest) =>
        Schema.decodeUnknownEffect(LibraryCapturePruneRequest, {
          onExcessProperty: "error",
        })(input).pipe(Effect.mapError(() => new LibraryArchiveError({ reason: "invalid" })));

      const prune = Effect.fnUntraced(
        function* (input: LibraryCapturePruneRequest) {
          const request = yield* decode(input);
          const previous = yield* read(control.capturePrune(request.operationId));

          if (previous !== null && !sameRequest(previous, request))
            return yield* new LibraryArchiveError({ reason: "conflict" });

          if (previous?.phase === "complete") {
            yield* archive.finishPrune(request.operationId);

            return previous;
          }

          if (previous?.phase === "stopping" || previous?.phase === "abandoned")
            return yield* new LibraryArchiveError({ reason: "conflict" });

          const status = yield* archive.status(request.archiveId);

          if (status === null || status.commit === null) return yield* incomplete();

          if (status.header.set.id !== request.captureId)
            return yield* new LibraryArchiveError({ reason: "conflict" });

          const selected = LibraryArchivePruneRequest.make({
            pruneId: request.operationId,
            archiveId: request.archiveId,
            captureId: request.captureId,
            codeDigest: status.header.set.codeDigest,
            manifestDigest: status.commit.receipt.plainSha256,
          });

          let sequence = -1;

          while (true) {
            const verified = yield* archive.verifyPrune(selected);

            if (verified.phase === "verified" || verified.phase === "complete") break;

            if (verified.phase !== "verifying" || verified.sequence <= sequence)
              return yield* incomplete();
            sequence = verified.sequence;
          }

          yield* read(control.beginCapturePrune(request.operationId));

          while (true) {
            const pending = yield* read(control.capturePruneInventory(request.operationId, 0));

            if (pending.length === 0) break;

            for (const source of pending) {
              while (true) {
                const reply = yield* read(
                  admin.call(
                    source,
                    Admin.PruneCaptureStep({
                      pruneId: request.operationId,
                      captureId: request.captureId,
                    }),
                  ),
                );

                if (Predicate.isTagged(reply, "Rejected"))
                  return yield* new LibraryArchiveError({
                    reason: reply.reason === "storage" ? "storage" : "conflict",
                  });

                if (!Predicate.isTagged(reply, "PruneProgress")) return yield* incomplete();

                if (reply.value.done) {
                  if (reply.value.receipt === null) return yield* incomplete();
                  yield* read(
                    control.acknowledgeCapturePrune(request.operationId, reply.value.receipt),
                  );
                  break;
                }
              }
            }
          }

          yield* read(control.completeCapturePrune(request.operationId));
          yield* archive.finishPrune(request.operationId);
          const completed = yield* read(control.capturePrune(request.operationId));

          if (completed?.phase !== "complete") return yield* incomplete();

          return completed;
        },
        Effect.timeoutOrElse({
          duration: policy.totalMs,
          orElse: () => new LibraryArchiveError({ reason: "timeout" }),
        }),
      );

      const abandon = Effect.fnUntraced(
        function* (input: LibraryCapturePruneRequest) {
          const request = yield* decode(input);
          const previous = yield* read(control.capturePrune(request.operationId));

          if (previous === null || !sameRequest(previous, request))
            return yield* new LibraryArchiveError({ reason: "conflict" });

          if (previous.phase === "abandoned") {
            yield* archive.finishAbandon(request.operationId);

            return previous;
          }

          yield* read(control.beginAbandonCapturePrune(request.operationId));

          while (true) {
            const pending = yield* read(control.capturePruneStopInventory(request.operationId, 0));

            if (pending.length === 0) break;

            for (const source of pending) {
              const reply = yield* read(
                admin.call(
                  source,
                  Admin.StopPrune({
                    pruneId: request.operationId,
                    captureId: request.captureId,
                  }),
                ),
              );

              if (Predicate.isTagged(reply, "Rejected"))
                return yield* new LibraryArchiveError({
                  reason: reply.reason === "storage" ? "storage" : "conflict",
                });

              if (!Predicate.isTagged(reply, "PruneStopped")) return yield* incomplete();
              yield* read(control.acknowledgeCapturePruneStopped(request.operationId, reply.value));
            }
          }

          yield* read(control.completeAbandonCapturePrune(request.operationId));
          yield* archive.finishAbandon(request.operationId);
          const completed = yield* read(control.capturePrune(request.operationId));

          if (completed?.phase !== "abandoned") return yield* incomplete();

          return completed;
        },
        Effect.timeoutOrElse({
          duration: policy.totalMs,
          orElse: () => new LibraryArchiveError({ reason: "timeout" }),
        }),
      );

      return { prune, abandon };
    }),
  );
}
