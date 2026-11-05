import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import * as Aggregate from "@alchemy.run/domain/Aggregate";
import {
  RecoveryHooks,
  recoveryNamespaceCalls,
  scopeRecoveryMembers,
  withBackfillRecovery,
  type BackfillInput,
} from "@alchemy.run/cloudflare/Domain/RecoveryHooks";
import * as NativeWorkflow from "@alchemy.run/cloudflare/Workflows/Workflow";
import { LibraryModel } from "../../../packages/domain/src/Library.model.ts";
import { Library } from "../../../packages/domain/src/Library/Library.aggregate.ts";
import { LibraryId } from "../../../packages/domain/src/Library/Library.id.ts";
import { FinalizeLibraryImport } from "../../../packages/domain/src/Library/FinalizeLibraryImport.command.ts";
import { ProposeSkill } from "../../../packages/domain/src/Library/ProposeSkill.command.ts";
import { AcceptSkill } from "../../../packages/domain/src/Library/AcceptSkill.command.ts";
import { RemoveSkill } from "../../../packages/domain/src/Library/RemoveSkill.command.ts";
import { SkillDetail } from "../../../packages/domain/src/Library/SkillDetail.view.ts";
import { SkillId, skillDetailKey } from "../../../packages/domain/src/Library/Skill.id.ts";
import { LibraryActor } from "../../../packages/domain/src/LibraryActor.context.ts";
import {
  LibraryControl,
  LibraryControlAdapters,
} from "../../../apps/gateway/src/library-control.ts";
import { LibraryRecoveryCoordinator } from "../../../apps/gateway/src/library-recovery-coordinator.ts";
import { HomeDO, HomeDOLive } from "../../../apps/gateway/src/actors.ts";
import { RecoveryDO } from "../../../apps/gateway/src/recovery-store.ts";
import {
  LibrarySnapshot,
  LibrarySnapshotSource,
} from "../../../apps/gateway/src/library-snapshot.ts";
import {
  LibraryObjectAdministration,
  libraryRecoveryHooksLayer,
} from "../../../apps/gateway/src/library-recovery-host.ts";
import {
  LibraryObjectClass,
  LibraryObjectRef,
  LibraryObjectImage,
  RecoveryOrdinal,
} from "../../../apps/gateway/src/library-recovery-records.ts";
import { LibraryAdminRequest } from "../../../apps/gateway/src/library-object-admin.ts";
import {
  LibraryRequestScope,
  LibraryAdmission,
  libraryCommandId,
} from "../../../apps/gateway/src/library-session.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

class LibraryFixtureHeld extends Schema.TaggedError<
  LibraryFixtureHeld,
  { readonly brand: unique symbol }
>()("LibraryFixtureHeld", {}) {}

class LibraryFixture extends Cloudflare.DurableObject<LibraryFixture>()(
  "LibraryFixture",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.sync(() => {
      const sql = state.raw.storage.sql;
      sql.exec("CREATE TABLE IF NOT EXISTS notes(key TEXT PRIMARY KEY,body TEXT NOT NULL)");
      const waiters = new Map<string, Set<(body: string) => void>>();

      const read = (key: string) =>
        sql.exec<{ body: string }>("SELECT body FROM notes WHERE key=?", key).toArray()[0]?.body;

      return {
        gate: (key: string | null) => Effect.sync(() => state.raw.storage.kv.put("held", key)),
        check: (key: string) =>
          Effect.gen(function* () {
            if (state.raw.storage.kv.get<string | null>("held") === key)
              return yield* new LibraryFixtureHeld();
          }),
        pauseMigration: (count: number) =>
          Effect.gen(function* () {
            if (state.raw.storage.kv.get<string | null>("held") !== "migration" || count !== 1)
              return;
            const body = JSON.stringify({ importedCount: count });
            sql.exec("INSERT OR REPLACE INTO notes VALUES ('migration-paused',?)", body);

            for (const resume of waiters.get("migration-paused") ?? []) resume(body);
            waiters.delete("migration-paused");

            return yield* Effect.never;
          }),
        note: (key: string, body: Schema.Json) =>
          Effect.sync(() => {
            const text = JSON.stringify(body);
            sql.exec("INSERT OR REPLACE INTO notes VALUES (?,?)", key, text);

            for (const resume of waiters.get(key) ?? []) resume(text);
            waiters.delete(key);
          }),
        wait: (key: string) =>
          Effect.callback<string>((resume) => {
            const existing = read(key);

            if (existing !== undefined) {
              resume(Effect.succeed(existing));

              return;
            }

            const group = waiters.get(key) ?? new Set();
            const done = (body: string) => resume(Effect.succeed(body));
            group.add(done);
            waiters.set(key, group);

            return Effect.sync(() => {
              group.delete(done);
            });
          }),
      };
    });
  }),
) {}

