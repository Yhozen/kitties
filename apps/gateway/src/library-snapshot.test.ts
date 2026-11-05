import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as InMemory from "@alchemy.run/domain/InMemory";
import { Library } from "@kitties/domain/Library/Library.aggregate";
import { LibraryModel } from "@kitties/domain/Library.model";
import { LibraryActor } from "@kitties/domain/LibraryActor.context";
import { FinalizeLibraryImport } from "@kitties/domain/Library/FinalizeLibraryImport.command";
import { ProposeSkill } from "@kitties/domain/Library/ProposeSkill.command";
import { AcceptSkill } from "@kitties/domain/Library/AcceptSkill.command";
import {
  FinalizedImport,
  initialLibrary,
  type LibraryState,
} from "@kitties/domain/Library/Library.state";
import { SkillDetailRecord } from "@kitties/domain/Library/SkillDetail.view";
import { SkillId } from "@kitties/domain/Library/Skill.id";
import type { SkillMetadata } from "@kitties/domain/Library/Skill";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import {
  LibrarySnapshot,
  LibrarySnapshotPolicy,
  LibrarySnapshotSource,
  LibrarySnapshotUnavailable,
  LibraryCatalogue,
  LibraryCatalogueMaxBytes,
} from "./library-snapshot.ts";
import {
  LIBRARY_OWNER,
  LibraryAdmission,
  LibraryAdmissionDenied,
  LibraryEpochSource,
  LibraryRequestScope,
} from "./library-session.ts";

const detail = (ordinal = 1): SkillDetailRecord => ({
  libraryId: LIBRARY_OWNER,
  id: SkillId.make(`skill-${ordinal}`),
  name: `Instructions ${ordinal}`,
  body: `Accepted body ${ordinal}`,
  status: "accepted",
  updatedAt: 12,
  proposalRevision: 2,
  detailRevision: 3,
});

const metadata = (ordinal = 1): SkillMetadata => ({
  id: SkillId.make(`skill-${ordinal}`),
  name: `Instructions ${ordinal}`,
  status: "accepted",
  updatedAt: 12,
  proposalRevision: 2,
  detailRevision: 3,
});

const catalogue = (active = [metadata()], revision = 3): LibraryState => ({
  active,
  highWater: 1,
  catalogueRevision: revision,
  importProgress: FinalizedImport.make({ inventoryId: "legacy", importedCount: 0 }),
});

const admission = Layer.succeed(LibraryAdmission, { check: () => Effect.void });
const epochs = Layer.succeed(LibraryEpochSource, { current: () => Effect.succeed(7) });
const dependencies = Layer.mergeAll(admission, epochs);

const withSource = (source: LibrarySnapshotSource["Service"]) =>
  LibrarySnapshot.layer.pipe(
    Layer.provide(Layer.mergeAll(dependencies, Layer.succeed(LibrarySnapshotSource, source))),
  );

it.effect(
  "compatibility reads use authoritative proposed and accepted bodies with the same barrier",
  () =>
    Effect.gen(function* () {
      const catalogueReader = yield* LibraryCatalogue;
      const result = yield* catalogueReader.read();
      expect(result.skills.map((skill) => [skill.id, skill.status, skill.body])).toEqual([
        ["skill-1", "accepted", "Accepted body 1"],
        ["skill-2", "proposed", "Proposed instructions"],
      ]);
    }).pipe(
      Effect.provide(
        LibraryCatalogue.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              dependencies,
              Layer.succeed(LibrarySnapshotSource, {
                catalogue: () =>
                  Effect.succeed(catalogue([metadata(), { ...metadata(2), status: "proposed" }])),
                detail: (key) =>
                  Effect.succeed(
                    Option.some(
                      key.endsWith("skill-2")
                        ? { ...detail(2), status: "proposed", body: "Proposed instructions" }
                        : detail(),
                    ),
                  ),
              }),
            ),
          ),
        ),
      ),
    ),
);

it.effect("oversized compatibility reads refuse instead of truncating the library", () =>
  Effect.gen(function* () {
    const catalogueReader = yield* LibraryCatalogue;
    expect(yield* Effect.flip(catalogueReader.read())).toEqual(
      new LibrarySnapshotUnavailable({ reason: "limit" }),
    );
  }).pipe(
    Effect.provide(
      LibraryCatalogue.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            dependencies,
            Layer.succeed(LibrarySnapshotSource, {
              catalogue: () => Effect.succeed(catalogue()),
              detail: () => Effect.succeed(Option.some(detail())),
            }),
          ),
        ),
      ),
    ),
    Effect.provideService(LibraryCatalogueMaxBytes, 10),
  ),
);

