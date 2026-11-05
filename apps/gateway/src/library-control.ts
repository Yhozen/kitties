import { decodeLibraryControlReply } from "./library-control-wire.ts";
import {
  LibraryCapturePruneCandidatesPage,
  LibraryCapturePrunePlan,
  LibraryCapturePruneCompletion,
  LibraryCapturePruneReceipt,
  LibraryCapturePruneAuthorization,
  LibraryCapturePruneStopAuthorization,
  LibraryCapturePruneStopReceipt,
  LibraryCapturePruneAbandonment,
} from "./library-capture-prune-records.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { RecoveryDO } from "./recovery-store.ts";
import type { LibraryRecoveryStore } from "./library-recovery-store.ts";
import {
  LibraryExportAuthorization,
  LibraryLineage,
  LibraryObjectImage,
  LibraryRecoveryError,
  LibraryRecoverySet,
  LibraryRecoveryState,
  LibraryRestoreIntent,
  RecoveryOperationId,
  RecoveryOrdinal,
  RegisteredLibraryObject,
} from "./library-recovery-records.ts";
import { LibraryRecoveryControl } from "./library-recovery-host.ts";
import { LibraryMigrationControl } from "./library-legacy-store.ts";
import {
  LIBRARY_OWNER,
  LibraryAdmission,
  LibraryAdmissionDenied,
  LibraryAdmissionUnavailable,
  LibraryEpoch,
  LibraryEpochSource,
  LibraryScope,
} from "./library-session.ts";

export const LibraryControlPolicy = Context.Reference<{ readonly timeoutMs: number }>(
  "@kitties/gateway/LibraryControlPolicy",
  { defaultValue: () => ({ timeoutMs: 5000 }) },
);

const Progress = Schema.Struct({
  frozen: Schema.NullOr(
    Schema.Struct({ before: RecoveryOperationId, after: Schema.NullOr(RecoveryOperationId) }),
  ),
  loaded: Schema.NullOr(
    Schema.Struct({ destination_ordinal: RecoveryOrdinal, active: Schema.Literals([0, 1]) }),
  ),
});

const Admission = Schema.Struct({
  libraryId: Schema.Literal("owner"),
  epoch: LibraryEpoch,
  lineage: LibraryLineage,
});

const storageError = () => new LibraryRecoveryError({ reason: "storage" });

/** The permanent recovery journal is the sole authority; this client caches no permits. */
export class LibraryControl extends Context.Service<
  LibraryControl,
  Omit<LibraryRecoveryStore["Service"], "setup"> & {
    readonly complete: (operationId: string) => Effect.Effect<void, LibraryRecoveryError>;
    readonly completePublication: (
      operationId: string,
    ) => Effect.Effect<void, LibraryRecoveryError>;
  }
