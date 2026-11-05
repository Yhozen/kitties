import * as Aggregate from "@alchemy.run/domain/Aggregate";
import { FinalizeLibraryImport } from "@kitties/domain/Library/FinalizeLibraryImport.command";
import { ImportSkill } from "@kitties/domain/Library/ImportSkill.command";
import { Library } from "@kitties/domain/Library/Library.aggregate";
import {
  FinalizedImport,
  LibraryState,
  reservedCatalogueBytes,
} from "@kitties/domain/Library/Library.state";
import { SkillDetail } from "@kitties/domain/Library/SkillDetail.view";
import { importedOrdinal, skillDetailKey } from "@kitties/domain/Library/Skill.id";
import {
  FrozenSkill,
  ImportInventoryId,
  MAX_LIBRARY_JSON_BYTES,
  SkillMetadata,
  SkillTimestamp,
} from "@kitties/domain/Library/Skill";
import { LibraryActor } from "@kitties/domain/LibraryActor.context";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  LegacyInventory,
  LegacyInventoryRow,
  LibraryLegacyStore,
  LibraryMigrationControl,
} from "./library-legacy-store.ts";
import {
  LibraryRecoveryError,
  LibraryRecoveryState,
  RecoveryOrdinal,
} from "./library-recovery-records.ts";
import { LIBRARY_OWNER, LibraryRequestScope } from "./library-session.ts";

export class LibraryMigrationError extends Schema.TaggedError<
  LibraryMigrationError,
  { readonly brand: unique symbol }
>()("LibraryMigrationError", {
  stage: Schema.Literals([
    "inventory",
    "control",
    "validation",
    "import",
    "finalize",
    "projection",
    "timeout",
  ]),
  reason: Schema.Literals([
    "invalid",
    "conflict",
    "limit",
    "storage",
    "fenced",
    "incomplete",
    "rejected",
    "timeout",
  ]),
  ordinal: Schema.optional(RecoveryOrdinal),
  rejection: Schema.optional(Schema.String),
}) {}

const Policy = Schema.Struct({
  totalMs: Schema.Int.check(Schema.isGreaterThan(0)),
  controlMs: Schema.Int.check(Schema.isGreaterThan(0)),
  detailMs: Schema.Int.check(Schema.isGreaterThan(0)),
});

export const LibraryMigrationPolicy = Context.Reference<typeof Policy.Type>(
  "@kitties/gateway/LibraryMigrationPolicy",
  {
    defaultValue: () => ({ totalMs: 120000, controlMs: 5000, detailMs: 5000 }),
  },
);

export const LibraryMigrationResult = Schema.Struct({
  inventoryId: ImportInventoryId,
  epoch: RecoveryOrdinal,
  importedCount: RecoveryOrdinal,
  fallbackCount: RecoveryOrdinal,
  allocatorFloor: RecoveryOrdinal,
  alreadyReady: Schema.Boolean,
});

export type LibraryMigrationResult = typeof LibraryMigrationResult.Type;

const LegacySkill = Schema.Struct({
  ...FrozenSkill.fields,
  updatedAt: Schema.optional(SkillTimestamp),
});

const sameMetadata = Schema.toEquivalence(Schema.Array(SkillMetadata));
const sameSkill = Schema.toEquivalence(FrozenSkill);

const storageError = (stage: LibraryMigrationError["stage"]) =>
  new LibraryMigrationError({ stage, reason: "storage" });

const frozenSkill = Effect.fnUntraced(function* (row: LegacyInventoryRow) {
  const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LegacySkill), {
    onExcessProperty: "error",
  })(row.body).pipe(
    Effect.mapError(
      () =>
        new LibraryMigrationError({ stage: "validation", reason: "invalid", ordinal: row.ordinal }),
    ),
  );

  if (value.id !== row.id || importedOrdinal(value.id) === "invalid")
    return yield* new LibraryMigrationError({
      stage: "validation",
      reason: "invalid",
      ordinal: row.ordinal,
    });

  return {
    skill: FrozenSkill.make({ ...value, updatedAt: value.updatedAt ?? row.updatedAt }),
    fallback: value.updatedAt === undefined,
  };
});