const owner = LibraryId.make("owner");

const rollout = {
  modelName: "LibraryModel",
  layout: 0,
  libraryId: "owner",
  epoch: 1,
  lineage: "library-1",
} as const;

const model = { modelName: "LibraryModel", version: 0, jurisdiction: undefined } as const;

const ControlLive = LibraryControlAdapters.pipe(Layer.provideMerge(LibraryControl.layer));

const HostLive = libraryRecoveryHooksLayer(rollout).pipe(Layer.provide(ControlLive));

const FixtureHooks = Layer.effect(
  RecoveryHooks,
  Effect.gen(function* () {
    const hooks = yield* RecoveryHooks;
    const namespace = yield* LibraryFixture;
    const fixture = () => namespace.getByName("fixture");

    return RecoveryHooks.of({
      ...hooks,
      object: (descriptor, next) => {
        const wrapped = hooks.object(descriptor, next);

        if (descriptor.className !== "LibraryModel.LibraryAggregate") return wrapped;

        return Effect.gen(function* () {
          const state = yield* Cloudflare.DurableObjectState;
          const inner = yield* wrapped;

          const progress = Schema.Struct({
            state: Schema.Struct({
              importProgress: Schema.Struct({
                importedCount: RecoveryOrdinal,
                _tag: Schema.String,
              }),
            }),
          });

          return inner.pipe(
            Effect.map((members) =>
              scopeRecoveryMembers(members, <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                effect.pipe(
                  Effect.tap(() =>
                    Effect.suspend(() => {
                      const decoded = Schema.decodeUnknownOption(progress)(
                        state.raw.storage.kv.get("meta"),
                      );

                      return Option.isSome(decoded) &&
                        !Predicate.isTagged(decoded.value.state.importProgress, "Finalized")
                        ? fixture()
                            .pauseMigration(decoded.value.state.importProgress.importedCount)
                            .pipe(Effect.orDie)
                        : Effect.void;
                    }),
                  ),
                ),
              ),
            ),
          );
        });
      },
      namespace: (descriptor, next) => {
        const scoped = hooks.namespace(descriptor, next);

        return descriptor.className !== "LibraryModel.SkillDetailViewV1"
          ? scoped
          : {
              ...scoped,
              getByName: recoveryNamespaceCalls(scoped, (name) =>
                fixture()
                  .check(name)
                  .pipe(
                    Effect.orDie,
                    Effect.as({
                      physicalName: name,
                      scope: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                        effect.pipe(
                          Effect.tapCause((cause) =>
                            Effect.sync(() =>
                              console.log("fixture scoped failure", Cause.pretty(cause)),
                            ),
                          ),
                        ),
                    }),
                  ),
              ),
            };
      },
      backfill: (descriptor, input, next) =>
        hooks.backfill(descriptor, input, next).pipe(
          Effect.catchCause((cause) =>
            fixture()
              .note(
                input === undefined ? "backfill-missing" : "backfill-rejected",
                Cause.pretty(cause),
              )
              .pipe(Effect.andThen(Effect.failCause(cause))),
          ),
        ),
    });
  }),
).pipe(Layer.provide(HostLive));

const Live = Layer.mergeAll(
  HostLive,
  FixtureHooks,
  ControlLive,
  LibraryModel.layer(Layer.empty).pipe(
    Layer.provide(DomainCloudflare.layerDurableObjects({ recovery: FixtureHooks })),
  ),
);