it.effect(
  "captures accepted instructions in stable ID order with their exact source revisions",
  () => {
    const reads: Array<{ key: string; revision: number; epoch: number }> = [];

    return Effect.gen(function* () {
      const snapshots = yield* LibrarySnapshot;
      const result = yield* snapshots.capture();
      expect(result).toMatchObject({ epoch: 7, catalogueRevision: 12 });
      expect(result.skills.map((skill) => [skill.id, skill.body])).toEqual([
        ["skill-1", "Accepted body 1"],
        ["skill-2", "Accepted body 2"],
        ["skill-3", "Accepted body 3"],
        ["skill-4", "Accepted body 4"],
        ["skill-5", "Accepted body 5"],
        ["skill-6", "Accepted body 6"],
        ["skill-7", "Accepted body 7"],
        ["skill-8", "Accepted body 8"],
      ]);
      expect(reads).toHaveLength(8);
      expect(reads.every((read) => read.revision === 3 && read.epoch === 7)).toBe(true);
    }).pipe(
      Effect.provide(
        withSource({
          catalogue: () =>
            Effect.succeed(
              catalogue(
                [
                  metadata(9),
                  metadata(8),
                  metadata(7),
                  metadata(6),
                  metadata(5),
                  metadata(4),
                  metadata(3),
                  metadata(2),
                  metadata(1),
                  { ...metadata(0), status: "proposed" },
                ],
                12,
              ),
            ),
          detail: Effect.fnUntraced(function* (key, revision) {
            const scope = yield* LibraryRequestScope;
            reads.push({ key, revision, epoch: scope.epoch });

            return Option.some(detail(Number(key.slice(-1))));
          }),
        }),
      ),
    );
  },
);

it.effect("restarts the whole capture if removal overlaps its detail reads", () => {
  let current = catalogue();

  return Effect.gen(function* () {
    const snapshots = yield* LibrarySnapshot;
    expect(yield* snapshots.capture()).toEqual({ epoch: 7, catalogueRevision: 4, skills: [] });
  }).pipe(
    Effect.provide(
      withSource({
        catalogue: () => Effect.sync(() => current),
        detail: () =>
          Effect.sync(() => {
            current = catalogue([], 4);

            return Option.some(detail());
          }),
      }),
    ),
  );
});

it.effect("never silently omits an accepted skill whose body is absent", () =>
  Effect.gen(function* () {
    const snapshots = yield* LibrarySnapshot;
    expect(yield* Effect.flip(snapshots.capture())).toEqual(
      new LibrarySnapshotUnavailable({ reason: "changed" }),
    );
  }).pipe(
    Effect.provide(
      withSource({
        catalogue: () => Effect.succeed(catalogue()),
        detail: () => Effect.succeed(Option.none()),
      }),
    ),
  ),
);

it.effect("rejects detail from a later removal even if the catalogue read has not changed", () =>
  Effect.gen(function* () {
    const snapshots = yield* LibrarySnapshot;
    expect(yield* Effect.flip(snapshots.capture())).toEqual(
      new LibrarySnapshotUnavailable({ reason: "changed" }),
    );
  }).pipe(
    Effect.provide(
      withSource({
        catalogue: () => Effect.succeed(catalogue()),
        detail: () =>
          Effect.succeed(Option.some({ ...detail(), status: "removed", detailRevision: 4 })),
      }),
    ),
  ),
);

it.effect("keeps pending imports unavailable instead of capturing an empty library", () =>
  Effect.gen(function* () {
    const snapshots = yield* LibrarySnapshot;
    expect(yield* Effect.flip(snapshots.capture())).toEqual(
      new LibrarySnapshotUnavailable({ reason: "not-ready" }),
    );
  }).pipe(
    Effect.provide(
      withSource({
        catalogue: () => Effect.succeed(initialLibrary),
        detail: () => Effect.succeed(Option.none()),
      }),
    ),
  ),
);

it.effect("rejects an accepted detail that has not reached the catalogue's recorded revision", () =>
  Effect.gen(function* () {
    const snapshots = yield* LibrarySnapshot;
    expect(yield* Effect.flip(snapshots.capture())).toEqual(
      new LibrarySnapshotUnavailable({ reason: "changed" }),
    );
  }).pipe(
    Effect.provide(
      withSource({
        catalogue: () => Effect.succeed(catalogue()),
        detail: () => Effect.succeed(Option.some({ ...detail(), detailRevision: 2 })),
      }),
    ),
  ),
);

