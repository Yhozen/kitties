import * as Schema from "effect/Schema";
import {
  LibraryObjectImage,
  LibraryObjectRef,
  RecoveryDigest,
  RecoveryOperationId,
  RecoveryOrdinal,
} from "./library-recovery-records.ts";

export const LIBRARY_CAPTURE_PRUNE_MIN_AGE_MS = 30 * 86400000;
export const LIBRARY_CAPTURE_PRUNE_BATCH_SIZE = 64;

export const LibraryCapturePruneCandidatesRequest = Schema.Struct({
  after: Schema.NullOr(RecoveryOperationId),
});

export type LibraryCapturePruneCandidatesRequest = typeof LibraryCapturePruneCandidatesRequest.Type;

/** Advisory selection only; pending work always retains its original identity. */
export const LibraryCapturePruneCandidate = Schema.Union([
  Schema.TaggedStruct("New", {
    captureId: RecoveryOperationId,
    archiveId: RecoveryOperationId,
  }),
  Schema.TaggedStruct("Resume", {
    operationId: RecoveryOperationId,
    captureId: RecoveryOperationId,
    archiveId: RecoveryOperationId,
  }),
  Schema.TaggedStruct("BlockedExpired", {
    operationId: RecoveryOperationId,
    captureId: RecoveryOperationId,
    archiveId: RecoveryOperationId,
  }),
]);

export type LibraryCapturePruneCandidate = typeof LibraryCapturePruneCandidate.Type;

export const LibraryCapturePruneCandidatesPage = Schema.Struct({
  items: Schema.Array(LibraryCapturePruneCandidate).check(
    Schema.isMaxLength(LIBRARY_CAPTURE_PRUNE_BATCH_SIZE),
  ),
  next: Schema.NullOr(RecoveryOperationId),
});

export type LibraryCapturePruneCandidatesPage = typeof LibraryCapturePruneCandidatesPage.Type;

export const LibraryArchivePruneRequest = Schema.Struct({
  pruneId: RecoveryOperationId,
  archiveId: RecoveryOperationId,
  captureId: RecoveryOperationId,
  codeDigest: RecoveryDigest,
  manifestDigest: RecoveryDigest,
});

export type LibraryArchivePruneRequest = typeof LibraryArchivePruneRequest.Type;

export const LibraryCapturePrunePlan = Schema.Struct({
  request: LibraryArchivePruneRequest,
  phase: Schema.Literals(["reserved", "deleting", "complete", "stopping", "abandoned"]),
  reservedAt: RecoveryOrdinal,
  expiresAt: RecoveryOrdinal,
  capturedAt: RecoveryOrdinal,
  objectCount: RecoveryOrdinal,
  /** Absent on pre-abandonment records; immutable when stopping starts. */
  stoppingAt: Schema.optionalKey(RecoveryOrdinal),
});

export type LibraryCapturePrunePlan = typeof LibraryCapturePrunePlan.Type;

/** Retained journal extends this record with its monotonic verification cursor. */
export const LibraryCapturePruneVerification = Schema.Struct({
  request: LibraryArchivePruneRequest,
  phase: Schema.Literals(["verifying", "verified", "complete", "abandoned"]),
  reservedAt: RecoveryOrdinal,
  expiresAt: RecoveryOrdinal,
  verifiedAt: Schema.NullOr(RecoveryOrdinal),
});

export type LibraryCapturePruneVerification = typeof LibraryCapturePruneVerification.Type;

export const LibraryCapturePruneCompletion = Schema.Struct({
  request: LibraryArchivePruneRequest,
  objectCount: RecoveryOrdinal,
  completedAt: RecoveryOrdinal,
});

export type LibraryCapturePruneCompletion = typeof LibraryCapturePruneCompletion.Type;

/** Expired cleanup was stopped; this does not assert backup/deletion success. */
export const LibraryCapturePruneAbandonment = Schema.Struct({
  request: LibraryArchivePruneRequest,
  objectCount: RecoveryOrdinal,
  abandonedAt: RecoveryOrdinal,
});

export type LibraryCapturePruneAbandonment = typeof LibraryCapturePruneAbandonment.Type;

/** Exact sealed member; never an authority to mutate a live Domain object. */
export const LibraryCapturePruneAuthorization = Schema.Struct({
  request: LibraryArchivePruneRequest,
  ordinal: RecoveryOrdinal,
  source: LibraryObjectRef,
  image: LibraryObjectImage,
});

export type LibraryCapturePruneAuthorization = typeof LibraryCapturePruneAuthorization.Type;

/** Can only stop an exact member. Never admits deletion. */
export const LibraryCapturePruneStopAuthorization = Schema.Struct({
  ...LibraryCapturePruneAuthorization.fields,
  stoppingAt: RecoveryOrdinal,
});

export type LibraryCapturePruneStopAuthorization = typeof LibraryCapturePruneStopAuthorization.Type;

export const LibraryCapturePruneStopReceipt = Schema.Struct({
  authorization: LibraryCapturePruneStopAuthorization,
});

export type LibraryCapturePruneStopReceipt = typeof LibraryCapturePruneStopReceipt.Type;

export const LibraryCapturePruneReceipt = Schema.Struct({
  authorization: LibraryCapturePruneAuthorization,
  removedRows: RecoveryOrdinal,
});

export type LibraryCapturePruneReceipt = typeof LibraryCapturePruneReceipt.Type;

export const LibraryCapturePruneProgress = Schema.Struct({
  done: Schema.Boolean,
  removedRows: RecoveryOrdinal,
  receipt: Schema.NullOr(LibraryCapturePruneReceipt),
});

export type LibraryCapturePruneProgress = typeof LibraryCapturePruneProgress.Type;
