import * as Data from "effect/Data";
import * as Predicate from "effect/Predicate";
import * as Option from "effect/Option";
import { Library } from "@kitties/domain/Library/Library.aggregate";
import { AdvanceLibraryAllocatorFloor } from "@kitties/domain/Library/AdvanceLibraryAllocatorFloor.command";
import { LibraryRecoveryActor } from "@kitties/domain/Library/LibraryRecoveryActor.context";
import { FinalizedImport } from "@kitties/domain/Library/Library.state";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { LibraryControl } from "./library-control.ts";
import { LibraryObjectAdministration, withLibraryRecoveryPin } from "./library-recovery-host.ts";
import { LibraryImagePart, type LibraryAdminRequest } from "./library-object-admin.ts";
import {
  LibraryObjectRef,
  LibraryObjectImage,
  LibraryRecoverySet,
  LibraryRecoveryError,
  LibraryRecoveryState,
  LibraryRestoreIntent,
  LibraryRestoreSource,
  RecoveryDigest,
  RecoveryOperationId,
  RegisteredLibraryObject,
} from "./library-recovery-records.ts";
import { LIBRARY_OWNER } from "./library-session.ts";

export const LibraryCaptureRequest = Schema.Struct({
  operationId: RecoveryOperationId,
  codeDigest: RecoveryDigest,
});

export type LibraryCaptureRequest = typeof LibraryCaptureRequest.Type;

/** Server-only retained source. Providing it replaces native reads for the entire restore. */
export class LibraryRestoreParts extends Context.Service<
  LibraryRestoreParts,
  {
    readonly identity: { readonly archiveId: string; readonly manifestDigest: string };
    readonly read: (request: {
      readonly operationId: string;
      readonly captureId: string;
      readonly source: RegisteredLibraryObject;
      readonly image: LibraryObjectImage;
      readonly row: number;
      readonly part: number;
    }) => Effect.Effect<LibraryImagePart, LibraryRecoveryError>;
  }
>()("@kitties/gateway/LibraryRestoreParts") {}

export const LibraryRestoreRequest = Schema.Struct({
  operationId: RecoveryOperationId,
  setId: RecoveryOperationId,
  codeDigest: RecoveryDigest,
});

export type LibraryRestoreRequest = typeof LibraryRestoreRequest.Type;

export const LibraryRecoveryPolicy = Context.Reference<{
  readonly callMs: number;
  readonly totalMs: number;
}>("@kitties/gateway/LibraryRecoveryPolicy", {
  defaultValue: () => ({ callMs: 5000, totalMs: 120000 }),
});

const Admin = Data.taggedEnum<LibraryAdminRequest>();
const Source = Data.taggedEnum<LibraryRestoreSource>();
const sameIntent = Schema.toEquivalence(LibraryRestoreIntent);

const unavailable = () => new LibraryRecoveryError({ reason: "storage" });
const incomplete = () => new LibraryRecoveryError({ reason: "incomplete" });

/** Repeating the same request resumes journaled work; timeouts never reopen traffic. */
export class LibraryRecoveryCoordinator extends Context.Service<
  LibraryRecoveryCoordinator,
  {
    readonly capture: (
      request: LibraryCaptureRequest,
    ) => Effect.Effect<LibraryRecoverySet, LibraryRecoveryError>;
    readonly restore: (
      request: LibraryRestoreRequest,
    ) => Effect.Effect<LibraryRecoveryState, LibraryRecoveryError>;
  }
