import * as Schema from "effect/Schema";
import {
  LibraryObjectRef,
  LibraryObjectImage,
  RegisteredLibraryObject,
  RecoveryOperationId,
  RecoveryOrdinal,
  LibraryRecoveryError,
} from "../../../apps/gateway/src/library-recovery-records.ts";
import { LibraryArchiveError } from "../../../apps/gateway/src/library-retained-archive-store.ts";
import { LibraryAdminRequest } from "../../../apps/gateway/src/library-object-admin.ts";
import { LibraryArchivePruneRequest } from "../../../apps/gateway/src/library-capture-prune-records.ts";
import { LibraryCapturePruneCandidatesRequest } from "../../../apps/gateway/src/library-capture-prune-records.ts";

export const ArchiveBoundary = Schema.Literals([
  "capture",
  "rearm",
  "upload",
  "restore-intent",
  "prune-step",
  "prune-stop",
]);

export const ArchiveRequest = Schema.Union([
  Schema.Struct({ action: Schema.Literal("scheduled-start"), id: RecoveryOperationId }),
  Schema.Struct({
    action: Schema.Literal("scheduled-result"),
    id: Schema.String.check(Schema.isMaxLength(128)),
  }),
  Schema.Struct({
    action: Schema.Literal("scheduled-resume"),
    id: Schema.String.check(Schema.isMaxLength(128)),
  }),
  Schema.Struct({
    action: Schema.Literal("prune-candidates"),
    request: LibraryCapturePruneCandidatesRequest,
  }),
  Schema.Struct({ action: Schema.Literal("step-observations"), nativeId: Schema.String }),
  Schema.Struct({ action: Schema.Literal("prune-verify"), request: LibraryArchivePruneRequest }),
  Schema.Struct({ action: Schema.Literal("prune-status"), pruneId: RecoveryOperationId }),
  Schema.Struct({ action: Schema.Literal("prune-plan"), pruneId: RecoveryOperationId }),
  Schema.Struct({ action: Schema.Literal("prune-begin"), pruneId: RecoveryOperationId }),
  Schema.Struct({
    action: Schema.Literal("prune-replies"),
    pruneId: RecoveryOperationId,
    nativeId: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("prune"),
    operationId: RecoveryOperationId,
    captureId: RecoveryOperationId,
    archiveId: RecoveryOperationId,
  }),
  Schema.Struct({
    action: Schema.Literal("prune-abandon"),
    operationId: RecoveryOperationId,
    captureId: RecoveryOperationId,
    archiveId: RecoveryOperationId,
  }),
  Schema.Struct({
    action: Schema.Literal("archive-begin"),
    archiveId: RecoveryOperationId,
    captureId: RecoveryOperationId,
  }),
  Schema.Struct({
    action: Schema.Literal("archive-alias"),
    archiveId: RecoveryOperationId,
    captureId: RecoveryOperationId,
  }),
  Schema.Struct({
    action: Schema.Literal("archive-pin"),
    archiveId: RecoveryOperationId,
    restoreId: RecoveryOperationId,
  }),
  Schema.Struct({
    action: Schema.Literal("archive-fault"),
    archiveId: RecoveryOperationId,
    key: Schema.String.check(Schema.isMaxLength(512)),
    mode: Schema.Literals(["missing", "corrupt"]),
  }),
  Schema.Struct({
    action: Schema.Literal("snapshot"),
    ref: LibraryObjectRef,
    captureId: RecoveryOperationId,
  }),
  Schema.Struct({ action: Schema.Literal("initialize") }),
  Schema.Struct({ action: Schema.Literal("status") }),
  Schema.Struct({ action: Schema.Literal("global") }),
  Schema.Struct({ action: Schema.Literal("metrics") }),
  Schema.Struct({ action: Schema.Literal("permit"), startedAt: RecoveryOrdinal }),
  Schema.Struct({
    action: Schema.Literal("propose"),
    id: RecoveryOperationId,
    name: Schema.String.check(Schema.isMaxLength(128)),
    body: Schema.String.check(Schema.isMaxLength(10000)),
    epoch: RecoveryOrdinal,
  }),
  Schema.Struct({
    action: Schema.Literal("accept"),
    id: RecoveryOperationId,
    skillId: Schema.String.check(Schema.isMaxLength(128)),
    revision: RecoveryOrdinal,
    epoch: RecoveryOrdinal,
  }),
  Schema.Struct({
    action: Schema.Literal("raw-receipt"),
    id: RecoveryOperationId,
    commandEpoch: RecoveryOrdinal,
    epoch: RecoveryOrdinal,
  }),
  Schema.Struct({ action: Schema.Literal("state"), epoch: RecoveryOrdinal }),
  Schema.Struct({
    action: Schema.Literal("detail"),
    skillId: Schema.String.check(Schema.isMaxLength(128)),
    atLeast: Schema.Struct({ stream: Schema.String, version: RecoveryOrdinal }),
    epoch: RecoveryOrdinal,
  }),
  Schema.Struct({
    action: Schema.Literal("arm"),
    boundary: Schema.NullOr(ArchiveBoundary),
  }),
  Schema.Struct({ action: Schema.Literal("wait"), boundary: ArchiveBoundary }),
  Schema.Struct({
    action: Schema.Literal("delivery-gate"),
    key: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1024))),
  }),
  Schema.Struct({ action: Schema.Literal("capture"), operationId: RecoveryOperationId }),
  Schema.Struct({ action: Schema.Literal("capture-mismatch"), operationId: RecoveryOperationId }),
  Schema.Struct({
    action: Schema.Literal("archive"),
    operationId: RecoveryOperationId,
  }),
  Schema.Struct({ action: Schema.Literal("archive-mismatch"), operationId: RecoveryOperationId }),
  Schema.Struct({ action: Schema.Literal("archive-status"), archiveId: RecoveryOperationId }),
  Schema.Struct({ action: Schema.Literal("restore-pin"), operationId: RecoveryOperationId }),
  Schema.Struct({ action: Schema.Literal("restore-intent"), operationId: RecoveryOperationId }),
  Schema.Struct({
    action: Schema.Literal("archive-object"),
    key: Schema.String.check(
      Schema.isPattern(
        /^exports\/library-v1\/[a-zA-Z0-9_-]{1,128}\/(?:parts\/[0-9]+\/[0-9]+\/[0-9]+|metadata\/[0-9]+|manifest)\.json$/,
      ),
    ),
  }),
  Schema.Struct({
    action: Schema.Literal("retained-restore"),
    archiveId: RecoveryOperationId,
    operationId: RecoveryOperationId,
  }),
  Schema.Struct({
    action: Schema.Literal("native-restore"),
    operationId: RecoveryOperationId,
    captureId: RecoveryOperationId,
  }),
  Schema.Struct({
    action: Schema.Literal("retained-mismatch"),
    archiveId: RecoveryOperationId,
    restoreId: RecoveryOperationId,
    captureId: RecoveryOperationId,
    source: RegisteredLibraryObject,
    image: LibraryObjectImage,
  }),
  Schema.Struct({
    action: Schema.Literal("grant-export"),
    captureId: RecoveryOperationId,
    grantId: RecoveryOperationId,
  }),
  Schema.Struct({
    action: Schema.Literal("image"),
    captureId: RecoveryOperationId,
    ordinal: RecoveryOrdinal,
  }),
  Schema.Struct({
    action: Schema.Literal("inventory"),
    lineage: Schema.String,
    after: RecoveryOrdinal,
  }),
  Schema.Struct({
    action: Schema.Literal("capture-inventory"),
    operationId: RecoveryOperationId,
    after: RecoveryOrdinal,
  }),
  Schema.Struct({
    action: Schema.Literal("resume-progress"),
    operationId: RecoveryOperationId,
    ordinal: RecoveryOrdinal,
  }),
  Schema.Struct({
    action: Schema.Literal("admin"),
    ref: LibraryObjectRef,
    request: LibraryAdminRequest,
  }),
  Schema.Struct({
    action: Schema.Literal("inspect"),
    ref: LibraryObjectRef,
    captureId: RecoveryOperationId,
  }),
  Schema.Struct({
    action: Schema.Literal("drop-local-buffer"),
    ref: LibraryObjectRef,
    captureId: RecoveryOperationId,
  }),
]);

export type ArchiveRequest = typeof ArchiveRequest.Type;

export const ArchiveResponse = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.String,
    reason: Schema.NullOr(
      Schema.Union([LibraryRecoveryError.fields.reason, LibraryArchiveError.fields.reason]),
    ),
  }),
]);
