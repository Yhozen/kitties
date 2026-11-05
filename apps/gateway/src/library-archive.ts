import * as Cloudflare from "@alchemy.run/cloudflare";
import type * as cf from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Match from "effect/Match";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { decodeLibraryArchiveReply } from "./library-archive-wire.ts";
import { LibraryControl } from "./library-control.ts";
import { LibraryImagePart, type LibraryAdminRequest } from "./library-object-admin.ts";
import { LibraryObjectAdministration } from "./library-recovery-host.ts";
import { LibraryRecoveryError } from "./library-recovery-records.ts";
import {
  LibraryArchiveCaptureSource,
  LibraryArchiveKey,
  LibraryArchiveObjects,
  LibraryRetainedArchive,
} from "./library-retained-archive.ts";
import {
  LibraryArchiveError,
  LibraryArchiveObject,
  LibraryArchivePageReceipt,
  LibraryArchivePartReceipt,
  LibraryArchivePin,
  LibraryArchivePruneVerification,
  LibraryArchivePruneWork,
  LibraryArchiveStatus,
  LibraryRetainedArchiveJournal,
} from "./library-retained-archive-store.ts";
import { RecoveryDO } from "./recovery-store.ts";

export const LibraryArchiveControlPolicy = Context.Reference<{ readonly callMs: number }>(
  "@kitties/gateway/LibraryArchiveControlPolicy",
  { defaultValue: () => ({ callMs: 5000 }) },
);

const unavailable = () => new LibraryArchiveError({ reason: "storage" });
const Admin = Data.taggedEnum<LibraryAdminRequest>();

const fromRecovery = (error: LibraryRecoveryError) =>
  new LibraryArchiveError({
    reason: Match.value(error.reason).pipe(
      Match.whenOr("storage", "incomplete", "invalid", (reason) => reason),
      Match.orElse((): "conflict" => "conflict"),
    ),
  });

/** The same permanent RecoveryDO owns capture authority and archive receipts. */
export const LibraryArchiveJournalLive = Layer.effect(
  LibraryRetainedArchiveJournal,
  Effect.gen(function* () {
    const roots = yield* RecoveryDO;
    const policy = yield* LibraryArchiveControlPolicy;
    const root = () => roots.getByName("control", { locationHint: "weur" });

    const call = <S extends Schema.ConstraintDecoder<unknown>, E, R>(
      schema: S,
      effect: () => Effect.Effect<unknown, E, R>,
    ) =>
      Effect.suspend(effect).pipe(
        Effect.mapError(unavailable),
        Effect.flatMap(decodeLibraryArchiveReply(schema)),
        Effect.catchDefect(unavailable),
        Effect.timeoutOrElse({ duration: policy.callMs, orElse: unavailable }),
      );

    return LibraryRetainedArchiveJournal.of({
      reservePrune: (request, now) =>
        call(LibraryArchivePruneVerification, () =>
          root().libraryArchiveReservePrune(request, now),
        ),
      pruneStatus: (id) =>
        call(Schema.NullOr(LibraryArchivePruneVerification), () =>
          root().libraryArchivePruneStatus(id),
        ),
      pruneNext: (id, now) =>
        call(Schema.NullOr(LibraryArchivePruneWork), () => root().libraryArchivePruneNext(id, now)),
      acknowledgePrune: (id, sequence, receipt, now) =>
        call(LibraryArchivePruneVerification, () =>
          root().libraryArchiveAcknowledgePrune(id, sequence, receipt, now),
        ),
      finishPrune: (id) =>
        call(LibraryArchivePruneVerification, () => root().libraryArchiveFinishPrune(id)),
      finishAbandon: (id) =>
        call(LibraryArchivePruneVerification, () => root().libraryArchiveFinishAbandon(id)),
      setup: call(Schema.Undefined, () => root().libraryArchiveSetup()),
      begin: (header) => call(LibraryArchiveStatus, () => root().libraryArchiveBegin(header)),
      status: (id) =>
        call(Schema.NullOr(LibraryArchiveStatus), () => root().libraryArchiveStatus(id)),
      object: (id, ordinal) =>
        call(Schema.NullOr(LibraryArchiveObject), () => root().libraryArchiveObject(id, ordinal)),
      objects: (id, after) =>
        call(Schema.mutable(Schema.Array(LibraryArchiveObject)), () =>
          root().libraryArchiveObjects(id, after),
        ),
      recordObject: (id, value) =>
        call(LibraryArchiveObject, () => root().libraryArchiveRecordObject(id, value)),
      part: (id, ordinal, row, part) =>
        call(Schema.NullOr(LibraryArchivePartReceipt), () =>
          root().libraryArchivePart(id, ordinal, row, part),
        ),
      recordPart: (id, ordinal, value) =>
        call(LibraryArchivePartReceipt, () => root().libraryArchiveRecordPart(id, ordinal, value)),
      completeObject: (id, ordinal) =>
        call(LibraryArchiveObject, () => root().libraryArchiveCompleteObject(id, ordinal)),
      page: (id, page) =>
        call(Schema.NullOr(LibraryArchivePageReceipt), () => root().libraryArchivePage(id, page)),
      recordPage: (id, value) =>
        call(LibraryArchivePageReceipt, () => root().libraryArchiveRecordPage(id, value)),
      commit: (id, value, now) =>
        call(LibraryArchiveStatus, () => root().libraryArchiveCommit(id, value, now)),
      pinRestore: (id, archiveId, now) =>
        call(LibraryArchivePin, () => root().libraryArchivePinRestore(id, archiveId, now)),
      restorePin: (id) =>
        call(Schema.NullOr(LibraryArchivePin), () => root().libraryArchiveRestorePin(id)),
      finishRestore: (id) => call(LibraryArchivePin, () => root().libraryArchiveFinishRestore(id)),
      pins: (id, after) =>
        call(Schema.mutable(Schema.Array(LibraryArchivePin)), () =>
          root().libraryArchivePins(id, after),
        ),
    });
  }),
);

