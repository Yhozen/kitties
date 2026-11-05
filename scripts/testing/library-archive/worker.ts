import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Predicate from "effect/Predicate";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { LibraryModel } from "../../../packages/domain/src/Library.model.ts";
import { Library } from "../../../packages/domain/src/Library/Library.aggregate.ts";
import { LibraryId } from "../../../packages/domain/src/Library/Library.id.ts";
import { SkillId, skillDetailKey } from "../../../packages/domain/src/Library/Skill.id.ts";
import { SkillDetail } from "../../../packages/domain/src/Library/SkillDetail.view.ts";
import { FinalizeLibraryImport } from "../../../packages/domain/src/Library/FinalizeLibraryImport.command.ts";
import { ProposeSkill } from "../../../packages/domain/src/Library/ProposeSkill.command.ts";
import { AcceptSkill } from "../../../packages/domain/src/Library/AcceptSkill.command.ts";
import { LibraryActor } from "../../../packages/domain/src/LibraryActor.context.ts";
import {
  LibraryControl,
  LibraryControlAdapters,
} from "../../../apps/gateway/src/library-control.ts";
import { RecoveryDO } from "../../../apps/gateway/src/recovery-store.ts";
import { LibraryRecoveryCoordinator } from "../../../apps/gateway/src/library-recovery-coordinator.ts";
import { LibraryArchiveOperations } from "../../../apps/gateway/src/library-archive-operations.ts";
import {
  LibraryRetainedArchiveJournal,
  LibraryArchiveError,
} from "../../../apps/gateway/src/library-retained-archive-store.ts";
import { LibraryRecoveryError } from "../../../apps/gateway/src/library-recovery-records.ts";
import {
  LibraryRetainedArchive,
  LibraryArchiveObjects,
} from "../../../apps/gateway/src/library-retained-archive.ts";
import {
  LibraryObjectAdministration,
  libraryRecoveryHooksLayer,
} from "../../../apps/gateway/src/library-recovery-host.ts";
import {
  LibraryAdmission,
  LibraryRequestScope,
  libraryCommandId,
} from "../../../apps/gateway/src/library-session.ts";
import { ArchiveRequest } from "./protocol.ts";
import { LibraryArchiveProbe } from "./probe.ts";
import { ArchiveFixtureHooks, ArchiveNativeObjects } from "./native.ts";
import { ArchiveRetainedLive, archiveObjectEvidence } from "./retained.ts";
import { readBody } from "../../../apps/gateway/src/request.ts";

const owner = LibraryId.make("owner");
const codeDigest = "a".repeat(64);
const ControlLive = LibraryControlAdapters.pipe(Layer.provideMerge(LibraryControl.layer));

const HostLive = libraryRecoveryHooksLayer({
  modelName: "LibraryModel",
  layout: 0,
  libraryId: "owner",
  epoch: 1,
  lineage: "library-1",
}).pipe(Layer.provide(ControlLive));

const HooksLive = ArchiveFixtureHooks.pipe(Layer.provide(HostLive), Layer.provide(ControlLive));

const ModelLive = Layer.mergeAll(
  ControlLive,
  HostLive,
  HooksLive,
  LibraryModel.layer(Layer.empty).pipe(
    Layer.provide(DomainCloudflare.layerDurableObjects({ recovery: HooksLive })),
  ),
);

/** Stop only after real native work succeeds; the controller then kills its own host group. */
const ObservedAdministration = Layer.effect(
  LibraryObjectAdministration,
  Effect.gen(function* () {
    const admin = yield* LibraryObjectAdministration;
    const probes = yield* LibraryArchiveProbe;
    const probe = () => probes.getByName("probe");

    return LibraryObjectAdministration.of({
      ...admin,
      call: (ref, request) =>
        (Predicate.isTagged(request, "ReadPart")
          ? probe()
              .count("local-read")
              .pipe(Effect.orDie, Effect.andThen(admin.call(ref, request)))
          : admin.call(ref, request)
        ).pipe(
          Effect.tap((reply) => {
            if (Predicate.isTagged(request, "CaptureStep") && Predicate.isTagged(reply, "Progress"))
              return probe()
                .hit("capture", {
                  nativeId: ref.nativeId,
                  operationId: request.operationId,
                  done: reply.value.done,
                })
                .pipe(Effect.orDie);

            if (Predicate.isTagged(request, "ResumeCapture") && Predicate.isTagged(reply, "Status"))
              return probe()
                .hit("rearm", {
                  nativeId: ref.nativeId,
                  operationId: request.operationId,
                  nonce: reply.value.nonce,
                  resuming: reply.value.resuming,
                })
                .pipe(Effect.orDie);

            return Effect.void;
          }),
        ),
    });
  }),
).pipe(Layer.provide(ModelLive));

const NativeLive = Layer.merge(ModelLive, ObservedAdministration);

