import * as Cloudflare from "@alchemy.run/cloudflare";
import {
  RecoveryHooks,
  recoveryNamespaceCalls,
  scopeRecoveryMembers,
  type RecoveryNamespace,
} from "@alchemy.run/cloudflare/Domain/RecoveryHooks";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { LibraryAdminReply } from "../../../apps/gateway/src/library-object-admin.ts";
import { observeNativeProtection } from "./protection.ts";
import {
  LibraryObjectClass,
  LibraryObjectRef,
  LibraryRecoveryError,
} from "../../../apps/gateway/src/library-recovery-records.ts";
import { LibraryControl } from "../../../apps/gateway/src/library-control.ts";
import { LibraryArchiveProbe } from "./probe.ts";
import {
  encodeLibraryValue,
  libraryImageBytes,
  libraryImageDigest,
} from "../../../apps/gateway/src/library-image.ts";

const Inspection = Schema.Struct({
  alarm: Schema.NullOr(Schema.Number),
  callbacks: Schema.Int,
  scheduled: Schema.Int,
  localImages: Schema.Int,
  localRows: Schema.Int,
  localParts: Schema.Int,
  protectedDigest: Schema.optionalKey(Schema.String),
  otherCaptureDigest: Schema.optionalKey(Schema.String),
  selectedDigest: Schema.optionalKey(Schema.String),
});

const NativeRequest = Schema.Union([
  Schema.Struct({ action: Schema.Literal("inspect"), captureId: Schema.String }),
  Schema.Struct({ action: Schema.Literal("drop-local-buffer"), captureId: Schema.String }),
  Schema.Struct({ action: Schema.Literal("snapshot"), captureId: Schema.String }),
]);

/** Fixture-only introspection/loss simulation; never added to production admin RPC. */
export class ArchiveNativeObjects extends Context.Service<
  ArchiveNativeObjects,
  {
    readonly call: (
      ref: LibraryObjectRef,
      request: typeof NativeRequest.Type,
    ) => Effect.Effect<typeof Inspection.Type, LibraryRecoveryError>;
  }
>()("OwnedLibraryArchive/NativeObjects") {}