>()("@kitties/gateway/LibraryControl") {
  static readonly layer = Layer.effect(
    LibraryControl,
    Effect.gen(function* () {
      const roots = yield* RecoveryDO;
      const policy = yield* LibraryControlPolicy;
      const root = () => roots.getByName("control", { locationHint: "weur" });

      const call = <S extends Schema.ConstraintDecoder<unknown>, E, R>(
        schema: S,
        effect: () => Effect.Effect<unknown, E, R>,
      ) =>
        Effect.suspend(effect).pipe(
          Effect.mapError((error) =>
            Schema.is(LibraryRecoveryError)(error) ? error : storageError(),
          ),
          Effect.flatMap((value) => decodeLibraryControlReply(schema)(value)),
          Effect.catchDefect(storageError),
          Effect.timeoutOrElse({ duration: policy.timeoutMs, orElse: storageError }),
        );

      return LibraryControl.of({
        capturePruneCandidates: (request) =>
          call(LibraryCapturePruneCandidatesPage, () =>
            root().libraryCapturePruneCandidates(request),
          ),
        beginAbandonCapturePrune: (id) =>
          call(LibraryCapturePrunePlan, () => root().libraryBeginAbandonCapturePrune(id)),
        capturePruneStopInventory: (id, after) =>
          call(Schema.mutable(Schema.Array(RegisteredLibraryObject)), () =>
            root().libraryCapturePruneStopInventory(id, after),
          ),
        authorizeCapturePruneStop: (id, ordinal) =>
          call(LibraryCapturePruneStopAuthorization, () =>
            root().libraryAuthorizeCapturePruneStop(id, ordinal),
          ),
        acknowledgeCapturePruneStopped: (id, receipt) =>
          call(LibraryCapturePruneStopReceipt, () =>
            root().libraryAcknowledgeCapturePruneStopped(id, receipt),
          ),
        completeAbandonCapturePrune: (id) =>
          call(LibraryCapturePruneAbandonment, () => root().libraryCompleteAbandonCapturePrune(id)),
        capturePrune: (id) =>
          call(Schema.NullOr(LibraryCapturePrunePlan), () => root().libraryCapturePrune(id)),
        beginCapturePrune: (id) =>
          call(LibraryCapturePrunePlan, () => root().libraryBeginCapturePrune(id)),
        capturePruneInventory: (id, after) =>
          call(Schema.mutable(Schema.Array(RegisteredLibraryObject)), () =>
            root().libraryCapturePruneInventory(id, after),
          ),
        authorizeCapturePrune: (id, ordinal) =>
          call(LibraryCapturePruneAuthorization, () =>
            root().libraryAuthorizeCapturePrune(id, ordinal),
          ),
        acknowledgeCapturePrune: (id, receipt) =>
          call(LibraryCapturePruneReceipt, () =>
            root().libraryAcknowledgeCapturePrune(id, receipt),
          ),
        completeCapturePrune: (id) =>
          call(LibraryCapturePruneCompletion, () => root().libraryCompleteCapturePrune(id)),
        status: call(Schema.NullOr(LibraryRecoveryState), () => root().libraryStatus()),
        initialize: (id) => call(LibraryRecoveryState, () => root().libraryInitialize(id)),
        finishImport: (id, floor) =>
          call(LibraryRecoveryState, () => root().libraryFinishImport(id, floor)),
        admit: (epoch) => call(Admission, () => root().libraryAdmit(epoch)),
        resolve: (epoch) => call(LibraryLineage, () => root().libraryResolve(epoch)),
        register: (ref, operationId) =>
          call(RecoveryOrdinal, () => root().libraryRegister(ref, operationId)),
        lookup: (className, nativeId) =>
          call(Schema.NullOr(RegisteredLibraryObject), () =>
            root().libraryLookup(className, nativeId),
          ),
        inventory: (lineage, after) =>
          call(Schema.mutable(Schema.Array(RegisteredLibraryObject)), () =>
            root().libraryInventory(lineage, after),
          ),
        recoverySet: (id) =>
          call(Schema.NullOr(LibraryRecoverySet), () => root().libraryRecoverySet(id)),
        publication: (id, setId, codeDigest) =>
          call(Schema.NullOr(LibraryRecoveryState), () =>
            root().libraryPublication(id, setId, codeDigest),
          ),
        image: (id, ordinal) =>
          call(Schema.NullOr(LibraryObjectImage), () => root().libraryImage(id, ordinal)),
        authorizeCapture: (operationId, captureId, ordinal) =>
          call(LibraryObjectImage, () =>
            root().libraryAuthorizeCapture(operationId, captureId, ordinal),
          ),
        progress: (id, ordinal) => call(Progress, () => root().libraryProgress(id, ordinal)),
        captureInventory: (id, after) =>
          call(Schema.mutable(Schema.Array(RegisteredLibraryObject)), () =>
            root().libraryCaptureInventory(id, after),
          ),
        beginCapture: (id, digest) =>
          call(LibraryRecoveryState, () => root().libraryBeginCapture(id, digest)),
        beginCaptureResume: (id) =>
          call(LibraryRecoveryState, () => root().libraryBeginCaptureResume(id)),
        acknowledgeResumed: (id, ordinal, before, after) =>
          call(Schema.Undefined, () =>
            root().libraryAcknowledgeResumed(id, ordinal, before, after),
          ),
        resumeProgress: (id, ordinal) =>
          call(Progress.fields.frozen, () => root().libraryResumeProgress(id, ordinal)),
        completeCapture: (id) =>
          call(LibraryRecoveryState, () => root().libraryCompleteCapture(id)),
        captureCompletion: (id) =>
          call(Schema.NullOr(LibraryRecoveryState), () => root().libraryCaptureCompletion(id)),
        grantExport: (grantId, captureId) =>
          call(LibraryRecoverySet, () => root().libraryGrantExport(grantId, captureId)),
        authorizeExport: (grantId, captureId, ordinal) =>
          call(LibraryExportAuthorization, () =>
            root().libraryAuthorizeExport(grantId, captureId, ordinal),
          ),
        restoreIntent: (id) =>
          call(Schema.NullOr(LibraryRestoreIntent), () => root().libraryRestoreIntent(id)),
        beginRestore: (id, intent) =>
          call(LibraryRecoveryState, () => root().libraryBeginRestore(id, intent)),
        beginFreeze: (id) => call(LibraryRecoveryState, () => root().libraryBeginFreeze(id)),
        acknowledgeFreeze: (id, ordinal, before, after) =>
          call(Schema.Undefined, () => root().libraryAcknowledgeFreeze(id, ordinal, before, after)),
        recordImage: (id, ordinal, image) =>
          call(Schema.Undefined, () => root().libraryRecordImage(id, ordinal, image)),
        seal: (id, floor, digest) =>
          call(LibraryRecoverySet, () => root().librarySeal(id, floor, digest)),
        prepareRestore: (id, setId) =>
          call(LibraryRecoveryState, () => root().libraryPrepareRestore(id, setId)),
        recordLoaded: (id, source, destination, image) =>
          call(Schema.Undefined, () => root().libraryRecordLoaded(id, source, destination, image)),
        beginActivation: (id) =>
          call(LibraryRecoveryState, () => root().libraryBeginActivation(id)),
        acknowledgeActive: (id, ordinal) =>
          call(Schema.Undefined, () => root().libraryAcknowledgeActive(id, ordinal)),
        publish: (id, floor) => call(LibraryRecoveryState, () => root().libraryPublish(id, floor)),
        complete: (id) =>
          call(Schema.Unknown, () => root().libraryComplete(id)).pipe(Effect.asVoid),
        completePublication: (id) =>
          call(Schema.Undefined, () => root().libraryCompletePublication(id)),
      });
    }),
  );
}

