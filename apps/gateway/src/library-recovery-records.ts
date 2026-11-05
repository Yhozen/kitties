import * as Schema from "effect/Schema";

export const RecoveryOrdinal = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const RecoveryOperationId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));
export const RecoveryDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const LibraryLineage = Schema.String.check(Schema.isPattern(/^library-[1-9][0-9]*$/));

export const LibraryObjectClass = Schema.Literals([
  "LibraryModel.DomainDirectory",
  "LibraryModel.LibraryAggregate",
  "LibraryModel.SkillDetailViewV1",
  "LibraryModel.SkillDetailViewV1Run",
]);

export const LibraryObjectRef = Schema.Struct({
  modelName: Schema.Literal("LibraryModel"),
  layout: Schema.Literal(0),
  className: LibraryObjectClass,
  lineage: LibraryLineage,
  logicalName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  physicalName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1152)),
  nativeId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});

export type LibraryObjectRef = typeof LibraryObjectRef.Type;

export const LibraryRecoveryState = Schema.Struct({
  libraryId: Schema.Literal("owner"),
  epoch: RecoveryOrdinal,
  lineage: LibraryLineage,
  nextLineage: RecoveryOrdinal,
  phase: Schema.Literals(["importing", "ready", "frozen", "staging", "activating", "resuming"]),
  inventoryId: RecoveryOperationId,
  operationId: Schema.NullOr(RecoveryOperationId),
  /** Missing only on historical restore records; never grants capture authority. */
  operationKind: Schema.optionalKey(Schema.Literals(["capture", "restore"])),
  stagingLineage: Schema.NullOr(LibraryLineage),
  allocatorFloor: RecoveryOrdinal,
});

export type LibraryRecoveryState = typeof LibraryRecoveryState.Type;

/** Capture intent is immutable before any object is frozen or partially copied. */
export const LibraryCaptureOperation = Schema.Struct({
  kind: Schema.Literal("capture"),
  setId: Schema.Null,
  codeDigest: RecoveryDigest,
});

export type LibraryCaptureOperation = typeof LibraryCaptureOperation.Type;

export const LibraryRestoreSource = Schema.Union([
  Schema.TaggedStruct("Native", {}),
  Schema.TaggedStruct("Retained", {
    archiveId: RecoveryOperationId,
    manifestDigest: RecoveryDigest,
  }),
]);

export type LibraryRestoreSource = typeof LibraryRestoreSource.Type;

/** Bound before destructive recovery; transport retries cannot replace its source. */
export const LibraryRestoreIntent = Schema.Struct({
  setId: RecoveryOperationId,
  codeDigest: RecoveryDigest,
  source: LibraryRestoreSource,
});

export type LibraryRestoreIntent = typeof LibraryRestoreIntent.Type;

export const LibraryLineagePhase = Schema.Literals([
  "importing",
  "active",
  "frozen",
  "staging",
  "activating",
  "resuming",
  "retired",
]);

export const RegisteredLibraryObject = Schema.Struct({
  ...LibraryObjectRef.fields,
  ordinal: RecoveryOrdinal,
  phase: LibraryLineagePhase,
});

export type RegisteredLibraryObject = typeof RegisteredLibraryObject.Type;

export const LibraryObjectImage = Schema.Struct({
  digest: RecoveryDigest,
  kvCount: RecoveryOrdinal,
  sqlCount: RecoveryOrdinal,
});

export type LibraryObjectImage = typeof LibraryObjectImage.Type;

export const LibraryRecoverySet = Schema.Struct({
  id: RecoveryOperationId,
  sourceLineage: LibraryLineage,
  inventoryId: RecoveryOperationId,
  allocatorFloor: RecoveryOrdinal,
  objectCount: RecoveryOrdinal,
  codeDigest: RecoveryDigest,
  /** Server clock at first seal. Historical restore sets may omit it. */
  capturedAt: Schema.optionalKey(RecoveryOrdinal),
});

export type LibraryRecoverySet = typeof LibraryRecoverySet.Type;

export const LibraryExportGrant = Schema.Struct({
  grantId: RecoveryOperationId,
  captureId: RecoveryOperationId,
});

export type LibraryExportGrant = typeof LibraryExportGrant.Type;

export const LibraryExportAuthorization = Schema.Struct({
  captureId: RecoveryOperationId,
  ordinal: RecoveryOrdinal,
  source: LibraryObjectRef,
  image: LibraryObjectImage,
});

export type LibraryExportAuthorization = typeof LibraryExportAuthorization.Type;

export class LibraryRecoveryError extends Schema.TaggedError<
  LibraryRecoveryError,
  { readonly brand: unique symbol }
>()("LibraryRecoveryError", {
  reason: Schema.Literals([
    "invalid",
    "uninitialized",
    "conflict",
    "fenced",
    "incomplete",
    "exhausted",
    "storage",
  ]),
}) {}