const SnapshotLive = LibrarySnapshot.layer.pipe(
  Layer.provide(LibrarySnapshotSource.layer),
  Layer.provideMerge(Live),
);

const HomeLive = HomeDOLive.pipe(Layer.provideMerge(SnapshotLive));

const ApplicationLive = LibraryRecoveryCoordinator.layer.pipe(Layer.provideMerge(HomeLive));

const Input = Schema.Struct({
  action: Schema.Literals([
    "initialize",
    "finish",
    "state",
    "import-state",
    "import-detail",
    "receipt",
    "propose",
    "finalize",
    "detail",
    "gate",
    "inventory",
    "freeze",
    "freeze-ack",
    "image-record",
    "seal",
    "prepare",
    "register",
    "admin",
    "loaded",
    "activate",
    "active-ack",
    "publish",
    "restore",
    "global-begin",
    "global-complete",
    "global-status",
    "accept",
    "remove",
    "home-write",
    "home-insert",
    "home-read",
    "home-remove",
    "home-status",
    "home-migrate",
    "home-turn",
    "workflow-create",
    "workflow-start",
    "workflow-result",
    "wait",
    "descriptor",
  ]),
  atLeast: Schema.optional(Schema.Struct({ stream: Schema.String, version: RecoveryOrdinal })),
  epoch: Schema.optional(RecoveryOrdinal),
  operationId: Schema.optional(Schema.String),
  setId: Schema.optional(Schema.String),
  ordinal: Schema.optional(RecoveryOrdinal),
  after: Schema.optional(RecoveryOrdinal),
  before: Schema.optional(Schema.String),
  nonce: Schema.optional(Schema.NullOr(Schema.String)),
  lineage: Schema.optional(Schema.String),
  logicalName: Schema.optional(Schema.String),
  className: Schema.optional(LibraryObjectClass),
  ref: Schema.optional(LibraryObjectRef),
  request: Schema.optional(LibraryAdminRequest),
  image: Schema.optional(LibraryObjectImage),
  name: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  skillId: Schema.optional(Schema.String),
  key: Schema.optional(Schema.NullOr(Schema.String)),
  id: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  revision: Schema.optional(RecoveryOrdinal),
  missing: Schema.optional(Schema.Boolean),
});

