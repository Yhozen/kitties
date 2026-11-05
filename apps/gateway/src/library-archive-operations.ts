import * as Data from "effect/Data";
import * as Match from "effect/Match";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { LibraryControl } from "./library-control.ts";
import {
  LibraryCaptureRequest,
  LibraryRecoveryCoordinator,
  LibraryRestoreParts,
} from "./library-recovery-coordinator.ts";
import {
  LibraryRecoveryError,
  LibraryRecoveryState,
  LibraryRestoreIntent,
  LibraryRestoreSource,
  RecoveryDigest,
  RecoveryOperationId,
} from "./library-recovery-records.ts";
import { LibraryRetainedArchive } from "./library-retained-archive.ts";
import {
  LibraryArchiveError,
  LibraryArchiveStatus,
  LibraryRetainedArchiveJournal,
} from "./library-retained-archive-store.ts";

export const LibraryRetainedRestoreRequest = Schema.Struct({
  operationId: RecoveryOperationId,
  archiveId: RecoveryOperationId,
  codeDigest: RecoveryDigest,
});

export type LibraryRetainedRestoreRequest = typeof LibraryRetainedRestoreRequest.Type;

const Source = Data.taggedEnum<LibraryRestoreSource>();
const sameIntent = Schema.toEquivalence(LibraryRestoreIntent);

const fromRecovery = (error: LibraryRecoveryError) =>
  new LibraryArchiveError({
    reason: Match.value(error.reason).pipe(
      Match.whenOr("storage", "incomplete", "invalid", (reason) => reason),
      Match.orElse((): "conflict" => "conflict"),
    ),
  });

/** Coordinates separate capture/upload lifetimes and keeps restore pins through publication. */
export class LibraryArchiveOperations extends Context.Service<
  LibraryArchiveOperations,
  {
    readonly export: (
      request: LibraryCaptureRequest,
    ) => Effect.Effect<LibraryArchiveStatus, LibraryArchiveError>;
    readonly restore: (
      request: LibraryRetainedRestoreRequest,
    ) => Effect.Effect<LibraryRecoveryState, LibraryArchiveError>;
  }
>()("@kitties/gateway/LibraryArchiveOperations") {
  static readonly layer = Layer.effect(
    LibraryArchiveOperations,
    Effect.gen(function* () {
      const coordinator = yield* LibraryRecoveryCoordinator;
      const control = yield* LibraryControl;
      const archive = yield* LibraryRetainedArchive;
      const journal = yield* LibraryRetainedArchiveJournal;

      return {
        export: Effect.fnUntraced(function* (input: LibraryCaptureRequest) {
          const request = yield* Schema.decodeUnknownEffect(LibraryCaptureRequest)(input).pipe(
            Effect.mapError(() => new LibraryArchiveError({ reason: "invalid" })),
          );

          const previous = yield* archive.status(request.operationId);

          if (previous !== null) {
            if (
              previous.header.grantId !== request.operationId ||
              previous.header.set.id !== request.operationId ||
              previous.header.set.codeDigest !== request.codeDigest
            )
              return yield* new LibraryArchiveError({ reason: "conflict" });

            if (previous.commit !== null) return previous;
          }

          yield* coordinator.capture(request).pipe(Effect.mapError(fromRecovery));
          yield* control
            .grantExport(request.operationId, request.operationId)
            .pipe(Effect.mapError(fromRecovery));

          // Capture is durably complete and traffic is open before the first R2 call.
          return yield* archive.upload({
            archiveId: request.operationId,
            grantId: request.operationId,
            captureId: request.operationId,
            codeDigest: request.codeDigest,
          });
        }),
        restore: Effect.fnUntraced(function* (input: LibraryRetainedRestoreRequest) {
          const request = yield* Schema.decodeUnknownEffect(LibraryRetainedRestoreRequest)(
            input,
          ).pipe(Effect.mapError(() => new LibraryArchiveError({ reason: "invalid" })));

          const status = yield* archive.status(request.archiveId);

          if (status === null || status.commit === null)
            return yield* new LibraryArchiveError({ reason: "incomplete" });

          if (status.header.set.codeDigest !== request.codeDigest)
            return yield* new LibraryArchiveError({ reason: "conflict" });

          const restore = {
            operationId: request.operationId,
            setId: status.header.set.id,
            codeDigest: request.codeDigest,
          };

          const identity = {
            archiveId: request.archiveId,
            manifestDigest: status.commit.receipt.plainSha256,
          };

          const recorded = yield* control
            .restoreIntent(request.operationId)
            .pipe(Effect.mapError(fromRecovery));

          const intent = LibraryRestoreIntent.make({
            setId: restore.setId,
            codeDigest: restore.codeDigest,
            source: Source.Retained(identity),
          });

          if (recorded !== null && !sameIntent(recorded, intent))
            return yield* new LibraryArchiveError({ reason: "conflict" });

          const published = yield* control
            .publication(restore.operationId, restore.setId, restore.codeDigest)
            .pipe(Effect.mapError(fromRecovery));

          if (published !== null) {
            if (recorded === null) return yield* new LibraryArchiveError({ reason: "conflict" });
            const pin = yield* journal.restorePin(request.operationId);

            if (pin?.archiveId !== request.archiveId)
              return yield* new LibraryArchiveError({ reason: "conflict" });
            yield* control
              .completePublication(request.operationId)
              .pipe(Effect.mapError(fromRecovery));
            yield* archive.finishRestore(request.operationId);

            return published;
          }

          if (status.expiresAt === null)
            return yield* new LibraryArchiveError({ reason: "incomplete" });

          if ((yield* Clock.currentTimeMillis) >= status.expiresAt)
            return yield* new LibraryArchiveError({ reason: "expired" });

          // Own the source before pin acquisition or the first retained read can fail.
          yield* control
            .beginRestore(request.operationId, intent)
            .pipe(Effect.mapError(fromRecovery));

          const source = yield* archive.retainedSource({
            archiveId: request.archiveId,
            restoreId: request.operationId,
            codeDigest: request.codeDigest,
          });

          const restored = yield* coordinator.restore(restore).pipe(
            Effect.provideService(LibraryRestoreParts, {
              identity,
              read: (part) =>
                source.read(part).pipe(
                  Effect.mapError(
                    (error) =>
                      new LibraryRecoveryError({
                        reason:
                          error.reason === "storage" || error.reason === "timeout"
                            ? "storage"
                            : "conflict",
                      }),
                  ),
                ),
            }),
            Effect.mapError(fromRecovery),
          );

          yield* archive.finishRestore(request.operationId);

          return restored;
        }),
      };
    }),
  );
}