/** Export reads carry only an exact sealed-set grant, never mutation authority. */
export const LibraryArchiveCaptureSourceLive = Layer.effect(
  LibraryArchiveCaptureSource,
  Effect.gen(function* () {
    const control = yield* LibraryControl;
    const admin = yield* LibraryObjectAdministration;
    const policy = yield* LibraryArchiveControlPolicy;

    return LibraryArchiveCaptureSource.of({
      recoverySet: (captureId) =>
        control.recoverySet(captureId).pipe(
          Effect.mapError(fromRecovery),
          Effect.flatMap((set) =>
            set === null
              ? Effect.fail(new LibraryArchiveError({ reason: "incomplete" }))
              : Effect.succeed(set),
          ),
        ),
      inventory: (captureId, after) =>
        control.captureInventory(captureId, after).pipe(Effect.mapError(fromRecovery)),
      authorize: (grantId, captureId, ordinal) =>
        control.authorizeExport(grantId, captureId, ordinal).pipe(Effect.mapError(fromRecovery)),
      read: ({ grantId, captureId, source, row, part }) =>
        admin.call(source, Admin.ExportPart({ grantId, captureId, row, part })).pipe(
          Effect.mapError(fromRecovery),
          Effect.flatMap((reply) =>
            Predicate.isTagged(reply, "Part")
              ? Schema.decodeUnknownEffect(LibraryImagePart)(reply.value).pipe(
                  Effect.mapError(unavailable),
                )
              : Effect.fail(
                  new LibraryArchiveError({
                    reason:
                      Predicate.isTagged(reply, "Rejected") && reply.reason === "storage"
                        ? "storage"
                        : "incomplete",
                  }),
                ),
          ),
          Effect.catchDefect(unavailable),
          Effect.timeoutOrElse({ duration: policy.callMs, orElse: unavailable }),
        ),
    });
  }),
);

const ArchiveStorageLive = Layer.unwrap(
  Effect.gen(function* () {
    // SAFETY: worker.ts declares both bindings; the archive can access no other bucket or key.
    const env = (yield* Cloudflare.WorkerEnvironment) as {
      EXPORTS: cf.R2Bucket;
      KITTIES_KEK: string;
    };

    return Layer.merge(
      LibraryArchiveObjects.layerR2({
        get: (key) => env.EXPORTS.get(key),
        put: (key, body, options) => env.EXPORTS.put(key, body, options),
      }),
      Layer.succeed(LibraryArchiveKey, { value: Redacted.make(env.KITTIES_KEK) }),
    );
  }),
);

export const LibraryArchiveLive = LibraryRetainedArchive.layer.pipe(
  Layer.provide(
    Layer.mergeAll(LibraryArchiveJournalLive, LibraryArchiveCaptureSourceLive, ArchiveStorageLive),
  ),
);