const forInventory = Effect.fnUntraced(function* <E, R>(
  store: LibraryLegacyStore["Service"],
  inventory: LegacyInventory,
  visit: (row: LegacyInventoryRow) => Effect.Effect<void, E, R>,
) {
  let after = 0;

  while (after < inventory.rowCount) {
    const rows = yield* store.page(inventory.inventoryId, after).pipe(
      Effect.mapError(
        (error) =>
          new LibraryMigrationError({
            stage: "inventory",
            reason: Match.value(error.reason).pipe(
              Match.when("limit", () => "limit" as const),
              Match.when("invalid", () => "invalid" as const),
              Match.orElse(() => "storage" as const),
            ),
            ordinal: error.ordinal,
          }),
      ),
    );

    if (rows.length === 0 || rows.length > 64)
      return yield* new LibraryMigrationError({ stage: "inventory", reason: "incomplete" });

    for (const row of rows) {
      if (row.ordinal !== after + 1 || row.ordinal > inventory.rowCount)
        return yield* new LibraryMigrationError({ stage: "inventory", reason: "incomplete" });
      yield* visit(row);
      after = row.ordinal;
    }
  }
});

const metadata = (skill: FrozenSkill, revision: number): SkillMetadata => ({
  id: skill.id,
  name: skill.name,
  status: skill.status,
  createdAt: skill.createdAt,
  updatedAt: skill.updatedAt,
  proposalRevision: revision,
  detailRevision: revision,
});

const floorOf = (skills: ReadonlyArray<SkillMetadata>) =>
  skills.reduce((floor, skill) => {
    const ordinal = importedOrdinal(skill.id);

    return ordinal === "invalid" ? Number.NaN : Math.max(floor, ordinal);
  }, 0);

const validateProgress = (
  state: LibraryState,
  inventory: LegacyInventory,
  expected: ReadonlyArray<SkillMetadata>,
) => {
  const count = state.importProgress.importedCount;
  const finalized = Schema.is(FinalizedImport)(state.importProgress);

  return (
    count <= inventory.rowCount &&
    (state.importProgress.inventoryId === inventory.inventoryId ||
      (state.importProgress.inventoryId === null && count === 0)) &&
    (!finalized || count === inventory.rowCount) &&
    state.catalogueRevision === count + (finalized ? 1 : 0) &&
    sameMetadata(state.active, expected.slice(0, count)) &&
    state.highWater === floorOf(expected.slice(0, count))
  );
};

export class LibraryMigration extends Context.Service<
  LibraryMigration,
  {
    readonly run: (
      inventoryId: string,
    ) => Effect.Effect<LibraryMigrationResult, LibraryMigrationError>;
  }
