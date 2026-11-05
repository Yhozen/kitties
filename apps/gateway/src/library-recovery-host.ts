import {
  RecoveryHooks,
  scopeRecoveryMembers,
  recoveryNamespaceCalls,
  type RecoveryHooksService,
  type RecoveryModel,
  type RecoveryNamespace,
  type RecoveryObject,
} from "@alchemy.run/cloudflare/Domain/RecoveryHooks";
import { DurableObjectState } from "@alchemy.run/cloudflare/Workers/DurableObjectState";
import { ensureAlarmTables } from "@alchemy.run/cloudflare/Workers/DurableObjectAlarmStorage";
import { task } from "@alchemy.run/cloudflare/Workflows/Workflow";
import type { CallbackFactory, CallbackOptions } from "alchemy/Callback";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  LibraryExportAuthorization,
  LibraryLineage,
  LibraryObjectClass,
  LibraryObjectRef,
  LibraryObjectImage,
  LibraryRecoveryError,
  LibraryRecoveryState,
  RecoveryOperationId,
  RecoveryOrdinal,
  RegisteredLibraryObject,
} from "./library-recovery-records.ts";
import {
  LibraryObjectAdmin,
  LibraryAdminRequest,
  LibraryAdminReply,
} from "./library-object-admin.ts";
import { LibraryImageError } from "./library-image.ts";
import { LibraryRequestScope } from "./library-session.ts";

/** Adapter supplied by RecoveryDO; all Effects must reach its authoritative journal. */
export class LibraryRecoveryControl extends Context.Service<
  LibraryRecoveryControl,
  {
    readonly status: Effect.Effect<LibraryRecoveryState | null, LibraryRecoveryError>;
    readonly authorizeCapture: (
      operationId: string,
      captureId: string,
      ordinal: number,
    ) => Effect.Effect<LibraryObjectImage, LibraryRecoveryError>;
    readonly authorizeExport: (
      grantId: string,
      captureId: string,
      ordinal: number,
    ) => Effect.Effect<LibraryExportAuthorization, LibraryRecoveryError>;
    readonly resolve: (epoch: number) => Effect.Effect<string, LibraryRecoveryError>;
    readonly register: (
      ref: LibraryObjectRef,
      operationId: string | null,
    ) => Effect.Effect<number, LibraryRecoveryError>;
    readonly lookup: (
      className: string,
      nativeId: string,
    ) => Effect.Effect<RegisteredLibraryObject | null, LibraryRecoveryError>;
  }
>()("@kitties/gateway/LibraryRecoveryControl") {}

/** Server-only bridge over validated registry refs; never exposed as a client namespace RPC. */
export class LibraryObjectAdministration extends Context.Service<
  LibraryObjectAdministration,
  {
    readonly derive: (
      className: typeof LibraryObjectClass.Type,
      lineage: string,
      logicalName: string,
    ) => Effect.Effect<LibraryObjectRef, LibraryRecoveryError>;
    readonly call: (
      ref: LibraryObjectRef,
      request: LibraryAdminRequest,
    ) => Effect.Effect<LibraryAdminReply, LibraryRecoveryError>;
  }
>()("@kitties/gateway/LibraryObjectAdministration") {}

export const LibraryBackfillScope = Schema.Struct({
  modelName: Schema.Literal("LibraryModel"),
  layout: Schema.Literal(0),
  libraryId: Schema.Literal("owner"),
  epoch: RecoveryOrdinal,
  lineage: LibraryLineage,
});

export type LibraryBackfillScope = typeof LibraryBackfillScope.Type;

export const LibraryRecoveryPin = Schema.Struct({
  lineage: LibraryLineage,
  operationId: Schema.NullOr(RecoveryOperationId),
});

export type LibraryRecoveryPin = typeof LibraryRecoveryPin.Type;

/** Internal object/coordinator scope takes precedence over mutable request services. */
const PinnedLibrary = Context.Reference<LibraryRecoveryPin | null>(
  "@kitties/gateway/PinnedLibrary",
  {
    defaultValue: () => null,
  },
);

export const withLibraryRecoveryPin = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  pin: LibraryRecoveryPin,
) => Effect.provideService(effect, PinnedLibrary, Object.freeze(LibraryRecoveryPin.make(pin)));

const descriptor = (value: RecoveryModel): void => {
  if (value.modelName !== "LibraryModel" || value.version !== 0 || value.jurisdiction !== undefined)
    throw new LibraryRecoveryError({ reason: "invalid" });
};

const objectDescriptor = (value: RecoveryObject) => {
  descriptor(value);

  return Schema.decodeUnknownSync(LibraryObjectClass)(value.className);
};

export const libraryPhysicalName = (lineage: string, logicalName: string): string =>
  `r:${LibraryLineage.make(lineage)}:${logicalName}`;