export default class OwnedLibraryRecovery extends Cloudflare.Worker<OwnedLibraryRecovery>()(
  "OwnedLibraryRecovery",
  { main: import.meta.url },
  Effect.gen(function* () {
    const control = yield* LibraryControl;
    const coordinator = yield* LibraryRecoveryCoordinator;
    const admission = yield* LibraryAdmission;
    const homes = yield* HomeDO;
    const home = () => homes.getByName("home", { locationHint: "weur" });
    const roots = yield* RecoveryDO;
    const root = () => roots.getByName("control", { locationHint: "weur" });
    const fixtures = yield* LibraryFixture;
    const fixture = () => fixtures.getByName("fixture");
    const libraries = yield* Library;
    const details = yield* SkillDetail;
    const hooks = yield* RecoveryHooks;
    const administration = yield* LibraryObjectAdministration;

    const queued = yield* Cloudflare.Workflow(
      "QueuedLibraryBackfill",
      Effect.succeed((params: BackfillInput) =>
        Effect.gen(function* () {
          if (params.recovery !== undefined) {
            yield* fixture().note(
              "workflow-created",
              Schema.decodeUnknownSync(Schema.Json)(params.recovery ?? null),
            );
            yield* NativeWorkflow.waitForEvent("Before recovery hook", {
              type: "start",
              timeout: "1 hour",
            });
          }

          return yield* withBackfillRecovery(
            hooks,
            model,
            params.recovery,
            Effect.succeed("body reached"),
          ).pipe(
            Effect.catchCause((cause) =>
              fixture()
                .note("backfill-failed", Cause.pretty(cause))
                .pipe(Effect.andThen(Effect.failCause(cause))),
            ),
          );
        }),
      ),
    );

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

        if (request.method === "GET") return HttpServerResponse.text("owned-library-recovery");

        const input = yield* Effect.tryPromise(() => request.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Input)),
          Effect.orDie,
        );

        const epoch = input.epoch ?? 1;
        const operationId = input.operationId ?? "capture";

        const action = Match.value(input.action)
          .pipe(
            Match.when("initialize", () => control.initialize("inventory")),
            Match.when("finish", () => control.finishImport("inventory", 0)),
            Match.when("finalize", () =>
              within(
                actor(
                  libraries.send(
                    owner,
                    new FinalizeLibraryImport({
                      inventoryId: "inventory",
                      expectedImportedCount: 0,
                      expectedHighWater: 0,
                    }),
                    { commandId: libraryCommandId(epoch, "finalize") },
                  ),
                  "import",
                ),
                epoch,
              ),
            ),
            Match.when("receipt", () =>
              within(
                actor(
                  libraries.send(
                    owner,
                    new ProposeSkill({ name: "Changed", body: "must return original" }),
                    { commandId: libraryCommandId(1, "one") },
                  ),
                  "owner",
                ),
                epoch,
              ),
            ),
            Match.when("propose", () =>
              admitted(
                actor(
                  libraries.send(
                    owner,
                    new ProposeSkill({ name: input.name ?? "Skill", body: input.body ?? "body" }),
                    { commandId: libraryCommandId(epoch, input.id ?? "propose") },
                  ),
                  "owner",
                ),
                epoch,
              ),
            ),
            Match.when("state", () => admitted(libraries.state(owner), epoch)),
            Match.when("import-state", () => within(libraries.state(owner), epoch)),
            Match.when("import-detail", () =>
              within(
                details.query(skillDetailKey(owner, SkillId.make(input.skillId ?? "missing")), {
                  atLeast: {
                    stream: Aggregate.streamOf(Library.ref(owner)),
                    version: input.revision ?? 1,
                  },
                  timeout: "70 seconds",
                }),
                epoch,
              ),
            ),
            Match.when("accept", () =>
              admitted(
                actor(
                  libraries.send(
                    owner,
                    new AcceptSkill({
                      skillId: SkillId.make(input.skillId ?? "missing"),
                      expectedProposalRevision: input.revision ?? 0,
                    }),
                    { commandId: libraryCommandId(epoch, input.id ?? "accept") },
                  ),
                  "owner",
                ),
                epoch,
              ),
            ),
            Match.when("remove", () =>
              admitted(
                actor(
                  libraries.send(
                    owner,
                    new RemoveSkill({
                      skillId: SkillId.make(input.skillId ?? "missing"),
                      expectedProposalRevision: input.revision ?? 0,
                    }),
                    { commandId: libraryCommandId(epoch, input.id ?? "remove") },
                  ),
                  "owner",
                ),
                epoch,
              ),
            ),
            Match.when("detail", () =>
              admitted(
                actor(
                  details.query(skillDetailKey(owner, SkillId.make(input.skillId ?? "missing")), {
                    atLeast: input.atLeast,
                    timeout: "15 seconds",
                  }),
                  "owner",
                ),
                epoch,
              ),
            ),
            Match.when("gate", () => fixture().gate(input.key ?? null)),
          )
          .pipe(
            Match.when("home-write", () =>
              home().write(input.kind ?? "skill", input.id ?? "missing", input.body ?? ""),
            ),
            Match.when("home-insert", () =>
              home().insert(input.kind ?? "skill", input.id ?? "missing", input.body ?? ""),
            ),
            Match.when("home-read", () =>
              home().read(input.kind ?? "skill", input.id ?? "missing"),
            ),
            Match.when("home-remove", () =>
              home().remove(input.kind ?? "skill", input.id ?? "missing"),
            ),
            Match.when("home-status", () => home().libraryLegacyStatus()),
            Match.when("home-migrate", () => home().libraryMigrate(input.id ?? "legacy-inventory")),
            Match.when("home-turn", () =>
              home().prepareTurn(input.id ?? "turn", "cat", input.body ?? "healthy"),
            ),
            Match.when("wait", () => fixture().wait(input.key ?? "missing")),
            Match.when("inventory", () =>
              control.inventory(input.lineage ?? "library-1", input.after ?? 0),
            ),
            Match.when("freeze", () => control.beginFreeze(operationId)),
            Match.when("freeze-ack", () =>
              control.acknowledgeFreeze(
                operationId,
                input.ordinal ?? 0,
                input.before ?? "",
                input.nonce ?? null,
              ),
            ),
            Match.when("image-record", () =>
              control.recordImage(
                operationId,
                input.ordinal ?? 0,
                LibraryObjectImage.make(
                  input.image ?? { digest: "0".repeat(64), kvCount: 0, sqlCount: 0 },
                ),
              ),
            ),
            Match.when("seal", () => control.seal(operationId, 2, "d".repeat(64))),
            Match.when("prepare", () =>
              control.prepareRestore(operationId, input.setId ?? operationId),
            ),
            Match.when("loaded", () =>
              control.recordLoaded(
                operationId,
                input.ordinal ?? 0,
                input.after ?? 0,
                LibraryObjectImage.make(
                  input.image ?? { digest: "0".repeat(64), kvCount: 0, sqlCount: 0 },
                ),
              ),
            ),
          )
          .pipe(
            Match.when("activate", () => control.beginActivation(operationId)),
            Match.when("active-ack", () =>
              control.acknowledgeActive(operationId, input.ordinal ?? 0),
            ),
            Match.when("publish", () =>
              control.publish(operationId, 2).pipe(Effect.tap(() => control.complete(operationId))),
            ),
            Match.when("restore", () =>
              coordinator.restore({
                operationId,
                setId: input.setId ?? operationId,
                codeDigest: "d".repeat(64),
              }),
            ),
            Match.when("global-begin", () => root().begin(input.id ?? "unrelated-home")),
            Match.when("global-complete", () => root().complete(input.id ?? "unrelated-home")),
            Match.when("global-status", () => root().status()),
            Match.when("admin", () =>
              administration.call(
                LibraryObjectRef.make(input.ref!),
                LibraryAdminRequest.make(input.request!),
              ),
            ),
            Match.when("register", () =>
              Effect.gen(function* () {
                const className = LibraryObjectClass.make(input.className!);
                const lineage = input.lineage ?? "library-1";
                const logicalName = input.logicalName ?? "owner";

                const ref = yield* administration.derive(className, lineage, logicalName);

                const ordinal = yield* control.register(
                  ref,
                  lineage === "library-1" ? null : operationId,
                );

                return { ...ref, ordinal };
              }),
            ),
            Match.when("workflow-create", () =>
              input.missing
                ? queued.create({ id: input.id, params: { targets: [] } }).pipe(Effect.as(null))
                : queued
                    .create({
                      id: input.id,
                      params: { targets: [], recovery: hooks.backfillInput(model) },
                    })
                    .pipe(Effect.as(null)),
            ),
            Match.when("workflow-start", () =>
              queued
                .get(input.id ?? "queued")
                .pipe(
                  Effect.flatMap((instance) => instance.sendEvent({ type: "start", payload: {} })),
                ),
            ),
            Match.when("workflow-result", () =>
              queued
                .get(input.id ?? "queued")
                .pipe(Effect.flatMap((instance) => instance.status())),
            ),
            Match.when("descriptor", () =>
              Effect.sync(() => hooks.backfillInput({ ...model, version: undefined })),
            ),
            Match.exhaustive,
          );

        yield* Effect.sync(() => console.log("fixture action", input.action));

        const result = yield* Effect.exit(
          action.pipe(
            Effect.timeout(
              input.action === "restore" ||
                input.action === "home-migrate" ||
                input.action === "import-detail"
                ? "120 seconds"
                : "8 seconds",
            ),
          ),
        );

        yield* Effect.sync(() =>
          console.log("fixture action result", input.action, Exit.isSuccess(result)),
        );

        return yield* HttpServerResponse.json(
          Exit.isSuccess(result)
            ? { ok: true, value: result.value ?? null }
            : { ok: false, error: Cause.pretty(result.cause) },
        );
      }),
    };
  }).pipe(Effect.provide(ApplicationLive)),
) {}