>()("@kitties/gateway/LibraryMigration") {
  static readonly layer = Layer.effect(
    LibraryMigration,
    Effect.gen(function* () {
      const legacy = yield* LibraryLegacyStore;
      const control = yield* LibraryMigrationControl;
      const libraries = yield* Library;
      const details = yield* SkillDetail;

      const policy = yield* Schema.decodeUnknownEffect(Policy)(yield* LibraryMigrationPolicy).pipe(
        Effect.mapError(
          () => new LibraryMigrationError({ stage: "validation", reason: "invalid" }),
        ),
      );

      const controlCall = <A>(effect: Effect.Effect<A, LibraryRecoveryError>) =>
        effect.pipe(
          Effect.mapError(
            (error) =>
              new LibraryMigrationError({
                stage: "control",
                reason: Match.value(error.reason).pipe(
                  Match.when("uninitialized", () => "fenced" as const),
                  Match.when("exhausted", () => "limit" as const),
                  Match.orElse((reason) => reason),
                ),
              }),
          ),
          Effect.catchDefect(() => storageError("control")),
          Effect.timeoutOrElse({
            duration: policy.controlMs,
            orElse: () => new LibraryMigrationError({ stage: "control", reason: "timeout" }),
          }),
        );

      const current = controlCall(control.status).pipe(
        Effect.flatMap((state) =>
          Schema.decodeUnknownEffect(Schema.NullOr(LibraryRecoveryState))(state).pipe(
            Effect.mapError(() => storageError("control")),
          ),
        ),
      );

      const inventoryCall = (inventoryId: string, freeze: boolean) =>
        (freeze ? legacy.freeze(inventoryId) : legacy.inventory(inventoryId)).pipe(
          Effect.mapError(
            (error) =>
              new LibraryMigrationError({
                stage: "inventory",
                reason: Match.value(error.reason).pipe(
                  Match.when("limit", () => "limit" as const),
                  Match.when("conflict", () => "conflict" as const),
                  Match.orElse(() => "storage" as const),
                ),
              }),
          ),
        );

      return LibraryMigration.of({
        run: Effect.fnUntraced(
          function* (inventoryId) {
            if (!Schema.is(ImportInventoryId)(inventoryId))
              return yield* new LibraryMigrationError({ stage: "validation", reason: "invalid" });
            const before = yield* current;

            if (before !== null && before.inventoryId !== inventoryId)
              return yield* new LibraryMigrationError({ stage: "control", reason: "conflict" });

            if (before !== null && before.phase !== "ready" && before.phase !== "importing")
              return yield* new LibraryMigrationError({ stage: "control", reason: "fenced" });
            const inventory = yield* inventoryCall(inventoryId, before === null);

            if (before?.phase === "ready")
              return {
                inventoryId,
                epoch: before.epoch,
                importedCount: inventory.rowCount,
                fallbackCount: inventory.fallbackCount,
                allocatorFloor: before.allocatorFloor,
                alreadyReady: true,
              };
            const expected: Array<SkillMetadata> = [];

            const reservation: LibraryState = {
              active: [],
              highWater: 0,
              catalogueRevision: 0,
              importProgress: FinalizedImport.make({
                inventoryId,
                importedCount: inventory.rowCount,
              }),
            };

            const emptyBytes = reservedCatalogueBytes(reservation);
            let catalogueBytes = emptyBytes;
            let fallbackCount = 0;
            let bytes = 0;
            yield* forInventory(legacy, inventory, (row) =>
              Effect.gen(function* () {
                const decoded = yield* frozenSkill(row);
                const entry = metadata(decoded.skill, row.ordinal);

                // JSON arrays add each encoded element and one comma after the first.
                // Reuse the Domain reservation policy without re-encoding every prefix.
                catalogueBytes +=
                  reservedCatalogueBytes({ ...reservation, active: [entry] }) -
                  emptyBytes +
                  Number(expected.length > 0);
                expected.push(entry);
                fallbackCount += Number(decoded.fallback);
                bytes += new TextEncoder().encode(row.body).byteLength;

                if (catalogueBytes > MAX_LIBRARY_JSON_BYTES)
                  return yield* new LibraryMigrationError({
                    stage: "validation",
                    reason: "limit",
                    ordinal: row.ordinal,
                  });
              }),
            );

            if (bytes !== inventory.bytes || fallbackCount !== inventory.fallbackCount)
              return yield* new LibraryMigrationError({ stage: "inventory", reason: "conflict" });

            const initialized = yield* controlCall(control.initialize(inventoryId)).pipe(
              Effect.flatMap((state) =>
                Schema.decodeUnknownEffect(LibraryRecoveryState)(state).pipe(
                  Effect.mapError(() => storageError("control")),
                ),
              ),
            );

            if (initialized.inventoryId !== inventoryId || initialized.phase !== "importing")
              return yield* new LibraryMigrationError({ stage: "control", reason: "fenced" });
            const scope = Object.freeze({ libraryId: LIBRARY_OWNER, epoch: initialized.epoch });

            const assertImport = Effect.gen(function* () {
              const actual = yield* current;

              if (
                actual === null ||
                actual.phase !== "importing" ||
                actual.inventoryId !== inventoryId ||
                actual.epoch !== scope.epoch ||
                actual.lineage !== initialized.lineage
              )
                return yield* new LibraryMigrationError({ stage: "control", reason: "fenced" });
            });

            const state = libraries
              .state(LIBRARY_OWNER)
              .pipe(Effect.catchDefect(() => storageError("import")));

            return yield* Effect.gen(function* () {
              yield* assertImport;
              const start = yield* state;

              if (!validateProgress(start, inventory, expected))
                return yield* new LibraryMigrationError({ stage: "import", reason: "conflict" });

              if (!Schema.is(FinalizedImport)(start.importProgress)) {
                yield* forInventory(legacy, inventory, (row) =>
                  Effect.gen(function* () {
                    if (row.ordinal <= start.importProgress.importedCount) return;
                    yield* assertImport;
                    const decoded = yield* frozenSkill(row);
                    yield* libraries
                      .send(LIBRARY_OWNER, new ImportSkill({ inventoryId, skill: decoded.skill }), {
                        commandId: `library:${scope.epoch}:import:${inventoryId}:${row.ordinal}`,
                      })
                      .pipe(
                        Effect.mapError(
                          (error) =>
                            new LibraryMigrationError({
                              stage: "import",
                              reason: "rejected",
                              ordinal: row.ordinal,
                              rejection: error._tag,
                            }),
                        ),
                        Effect.catchDefect(() => storageError("import")),
                      );
                  }),
                );
                yield* assertImport;
                const imported = yield* state;

                if (
                  !validateProgress(imported, inventory, expected) ||
                  imported.importProgress.importedCount !== inventory.rowCount
                )
                  return yield* new LibraryMigrationError({
                    stage: "finalize",
                    reason: "conflict",
                  });
                yield* libraries
                  .send(
                    LIBRARY_OWNER,
                    new FinalizeLibraryImport({
                      inventoryId,
                      expectedImportedCount: imported.importProgress.importedCount,
                      expectedHighWater: imported.highWater,
                    }),
                    { commandId: `library:${scope.epoch}:import:${inventoryId}:finalize` },
                  )
                  .pipe(
                    Effect.mapError(
                      (error) =>
                        new LibraryMigrationError({
                          stage: "finalize",
                          reason: "rejected",
                          rejection: error._tag,
                        }),
                    ),
                    Effect.catchDefect(() => storageError("finalize")),
                  );
              }

              const finalized = yield* state;

              if (
                !Schema.is(FinalizedImport)(finalized.importProgress) ||
                !validateProgress(finalized, inventory, expected)
              )
                return yield* new LibraryMigrationError({ stage: "finalize", reason: "conflict" });
              // Query each immutable body at its recorded aggregate source version.
              // A view's local cursor is deliberately irrelevant to this verification.
              yield* forInventory(legacy, inventory, (row) =>
                Effect.gen(function* () {
                  const decoded = yield* frozenSkill(row);

                  const found = yield* details
                    .query(skillDetailKey(LIBRARY_OWNER, decoded.skill.id), {
                      atLeast: {
                        stream: Aggregate.streamOf(Library.ref(LIBRARY_OWNER)),
                        version: row.ordinal,
                      },
                      timeout: policy.detailMs,
                    })
                    .pipe(
                      Effect.mapError(
                        () =>
                          new LibraryMigrationError({
                            stage: "projection",
                            reason: "timeout",
                            ordinal: row.ordinal,
                          }),
                      ),
                      Effect.catchDefect(() => storageError("projection")),
                      Effect.timeoutOrElse({
                        duration: policy.detailMs,
                        orElse: () =>
                          new LibraryMigrationError({
                            stage: "projection",
                            reason: "timeout",
                            ordinal: row.ordinal,
                          }),
                      }),
                    );

                  const detail = Option.getOrNull(found);

                  if (
                    detail === null ||
                    detail.libraryId !== LIBRARY_OWNER ||
                    detail.proposalRevision !== row.ordinal ||
                    detail.detailRevision !== row.ordinal ||
                    !Schema.is(FrozenSkill)(detail) ||
                    !sameSkill(detail, decoded.skill)
                  )
                    return yield* new LibraryMigrationError({
                      stage: "projection",
                      reason: "conflict",
                      ordinal: row.ordinal,
                    });
                }),
              );
              yield* assertImport;

              const ready = yield* controlCall(
                control.finishImport(inventoryId, finalized.highWater),
              ).pipe(
                Effect.flatMap((state) =>
                  Schema.decodeUnknownEffect(LibraryRecoveryState)(state).pipe(
                    Effect.mapError(() => storageError("control")),
                  ),
                ),
              );

              if (
                ready.phase !== "ready" ||
                ready.inventoryId !== inventoryId ||
                ready.epoch !== scope.epoch ||
                ready.lineage !== initialized.lineage ||
                ready.allocatorFloor !== finalized.highWater
              )
                return yield* new LibraryMigrationError({ stage: "control", reason: "conflict" });

              return {
                inventoryId,
                epoch: scope.epoch,
                importedCount: inventory.rowCount,
                fallbackCount,
                allocatorFloor: finalized.highWater,
                alreadyReady: false,
              };
            }).pipe(
              Effect.provideService(LibraryRequestScope, scope),
              Effect.provideService(LibraryActor, {
                libraryId: LIBRARY_OWNER,
                authority: "import",
                importFinalized: false,
              }),
            );
          },
          Effect.timeoutOrElse({
            duration: policy.totalMs,
            orElse: () => new LibraryMigrationError({ stage: "timeout", reason: "timeout" }),
          }),
        ),
      });
    }),
  );
}