/** Requires the production hook Layer and augments only this isolated fixture. */
export const ArchiveFixtureHooks = Layer.effectContext(
  Effect.gen(function* () {
    const hooks = yield* RecoveryHooks;
    const control = yield* LibraryControl;
    const probes = yield* LibraryArchiveProbe;
    const probe = () => probes.getByName("probe");
    const namespaces = new Map<typeof LibraryObjectClass.Type, RecoveryNamespace>();
    const invalid = () => new LibraryRecoveryError({ reason: "fenced" });

    const fixtureHooks = RecoveryHooks.of({
      ...hooks,
      namespace: (descriptor, next) => {
        const className = Schema.decodeUnknownSync(LibraryObjectClass)(descriptor.className);
        namespaces.set(className, next);
        const scoped = hooks.namespace(descriptor, next);

        return className !== "LibraryModel.SkillDetailViewV1"
          ? scoped
          : {
              ...scoped,
              getByName: recoveryNamespaceCalls(scoped, (name) =>
                probe()
                  .checkDelivery(name)
                  .pipe(
                    Effect.orDie,
                    Effect.as({
                      physicalName: name,
                      scope: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
                    }),
                  ),
              ),
            };
      },
      object: (descriptor, next) =>
        Effect.gen(function* () {
          const state = yield* Cloudflare.DurableObjectState;
          const first = yield* hooks.object(descriptor, next);

          return first.pipe(
            Effect.map((members) => ({
              ...scopeRecoveryMembers(members, <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                Effect.gen(function* () {
                  const before = yield* observeNativeProtection(state.raw.storage).pipe(
                    Effect.orDie,
                  );

                  const value = yield* effect;

                  if (
                    Schema.is(LibraryAdminReply)(value) &&
                    (Predicate.isTagged(value, "PruneProgress") ||
                      Predicate.isTagged(value, "PruneStopped"))
                  ) {
                    const after = yield* observeNativeProtection(state.raw.storage).pipe(
                      Effect.orDie,
                    );

                    yield* probe()
                      .observeStep(state.id.toString(), {
                        kind: Predicate.isTagged(value, "PruneStopped") ? "stop" : "prune",
                        before,
                        after,
                      })
                      .pipe(Effect.orDie);
                  }

                  return value;
                }),
              ),
              archiveFixture: (request: typeof NativeRequest.Type) =>
                Effect.gen(function* () {
                  const input = yield* Schema.decodeUnknownEffect(NativeRequest)(request).pipe(
                    Effect.mapError(invalid),
                  );

                  const set = yield* control.recoverySet(input.captureId);
                  const completed = yield* control.captureCompletion(input.captureId);
                  const identity = yield* control.lookup(descriptor.className, state.id.toString());

                  if (set === null || completed === null || identity?.lineage !== set.sourceLineage)
                    return yield* invalid();
                  const sql = state.raw.storage.sql;

                  if (input.action === "drop-local-buffer")
                    yield* Effect.sync(() =>
                      state.raw.storage.transactionSync(() => {
                        sql.exec("DELETE FROM library_admin_parts WHERE id=?", input.captureId);
                        sql.exec("DELETE FROM library_admin_rows WHERE id=?", input.captureId);
                        sql.exec("DELETE FROM library_admin_images WHERE id=?", input.captureId);
                      }),
                    );

                  const count = (table: string, capture: boolean) => {
                    const exists = sql
                      .exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table)
                      .toArray().length;

                    if (exists === 0) return 0;

                    // Table identifiers come only from the five fixed calls below.
                    return sql
                      .exec<{ n: number }>(
                        `SELECT COUNT(*) AS n FROM ${table}${capture ? " WHERE id=?" : ""}`,
                        ...(capture ? [input.captureId] : []),
                      )
                      .one().n;
                  };

                  const alarm = yield* Effect.tryPromise({
                    try: () => state.raw.storage.getAlarm(),
                    catch: invalid,
                  });

                  const bounded = (text: string) => {
                    if (libraryImageBytes(text) > 4 * 1024 * 1024)
                      throw new LibraryRecoveryError({ reason: "exhausted" });

                    return text;
                  };

                  const tableRows = (table: string, selection?: "other" | "selected") => {
                    if (
                      sql
                        .exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table)
                        .toArray().length === 0
                    )
                      return [];

                    const rows = sql
                      .exec(
                        `SELECT * FROM ${table}${selection ? ` WHERE id${selection === "other" ? "!=" : "="}?` : ""} ORDER BY rowid LIMIT 1025`,
                        ...(selection ? [input.captureId] : []),
                      )
                      .toArray();

                    if (rows.length > 1024) throw new LibraryRecoveryError({ reason: "exhausted" });

                    return rows;
                  };

                  const hashes =
                    input.action !== "snapshot"
                      ? {}
                      : yield* Effect.gen(function* () {
                          const kv = [...state.raw.storage.kv.list({ limit: 1025 })];

                          if (kv.length > 1024)
                            return yield* new LibraryRecoveryError({ reason: "exhausted" });

                          const protectedState = {
                            kv,
                            alarm,
                            tables: [
                              "alchemy_alarm_callbacks",
                              "alchemy_alarm_schema",
                              "alchemy_scheduled_events",
                              "library_admin_guard",
                              "library_admin_hold_alchemy_alarm_callbacks",
                              "library_admin_hold_alchemy_alarm_schema",
                              "library_admin_hold_alchemy_scheduled_events",
                            ].map((table) => [table, tableRows(table)]),
                          };

                          const captures = (selection: "other" | "selected") =>
                            [
                              "library_admin_images",
                              "library_admin_rows",
                              "library_admin_parts",
                            ].map((table) => [table, tableRows(table, selection)]);

                          const digest = (text: string) =>
                            libraryImageDigest(bounded(text)).pipe(
                              Effect.mapError(
                                () => new LibraryRecoveryError({ reason: "storage" }),
                              ),
                            );

                          return {
                            protectedDigest: yield* digest(encodeLibraryValue(protectedState)),
                            otherCaptureDigest: yield* digest(
                              encodeLibraryValue(captures("other")),
                            ),
                            selectedDigest: yield* digest(encodeLibraryValue(captures("selected"))),
                          };
                        });

                  return {
                    ...hashes,
                    alarm,
                    callbacks: count("alchemy_alarm_callbacks", false),
                    scheduled: count("alchemy_scheduled_events", false),
                    localImages: count("library_admin_images", true),
                    localRows: count("library_admin_rows", true),
                    localParts: count("library_admin_parts", true),
                  };
                }),
            })),
          );
        }),
    });

    const call: ArchiveNativeObjects["Service"]["call"] = (ref, request) =>
      Effect.gen(function* () {
        const known = yield* control.lookup(ref.className, ref.nativeId);
        const namespace = namespaces.get(ref.className);

        if (
          known === null ||
          namespace === undefined ||
          known.physicalName !== ref.physicalName ||
          known.lineage !== ref.lineage ||
          namespace.idFromName(ref.physicalName).toString() !== ref.nativeId
        )
          return yield* invalid();

        const calls = recoveryNamespaceCalls(namespace, () =>
          Effect.succeed({
            physicalName: ref.physicalName,
            scope: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
          }),
        );

        const reply = yield* calls(ref.logicalName).archiveFixture(request);

        return yield* Schema.decodeUnknownEffect(Inspection)(reply).pipe(Effect.mapError(invalid));
      });

    return Context.make(RecoveryHooks, fixtureHooks).pipe(
      Context.add(ArchiveNativeObjects, { call }),
    );
  }),
);