const admissionError = (error: LibraryRecoveryError) =>
  error.reason === "storage" ? new LibraryAdmissionUnavailable() : new LibraryAdmissionDenied();

export const LibraryControlAdapters = Layer.effectContext(
  Effect.gen(function* () {
    const control = yield* LibraryControl;

    const check = Effect.fnUntraced(function* (scope: LibraryScope) {
      if (!Schema.is(LibraryScope)(scope) || scope.libraryId !== LIBRARY_OWNER)
        return yield* new LibraryAdmissionDenied();

      const result = yield* control.admit(scope.epoch).pipe(Effect.mapError(admissionError));

      if (result.libraryId !== scope.libraryId || result.epoch !== scope.epoch)
        return yield* new LibraryAdmissionDenied();
    });

    return Context.make(LibraryRecoveryControl, {
      status: control.status,
      resolve: control.resolve,
      register: (ref, operationId) => control.register(ref, operationId),
      lookup: control.lookup,
      authorizeCapture: control.authorizeCapture,
      authorizeExport: control.authorizeExport,
      authorizePrune: control.authorizeCapturePrune,
      authorizePruneStop: control.authorizeCapturePruneStop,
    }).pipe(
      Context.add(LibraryMigrationControl, {
        status: control.status,
        initialize: control.initialize,
        finishImport: control.finishImport,
      }),
      Context.add(LibraryAdmission, { check }),
      Context.add(LibraryEpochSource, {
        current: Effect.fnUntraced(function* (libraryId) {
          if (libraryId !== LIBRARY_OWNER) return yield* new LibraryAdmissionDenied();
          const state = yield* control.status.pipe(Effect.mapError(admissionError));

          if (state === null || state.phase !== "ready") return yield* new LibraryAdmissionDenied();
          yield* check({ libraryId, epoch: state.epoch });

          return state.epoch;
        }),
      }),
    );
  }),
);