it.effect("waits for the selected detail instead of confirming a partially delivered capture", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const delivery = yield* Deferred.make<SkillDetailRecord>();

    const layer = withSource({
      catalogue: () => Effect.succeed(catalogue()),
      detail: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(delivery)),
          Effect.map(Option.some),
        ),
    });

    const fiber = yield* LibrarySnapshot.use((snapshots) => snapshots.capture()).pipe(
      Effect.provide(layer),
      Effect.forkChild,
    );

    yield* Deferred.await(entered);
    expect(fiber.pollUnsafe()).toBeUndefined();
    yield* Deferred.succeed(delivery, detail());
    const completed = yield* Fiber.join(fiber);
    expect(completed.skills.map((skill) => [skill.id, skill.body])).toEqual([
      ["skill-1", "Accepted body 1"],
    ]);
  }),
);

it.effect(
  "does not move a capture into a new epoch when recovery starts before final validation",
  () => {
    let checks = 0;

    return Effect.gen(function* () {
      const snapshots = yield* LibrarySnapshot;
      expect(yield* Effect.flip(snapshots.capture())).toEqual(
        new LibrarySnapshotUnavailable({ reason: "recovery" }),
      );
      expect(checks).toBe(2);
    }).pipe(
      Effect.provide(
        LibrarySnapshot.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              epochs,
              Layer.succeed(LibraryAdmission, {
                check: () =>
                  Effect.suspend(() =>
                    ++checks === 1 ? Effect.void : new LibraryAdmissionDenied(),
                  ),
              }),
              Layer.succeed(LibrarySnapshotSource, {
                catalogue: () => Effect.succeed(catalogue()),
                detail: () => Effect.succeed(Option.some(detail())),
              }),
            ),
          ),
        ),
      ),
    );
  },
);

it.effect("bounds a stalled detail read and interrupts its owned work", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let finalized = false;

    const source = withSource({
      catalogue: () => Effect.succeed(catalogue()),
      detail: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              finalized = true;
            }),
          ),
        ),
    });

    const program = LibrarySnapshot.use((snapshots) => Effect.flip(snapshots.capture())).pipe(
      Effect.provide(source),
      Effect.provideService(LibrarySnapshotPolicy, { attempts: 3, totalMs: 1000, detailMs: 500 }),
    );

    const fiber = yield* Effect.forkChild(program);
    yield* Deferred.await(entered);
    yield* TestClock.adjust(1000);
    expect(yield* Fiber.join(fiber)).toEqual(new LibrarySnapshotUnavailable({ reason: "timeout" }));
    expect(finalized).toBe(true);
  }),
);

it.effect(
  "reads real Domain accepted body after delivery using the recorded source consistency point",
  () => {
    const memory = InMemory.make({ manual: true, now: () => 12 });
    const domain = LibraryModel.layer(Layer.empty).pipe(Layer.provide(memory.layer));

    const snapshot = LibrarySnapshot.layer.pipe(
      Layer.provide(Layer.mergeAll(dependencies, LibrarySnapshotSource.layer)),
      Layer.provideMerge(domain),
    );

    return Effect.gen(function* () {
      const libraries = yield* Library;
      yield* libraries
        .send(
          LIBRARY_OWNER,
          new FinalizeLibraryImport({
            inventoryId: "empty",
            expectedImportedCount: 0,
            expectedHighWater: 0,
          }),
        )
        .pipe(
          Effect.provideService(LibraryActor, {
            libraryId: LIBRARY_OWNER,
            authority: "import",
            importFinalized: false,
          }),
        );

      const proposed = yield* libraries
        .send(LIBRARY_OWNER, new ProposeSkill({ name: "Review", body: "Ask before publishing" }))
        .pipe(
          Effect.provideService(LibraryActor, {
            libraryId: LIBRARY_OWNER,
            authority: "owner",
            importFinalized: true,
          }),
        );

      yield* libraries
        .send(
          LIBRARY_OWNER,
          new AcceptSkill({
            skillId: proposed.reply.skillId,
            expectedProposalRevision: proposed.reply.proposalRevision,
          }),
        )
        .pipe(
          Effect.provideService(LibraryActor, {
            libraryId: LIBRARY_OWNER,
            authority: "owner",
            importFinalized: true,
          }),
        );
      yield* memory.control.drain;
      const snapshots = yield* LibrarySnapshot;
      const result = yield* snapshots.capture();
      expect(result).toEqual({
        epoch: 7,
        catalogueRevision: 3,
        skills: [
          {
            libraryId: "owner",
            id: "kitties-skill-0000000000000001",
            name: "Review",
            body: "Ask before publishing",
            status: "accepted",
            createdAt: 12,
            updatedAt: 12,
            proposalRevision: 2,
            detailRevision: 3,
          },
        ],
      });
    }).pipe(Effect.provide(snapshot));
  },
);