>()("@kitties/gateway/LibraryRecoveryCoordinator") {
  static readonly layer = Layer.effect(
    LibraryRecoveryCoordinator,
    Effect.gen(function* () {
      const control = yield* LibraryControl;
      const admin = yield* LibraryObjectAdministration;
      const libraries = yield* Library;
      const policy = yield* LibraryRecoveryPolicy;

      const call = (ref: LibraryObjectRef, request: LibraryAdminRequest) =>
        admin.call(ref, request).pipe(
          Effect.catchDefect(unavailable),
          Effect.timeoutOrElse({ duration: policy.callMs, orElse: unavailable }),
          Effect.flatMap((reply) =>
            Predicate.isTagged(reply, "Rejected")
              ? Effect.fail(
                  new LibraryRecoveryError({
                    reason: reply.reason === "storage" ? "storage" : "fenced",
                  }),
                )
              : Effect.succeed(reply),
          ),
        );

      const status = Effect.fnUntraced(function* (
        ref: LibraryObjectRef,
        request: LibraryAdminRequest,
      ) {
        const reply = yield* call(ref, request);

        if (!Predicate.isTagged(reply, "Status")) return yield* incomplete();

        return reply.value;
      });

      const eachObject = Effect.fnUntraced(function* <E, R>(
        lineage: string,
        visit: (object: RegisteredLibraryObject) => Effect.Effect<void, E, R>,
      ) {
        let after = 0;

        while (true) {
          const page = yield* control.inventory(lineage, after);

          if (page.length === 0) return;

          for (const object of page) {
            if (object.ordinal <= after || object.lineage !== lineage) return yield* incomplete();
            yield* visit(object);
            after = object.ordinal;
          }
        }
      });

      const captureFrozen = Effect.fnUntraced(function* (
        state: LibraryRecoveryState,
        operationId: string,
        codeDigest: string,
      ) {
        // Close and evict every known writer before reading any object's image.
        yield* eachObject(state.lineage, (object) =>
          Effect.gen(function* () {
            const progress = yield* control.progress(operationId, object.ordinal);

            if (progress.frozen?.after !== null && progress.frozen?.after !== undefined) return;
            const frozen = yield* status(object, Admin.Freeze({ operationId }));

            if (frozen.before === null) return yield* incomplete();
            yield* control.acknowledgeFreeze(operationId, object.ordinal, frozen.before, null);
            // abort may lose its own RPC acknowledgement. The fresh-constructor
            // proof, rather than the transport outcome, establishes completion.
            yield* call(object, Admin.Evict({ operationId })).pipe(Effect.exit);

            const verified = yield* status(
              object,
              Admin.VerifyFrozen({ operationId, before: frozen.before }),
            );

            yield* control.acknowledgeFreeze(
              operationId,
              object.ordinal,
              frozen.before,
              verified.nonce,
            );
          }),
        );

        let floor: number | undefined;
        yield* eachObject(state.lineage, (object) =>
          Effect.gen(function* () {
            if (
              object.className === "LibraryModel.LibraryAggregate" &&
              object.logicalName === "owner"
            ) {
              const reply = yield* call(object, Admin.ReadAllocatorFloor({ operationId }));

              if (!Predicate.isTagged(reply, "AllocatorFloor")) return yield* incomplete();
              floor = reply.value;
            }

            if ((yield* control.image(operationId, object.ordinal)) !== null) return;

            while (true) {
              const reply = yield* call(object, Admin.CaptureStep({ operationId }));

              if (!Predicate.isTagged(reply, "Progress")) return yield* incomplete();

              if (reply.value.done) {
                if (reply.value.image === null) return yield* incomplete();
                yield* control.recordImage(operationId, object.ordinal, reply.value.image);

                return;
              }
            }
          }),
        );

        if (floor === undefined) return yield* incomplete();

        return yield* control.seal(operationId, floor, codeDigest);
      });

      const eachCaptured = Effect.fnUntraced(function* <E, R>(
        captureId: string,
        visit: (object: RegisteredLibraryObject) => Effect.Effect<void, E, R>,
      ) {
        let after = 0;

        while (true) {
          const page = yield* control.captureInventory(captureId, after);

          if (page.length === 0) return;

          for (const object of page) {
            if (object.ordinal <= after) return yield* incomplete();
            yield* visit(object);
            after = object.ordinal;
          }
        }
      });

      const capture = Effect.fnUntraced(
        function* (unverified: LibraryCaptureRequest) {
          const { operationId, codeDigest } = yield* Schema.decodeUnknownEffect(
            LibraryCaptureRequest,
          )(unverified).pipe(
            Effect.mapError(() => new LibraryRecoveryError({ reason: "invalid" })),
          );

          const completed = yield* control.captureCompletion(operationId);

          if (completed === null) {
            const state = yield* control.beginCapture(operationId, codeDigest);

            if (state.phase === "frozen") yield* captureFrozen(state, operationId, codeDigest);
          }

          const captured = yield* control.recoverySet(operationId);

          if (captured === null || captured.codeDigest !== codeDigest)
            return yield* new LibraryRecoveryError({ reason: "conflict" });

          if (completed !== null) return captured;
          yield* control.beginCaptureResume(operationId);
          yield* eachCaptured(operationId, (object) =>
            Effect.gen(function* () {
              const progress = yield* control.resumeProgress(operationId, object.ordinal);

              if (progress?.after != null) return;
              const resumed = yield* status(object, Admin.ResumeCapture({ operationId }));

              if (resumed.resuming === null) return yield* incomplete();
              yield* control.acknowledgeResumed(
                operationId,
                object.ordinal,
                resumed.resuming,
                null,
              );

              if (!resumed.initialized || resumed.nonce === resumed.resuming)
                yield* call(object, Admin.Evict({ operationId })).pipe(Effect.exit);

              const verified = yield* status(
                object,
                Admin.VerifyResumed({ operationId, before: resumed.resuming }),
              );

              yield* control.acknowledgeResumed(
                operationId,
                object.ordinal,
                resumed.resuming,
                verified.nonce,
              );
            }),
          );
          yield* control.completeCapture(operationId);

          return captured;
        },
        Effect.timeoutOrElse({ duration: policy.totalMs, orElse: unavailable }),
      );

      const restore = Effect.fnUntraced(
        function* (unverified: LibraryRestoreRequest) {
          const request = yield* Schema.decodeUnknownEffect(LibraryRestoreRequest)(unverified).pipe(
            Effect.mapError(() => new LibraryRecoveryError({ reason: "invalid" })),
          );

          const { operationId, setId, codeDigest } = request;
          const partsSource = yield* Effect.serviceOption(LibraryRestoreParts);

          const intent = yield* Schema.decodeUnknownEffect(LibraryRestoreIntent)({
            setId,
            codeDigest,
            source: Option.isSome(partsSource)
              ? Source.Retained(partsSource.value.identity)
              : Source.Native(),
          }).pipe(Effect.mapError(() => new LibraryRecoveryError({ reason: "invalid" })));

          const recorded = yield* control.restoreIntent(operationId);

          if (recorded !== null && !sameIntent(recorded, intent))
            return yield* new LibraryRecoveryError({ reason: "conflict" });
          const published = yield* control.publication(operationId, setId, codeDigest);

          if (published !== null) {
            if (recorded === null) return yield* new LibraryRecoveryError({ reason: "conflict" });
            yield* control.completePublication(operationId);

            return published;
          }

          if (setId !== operationId) {
            const selected = yield* control.recoverySet(setId);

            if (selected === null || selected.codeDigest !== codeDigest)
              return yield* new LibraryRecoveryError({ reason: "conflict" });
          }

          let state = yield* control.beginRestore(operationId, intent);

          if (state.phase === "frozen") yield* captureFrozen(state, operationId, codeDigest);

          const selected = yield* control.recoverySet(setId);

          if (selected === null || selected.codeDigest !== codeDigest)
            return yield* new LibraryRecoveryError({ reason: "conflict" });
          state = yield* control.prepareRestore(operationId, setId);
          const destinationLineage = state.stagingLineage;

          if (destinationLineage === null) return yield* incomplete();

          if (state.phase === "staging") {
            yield* eachCaptured(setId, (source) =>
              Effect.gen(function* () {
                if ((yield* control.progress(operationId, source.ordinal)).loaded !== null) return;
                const image = yield* control.authorizeCapture(operationId, setId, source.ordinal);

                const destination = yield* admin.derive(
                  source.className,
                  destinationLineage,
                  source.logicalName,
                );

                const ordinal = yield* control.register(destination, operationId);
                yield* call(destination, Admin.BeginLoad({ operationId, image }));

                for (let row = 1; row <= image.kvCount + image.sqlCount + 1; row++) {
                  let parts = 1;

                  for (let part = 0; part < parts; part++) {
                    const value = yield* (
                      Option.isSome(partsSource)
                        ? partsSource.value.read({
                            operationId,
                            captureId: setId,
                            source,
                            image,
                            row,
                            part,
                          })
                        : call(
                            source,
                            Admin.ReadPart({ operationId, captureId: setId, row, part }),
                          ).pipe(
                            Effect.flatMap((reply) =>
                              Predicate.isTagged(reply, "Part")
                                ? Effect.succeed(reply.value)
                                : incomplete(),
                            ),
                          )
                    ).pipe(
                      Effect.catchDefect(unavailable),
                      Effect.timeoutOrElse({ duration: policy.callMs, orElse: unavailable }),
                      Effect.flatMap((value) =>
                        Schema.decodeUnknownEffect(LibraryImagePart)(value).pipe(
                          Effect.mapError(() => new LibraryRecoveryError({ reason: "incomplete" })),
                        ),
                      ),
                    );

                    if (value.row !== row || value.part !== part) return yield* incomplete();
                    parts = value.parts;
                    yield* call(destination, Admin.LoadPart({ operationId, value }));
                  }
                }

                while (true) {
                  const verified = yield* call(
                    destination,
                    Admin.VerifyImage({ operationId, image }),
                  );

                  if (!Predicate.isTagged(verified, "Progress")) return yield* incomplete();

                  if (verified.value.done) break;
                }

                yield* control.recordLoaded(operationId, source.ordinal, ordinal, image);
              }),
            );
          }

          state = yield* control.beginActivation(operationId);
          yield* eachCaptured(setId, (source) =>
            Effect.gen(function* () {
              const progress = yield* control.progress(operationId, source.ordinal);

              if (progress.loaded === null) return yield* incomplete();

              if (progress.loaded.active === 1) return;

              const destination = yield* admin.derive(
                source.className,
                destinationLineage,
                source.logicalName,
              );

              const active = yield* status(destination, Admin.Activate({ operationId }));

              if (active.activating === null) return yield* incomplete();

              if (!active.initialized || active.nonce === active.activating)
                yield* call(destination, Admin.Evict({ operationId })).pipe(Effect.exit);
              yield* status(
                destination,
                Admin.VerifyActive({ operationId, before: active.activating }),
              );
              yield* control.acknowledgeActive(operationId, progress.loaded.destination_ordinal);
            }),
          );

          const verifiedFloor = yield* withLibraryRecoveryPin(
            Effect.gen(function* () {
              // Namespace registration and object invocation recheck operation authority
              // before this private command can retrieve a cached receipt.
              yield* libraries
                .send(
                  LIBRARY_OWNER,
                  new AdvanceLibraryAllocatorFloor({ floor: state.allocatorFloor }),
                  {
                    commandId: `library-recovery:${operationId}:allocator`,
                  },
                )
                .pipe(
                  Effect.provideService(LibraryRecoveryActor, { libraryId: LIBRARY_OWNER }),
                  Effect.mapError(() => new LibraryRecoveryError({ reason: "conflict" })),
                );
              const aggregate = yield* libraries.state(LIBRARY_OWNER);

              if (
                !Schema.is(FinalizedImport)(aggregate.importProgress) ||
                aggregate.highWater < state.allocatorFloor
              )
                return yield* incomplete();

              return aggregate.highWater;
            }),
            { lineage: destinationLineage, operationId },
          ).pipe(
            Effect.catchDefect(unavailable),
            Effect.timeoutOrElse({ duration: policy.callMs, orElse: unavailable }),
          );

          const result = yield* control.publish(operationId, verifiedFloor);
          yield* control.completePublication(operationId);

          return result;
        },
        Effect.timeoutOrElse({ duration: policy.totalMs, orElse: unavailable }),
      );

      return { capture, restore };
    }),
  );
}