/** Construct once per Worker and reuse this exact Layer in the provider factory. */
export const libraryRecoveryHooksLayer = (rollout: LibraryBackfillScope) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const control = yield* LibraryRecoveryControl;
      const configured = Object.freeze(LibraryBackfillScope.make(rollout));
      const namespaces = new Map<typeof LibraryObjectClass.Type, RecoveryNamespace>();

      const pinForCall = Effect.gen(function* () {
        const pin = yield* PinnedLibrary;

        if (pin !== null) return pin;
        const request = yield* Effect.serviceOption(LibraryRequestScope);

        if (Option.isNone(request) || request.value.libraryId !== "owner")
          return yield* new LibraryRecoveryError({ reason: "fenced" });
        const lineage = yield* control.resolve(request.value.epoch);

        return LibraryRecoveryPin.make({ lineage, operationId: null });
      });

      const discover = (
        object: RecoveryObject,
        namespace: RecoveryNamespace,
        logicalName: string,
      ) =>
        Effect.gen(function* () {
          const className = objectDescriptor(object);
          const pin = yield* pinForCall;
          const state = yield* control.status;

          // A staged pin stays on that exact lineage after publication; it never follows CURRENT.
          const operationId =
            state?.phase === "ready" && state.lineage === pin.lineage ? null : pin.operationId;

          const physicalName = libraryPhysicalName(pin.lineage, logicalName);
          const nativeId = namespace.idFromName(physicalName).toString();

          const ref = LibraryObjectRef.make({
            modelName: "LibraryModel",
            layout: 0,
            className,
            lineage: pin.lineage,
            logicalName,
            physicalName,
            nativeId,
          });

          yield* control.register(ref, operationId);

          return {
            physicalName,
            scope: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              withLibraryRecoveryPin(effect, { lineage: pin.lineage, operationId }),
          };
        });

      const namespaceHook: RecoveryHooksService["namespace"] = (object, next) => {
        const className = objectDescriptor(object);
        namespaces.set(className, next);

        return {
          // Synchronous native identity cannot consult request authority. Admin derives IDs from validated refs instead.
          idFromName: () => {
            throw new LibraryRecoveryError({ reason: "fenced" });
          },
          jurisdiction: () => {
            throw new LibraryRecoveryError({ reason: "invalid" });
          },
          getByName: recoveryNamespaceCalls(next, (name) =>
            discover(object, next, name).pipe(Effect.orDie),
          ),
        };
      };

      const objectHook: RecoveryHooksService["object"] = (object, next) =>
        Effect.gen(function* () {
          const className = objectDescriptor(object);
          const state = yield* DurableObjectState;
          const nativeId = state.id.toString();

          const inspect = Effect.gen(function* () {
            const identity = yield* control.lookup(className, nativeId).pipe(Effect.orDie);
            const recovery = yield* control.status.pipe(Effect.orDie);

            return { identity, recovery };
          });

          const inspection = yield* inspect;
          const raw = state.raw.storage;

          const admin = yield* LibraryObjectAdmin.pipe(
            Effect.provide(
              LibraryObjectAdmin.layer({
                ...inspection,
                refresh: inspect,
                authorizeCapture: (operationId, captureId) =>
                  Effect.gen(function* () {
                    const source = yield* inspect;

                    if (source.identity === null)
                      return yield* new LibraryImageError({ reason: "conflict" });

                    return yield* control
                      .authorizeCapture(operationId, captureId, source.identity.ordinal)
                      .pipe(
                        Effect.mapError(
                          (error) =>
                            new LibraryImageError({
                              reason: error.reason === "storage" ? "storage" : "conflict",
                            }),
                        ),
                      );
                  }),
                authorizeExport: (grantId, captureId) =>
                  Effect.gen(function* () {
                    const source = yield* inspect;

                    if (source.identity === null)
                      return yield* new LibraryImageError({ reason: "conflict" });

                    return yield* control
                      .authorizeExport(grantId, captureId, source.identity.ordinal)
                      .pipe(
                        Effect.mapError(
                          (error) =>
                            new LibraryImageError({
                              reason: error.reason === "storage" ? "storage" : "conflict",
                            }),
                        ),
                      );
                  }),
                storage: {
                  sql: raw.sql,
                  kv: raw.kv,
                  transaction: (body) => raw.transactionSync(body),
                  prepareScheduler: ensureAlarmTables(raw),
                  alarm: Effect.tryPromise({
                    try: () => raw.getAlarm(),
                    catch: () => new LibraryImageError({ reason: "storage" }),
                  }),
                  clearAlarm: Effect.tryPromise({
                    try: () => raw.deleteAlarm(),
                    catch: () => new LibraryImageError({ reason: "storage" }),
                  }),
                  setAlarm: (at) =>
                    Effect.tryPromise({
                      try: () => raw.setAlarm(at),
                      catch: () => new LibraryImageError({ reason: "storage" }),
                    }),
                },
                closeSockets: () => {
                  for (const socket of state.raw.getWebSockets())
                    socket.close(1012, "Library recovery");
                },
                evict: () => state.raw.abort("Library recovery eviction", { retryAlarm: false }),
              }),
            ),
            Effect.orDie,
          );

          // Do not evaluate either provider construction phase for unknown/frozen/staging objects.
          if (!admin.allowed || inspection.identity === null)
            return Effect.succeed({ libraryAdmin: admin.libraryAdmin });

          const pin = Object.freeze({
            lineage: inspection.identity.lineage,
            operationId: inspection.recovery?.operationId ?? null,
          });

          const inner = yield* withLibraryRecoveryPin(next, pin);

          return Effect.gen(function* () {
            const runtime = yield* RuntimeContext;
            const callbacks = new Set<string>();
            const factory = runtime.makeCallback;

            const makeCallback: CallbackFactory = <Payload, E, R>(
              name: string,
              handler: (payload: Payload) => Effect.Effect<unknown, E, R>,
              options?: CallbackOptions,
            ) => {
              if (factory === undefined)
                return Effect.die(new LibraryRecoveryError({ reason: "invalid" }));

              return factory<Payload, E, R>(
                name,
                (payload) =>
                  admin.beforeInvoke.pipe(
                    Effect.andThen(withLibraryRecoveryPin(handler(payload), pin)),
                  ),
                options,
              ).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    callbacks.add(name);
                  }),
                ),
              );
            };

            const members = yield* withLibraryRecoveryPin(inner, pin).pipe(
              Effect.provideService(RuntimeContext, { ...runtime, makeCallback }),
            );

            yield* admin.afterInitialize(callbacks).pipe(Effect.orDie);

            const wrapped = scopeRecoveryMembers(
              members,
              <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                admin.beforeInvoke.pipe(Effect.andThen(withLibraryRecoveryPin(effect, pin))),
            );

            return { ...wrapped, libraryAdmin: admin.libraryAdmin };
          });
        });

      const hooks = RecoveryHooks.of({
        namespace: namespaceHook,
        object: objectHook,
        backfillInput: (model) => {
          descriptor(model);

          return configured;
        },
        backfill: (model, input, next) =>
          Effect.gen(function* () {
            descriptor(model);

            const recorded = yield* Schema.decodeUnknownEffect(LibraryBackfillScope)(input).pipe(
              Effect.orDie,
            );

            const lineage = yield* control.resolve(recorded.epoch).pipe(Effect.orDie);
            const state = yield* control.status.pipe(Effect.orDie);

            if (
              lineage !== recorded.lineage ||
              state?.lineage !== lineage ||
              !["ready", "importing"].includes(state.phase)
            )
              return yield* Effect.die(new LibraryRecoveryError({ reason: "fenced" }));
            const scope = yield* task("LibraryRecoveryScopeV1", Effect.succeed(recorded));

            return yield* withLibraryRecoveryPin(next, {
              lineage: scope.lineage,
              operationId: null,
            });
          }),
      });

      const derive: LibraryObjectAdministration["Service"]["derive"] = (
        className,
        lineage,
        logicalName,
      ) =>
        Effect.try({
          try: () => {
            const namespace = namespaces.get(LibraryObjectClass.make(className));

            if (namespace === undefined) throw new LibraryRecoveryError({ reason: "fenced" });
            const physicalName = libraryPhysicalName(lineage, logicalName);

            return LibraryObjectRef.make({
              modelName: "LibraryModel",
              layout: 0,
              className,
              lineage,
              logicalName,
              physicalName,
              nativeId: namespace.idFromName(physicalName).toString(),
            });
          },
          catch: (error) =>
            Schema.is(LibraryRecoveryError)(error)
              ? error
              : new LibraryRecoveryError({ reason: "invalid" }),
        });

      const call: LibraryObjectAdministration["Service"]["call"] = (unverified, request) =>
        Effect.gen(function* () {
          const ref = yield* Schema.decodeUnknownEffect(LibraryObjectRef)(unverified).pipe(
            Effect.mapError(() => new LibraryRecoveryError({ reason: "invalid" })),
          );

          const known = yield* control.lookup(ref.className, ref.nativeId);

          if (
            known === null ||
            known.physicalName !== ref.physicalName ||
            known.lineage !== ref.lineage ||
            known.logicalName !== ref.logicalName
          )
            return yield* new LibraryRecoveryError({ reason: "fenced" });
          const namespace = namespaces.get(ref.className);

          if (
            namespace === undefined ||
            namespace.idFromName(ref.physicalName).toString() !== ref.nativeId
          )
            return yield* new LibraryRecoveryError({ reason: "fenced" });

          const calls = recoveryNamespaceCalls(namespace, () =>
            Effect.succeed({
              physicalName: ref.physicalName,
              scope: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
            }),
          );

          const reply = yield* calls(ref.logicalName).libraryAdmin(request);

          return yield* Schema.decodeUnknownEffect(LibraryAdminReply)(reply).pipe(
            Effect.mapError(() => new LibraryRecoveryError({ reason: "invalid" })),
          );
        });

      return Context.make(RecoveryHooks, hooks).pipe(
        Context.add(LibraryObjectAdministration, { call, derive }),
      );
    }),
  );