const ObservedRestoreIntent = Layer.effect(
  LibraryControl,
  Effect.gen(function* () {
    const control = yield* LibraryControl;
    const probes = yield* LibraryArchiveProbe;
    const probe = () => probes.getByName("probe");

    return LibraryControl.of({
      ...control,
      beginRestore: (operationId, intent) =>
        control.beginRestore(operationId, intent).pipe(
          Effect.tap(() =>
            probe()
              .hit("restore-intent", { operationId, ...intent })
              .pipe(Effect.orDie),
          ),
        ),
    });
  }),
).pipe(Layer.provide(ControlLive));

const ServicesLive = Layer.merge(
  LibraryRecoveryCoordinator.layer.pipe(
    Layer.provideMerge(Layer.merge(NativeLive, ObservedRestoreIntent)),
  ),
  ArchiveRetainedLive.pipe(Layer.provideMerge(NativeLive)),
);

const ApplicationLive = LibraryArchiveOperations.layer.pipe(
  Layer.provideMerge(Layer.merge(ServicesLive, ObservedRestoreIntent)),
);

export default class OwnedLibraryArchive extends Cloudflare.Worker<OwnedLibraryArchive>()(
  "OwnedLibraryArchive",
  { main: import.meta.url },
  Effect.gen(function* () {
    const control = yield* LibraryControl;
    const coordinator = yield* LibraryRecoveryCoordinator;
    const archive = yield* LibraryRetainedArchive;
    const objects = yield* LibraryArchiveObjects;
    const operations = yield* LibraryArchiveOperations;
    const journal = yield* LibraryRetainedArchiveJournal;
    const admin = yield* LibraryObjectAdministration;
    const native = yield* ArchiveNativeObjects;
    const admission = yield* LibraryAdmission;
    const roots = yield* RecoveryDO;
    const root = () => roots.getByName("control", { locationHint: "weur" });
    const probes = yield* LibraryArchiveProbe;
    const probe = () => probes.getByName("probe");
    const libraries = yield* Library;
    const details = yield* SkillDetail;

    const within = <A, E, R>(effect: Effect.Effect<A, E, R>, epoch: number) =>
      Effect.provideService(effect, LibraryRequestScope, { libraryId: owner, epoch });

    const admitted = <A, E, R>(effect: Effect.Effect<A, E, R>, epoch: number) =>
      admission.check({ libraryId: owner, epoch }).pipe(Effect.andThen(within(effect, epoch)));

    const actor = <A, E, R>(effect: Effect.Effect<A, E, R>, authority: "import" | "owner") =>
      Effect.provideService(effect, LibraryActor, {
        libraryId: owner,
        authority,
        importFinalized: authority === "owner",
      });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* Cloudflare.Request;

        if (request.method !== "POST")
          return HttpServerResponse.text("owned-library-archive", { status: 405 });

        if (Number(request.headers.get("content-length")) > 32768)
          return HttpServerResponse.text("too large", { status: 413 });

        const input = yield* readBody(request, ArchiveRequest).pipe(Effect.orDie);

        const action = Match.value(input)
          .pipe(
            Match.when({ action: "initialize" }, () =>
              Effect.gen(function* () {
                yield* control.initialize("archive-inventory");
                yield* within(
                  actor(
                    libraries.send(
                      owner,
                      new FinalizeLibraryImport({
                        inventoryId: "archive-inventory",
                        expectedImportedCount: 0,
                        expectedHighWater: 0,
                      }),
                      { commandId: libraryCommandId(1, "archive-finalize") },
                    ),
                    "import",
                  ),
                  1,
                );

                return yield* control.finishImport("archive-inventory", 0);
              }),
            ),
            Match.when({ action: "status" }, () => control.status),
            Match.when({ action: "global" }, () => root().status()),
            Match.when({ action: "metrics" }, () => probe().metrics()),
            Match.when({ action: "permit" }, ({ startedAt }) =>
              root().permit("archive-existing-workflow", "prior-run", startedAt),
            ),
            Match.when({ action: "propose" }, (input) =>
              admitted(
                actor(
                  libraries.send(owner, new ProposeSkill({ name: input.name, body: input.body }), {
                    commandId: libraryCommandId(input.epoch, input.id),
                  }),
                  "owner",
                ),
                input.epoch,
              ),
            ),
            Match.when({ action: "accept" }, (input) =>
              admitted(
                actor(
                  libraries.send(
                    owner,
                    new AcceptSkill({
                      skillId: SkillId.make(input.skillId),
                      expectedProposalRevision: input.revision,
                    }),
                    { commandId: libraryCommandId(input.epoch, input.id) },
                  ),
                  "owner",
                ),
                input.epoch,
              ),
            ),
            // Internal receipt inventory proof after restore; public stale-epoch requests remain denied.
            Match.when({ action: "raw-receipt" }, ({ id, commandEpoch, epoch }) =>
              admitted(
                actor(
                  libraries.send(
                    owner,
                    new ProposeSkill({ name: "Changed", body: "must return original raw receipt" }),
                    { commandId: libraryCommandId(commandEpoch, id) },
                  ),
                  "owner",
                ),
                epoch,
              ),
            ),
            Match.when({ action: "state" }, ({ epoch }) => admitted(libraries.state(owner), epoch)),
            Match.when({ action: "detail" }, ({ skillId, atLeast, epoch }) =>
              admitted(
                actor(
                  details.query(skillDetailKey(owner, SkillId.make(skillId)), {
                    atLeast,
                    timeout: "70 seconds",
                  }),
                  "owner",
                ),
                epoch,
              ),
            ),
            Match.when({ action: "arm" }, ({ boundary }) => probe().arm(boundary)),
            Match.when({ action: "wait" }, ({ boundary }) => probe().wait(boundary)),
            Match.when({ action: "delivery-gate" }, ({ key }) => probe().gateDelivery(key)),
          )
          .pipe(
            Match.when({ action: "capture" }, ({ operationId }) =>
              coordinator.capture({ operationId, codeDigest }),
            ),
            Match.when({ action: "capture-mismatch" }, ({ operationId }) =>
              coordinator.capture({ operationId, codeDigest: "b".repeat(64) }),
            ),
            Match.when({ action: "archive" }, (input) =>
              operations.export({ operationId: input.operationId, codeDigest }),
            ),
            Match.when({ action: "archive-status" }, ({ archiveId }) => archive.status(archiveId)),
            Match.when({ action: "restore-pin" }, ({ operationId }) =>
              journal.restorePin(operationId),
            ),
            Match.when({ action: "restore-intent" }, ({ operationId }) =>
              control.restoreIntent(operationId),
            ),
            Match.when({ action: "archive-object" }, ({ key }) =>
              archiveObjectEvidence(key).pipe(
                Effect.provideService(LibraryArchiveObjects, objects),
              ),
            ),
            Match.when({ action: "retained-restore" }, (input) =>
              operations.restore({
                operationId: input.operationId,
                archiveId: input.archiveId,
                codeDigest,
              }),
            ),
            Match.when({ action: "native-restore" }, ({ operationId, captureId }) =>
              coordinator.restore({ operationId, setId: captureId, codeDigest }),
            ),
            Match.when({ action: "retained-mismatch" }, (input) =>
              Effect.gen(function* () {
                const source = yield* archive.retainedSource({
                  archiveId: input.archiveId,
                  restoreId: input.restoreId,
                  codeDigest,
                });

                return yield* source.read({
                  operationId: input.restoreId,
                  captureId: input.captureId,
                  source: input.source,
                  image: input.image,
                  row: 1,
                  part: 0,
                });
              }),
            ),
            Match.when({ action: "grant-export" }, ({ captureId, grantId }) =>
              control.grantExport(grantId, captureId),
            ),
            Match.when({ action: "image" }, ({ captureId, ordinal }) =>
              control.image(captureId, ordinal),
            ),
            Match.when({ action: "inventory" }, ({ lineage, after }) =>
              control.inventory(lineage, after),
            ),
            Match.when({ action: "capture-inventory" }, ({ operationId, after }) =>
              control.captureInventory(operationId, after),
            ),
          )
          .pipe(
            Match.when({ action: "resume-progress" }, ({ operationId, ordinal }) =>
              control.resumeProgress(operationId, ordinal),
            ),
            Match.when({ action: "admin" }, ({ ref, request }) => admin.call(ref, request)),
            Match.when({ action: "inspect" }, ({ ref, captureId }) =>
              native.call(ref, { action: "inspect", captureId }),
            ),
            Match.when({ action: "drop-local-buffer" }, ({ ref, captureId }) =>
              native.call(ref, { action: "drop-local-buffer", captureId }),
            ),
            Match.exhaustive,
          );

        const result = yield* Effect.exit(
          action.pipe(
            Effect.timeout(
              input.action === "capture" ||
                input.action === "detail" ||
                input.action === "archive" ||
                input.action === "retained-restore"
                ? "120 seconds"
                : "10 seconds",
            ),
          ),
        );

        return yield* HttpServerResponse.json(
          Exit.isSuccess(result)
            ? { ok: true, value: result.value ?? null }
            : {
                ok: false,
                error: Cause.pretty(result.cause),
                reason: Option.match(Cause.findErrorOption(result.cause), {
                  onNone: () => null,
                  onSome: (error) =>
                    Schema.is(LibraryRecoveryError)(error) || Schema.is(LibraryArchiveError)(error)
                      ? error.reason
                      : null,
                }),
              },
        );
      }),
    };
  }).pipe(Effect.provide(ApplicationLive)),
) {}
