import { DatabaseSync } from "node:sqlite";
import * as InMemory from "@alchemy.run/domain/InMemory";
import { Platform } from "@alchemy.run/domain/Platform";
import { it } from "@effect/vitest";
import { Library } from "@kitties/domain/Library/Library.aggregate";
import { ProposeSkill } from "@kitties/domain/Library/ProposeSkill.command";
import { RemoveSkill } from "@kitties/domain/Library/RemoveSkill.command";
import { SkillDetail } from "@kitties/domain/Library/SkillDetail.view";
import { SkillId, skillDetailKey } from "@kitties/domain/Library/Skill.id";
import { LibraryActor } from "@kitties/domain/LibraryActor.context";
import { LibraryModel } from "@kitties/domain/Library.model";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import {
  LibraryLegacyStore,
  LibraryMigrationControl,
  type LibraryLegacyDatabase,
} from "./library-legacy-store.ts";
import { LibraryMigration, LibraryMigrationPolicy } from "./library-migration.ts";
import { LibraryRecoveryError } from "./library-recovery-records.ts";
import { LibraryRecoveryStore } from "./library-recovery-store.ts";
import { LIBRARY_OWNER, LibraryRequestScope } from "./library-session.ts";

const fixture = Effect.gen(function* () {
  const database = yield* Effect.acquireRelease(
    Effect.sync(() => new DatabaseSync(":memory:")),
    (db) => Effect.sync(() => db.close()),
  );

  const journal = yield* Effect.acquireRelease(
    Effect.sync(() => new DatabaseSync(":memory:")),
    (db) => Effect.sync(() => db.close()),
  );

  database.exec(
    "CREATE TABLE records (kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(kind,id))",
  );

  const sqlite = (db: DatabaseSync): LibraryLegacyDatabase => ({
    query: (statement, ...bindings) =>
      Schema.decodeUnknownSync(Schema.Array(Schema.JsonObject))(
        db.prepare(statement).all(...bindings),
      ),
    transaction: (body) => {
      db.exec("BEGIN IMMEDIATE");

      try {
        const value = body();
        db.exec("COMMIT");

        return value;
      } catch (cause) {
        db.exec("ROLLBACK");
        throw cause;
      }
    },
  });

  const recoveryContext = yield* Layer.build(
    LibraryRecoveryStore.layer(sqlite(journal), { authorize: () => {} }),
  );

  const recovery = Context.get(recoveryContext, LibraryRecoveryStore);

  const faults = {
    importReply: false,
    finalizeReply: false,
    finishReply: false,
    projectionBlocked: false,
    corruptDetail: false,
  };

  const sends: Array<{ id: string | undefined; scope: unknown; actor: unknown }> = [];
  const queries: Array<{ stream: string; version: number } | undefined> = [];
  const projectionStarted = yield* Deferred.make<void>();

  const control = Layer.succeed(LibraryMigrationControl, {
    status: recovery.status,
    initialize: recovery.initialize,
    finishImport: (inventoryId, floor) =>
      recovery.finishImport(inventoryId, floor).pipe(
        Effect.flatMap((state) => {
          if (faults.finishReply) {
            faults.finishReply = false;

            return Effect.fail(new LibraryRecoveryError({ reason: "storage" }));
          }

          return Effect.succeed(state);
        }),
      ),
  });

  const legacy = LibraryLegacyStore.layer(sqlite(database)).pipe(Layer.provide(control));
  const memory = InMemory.make({ manual: true, now: () => 9 });

  const platform = Layer.effect(
    Platform,
    Effect.gen(function* () {
      const base = yield* Platform;

      return Platform.of({
        model: (model) =>
          base.model(model).pipe(
            Effect.map((host) => ({
              ...host,
              aggregate: (aggregate, kit) =>
                host.aggregate(aggregate, kit).pipe(
                  Effect.map((store) => ({
                    ...store,
                    send: (id, command, meta) =>
                      store.send(id, command, meta).pipe(
                        Effect.tap(() =>
                          Effect.gen(function* () {
                            sends.push({
                              id: meta.commandId,
                              scope: Option.getOrUndefined(
                                yield* Effect.serviceOption(LibraryRequestScope),
                              ),
                              actor: Option.getOrUndefined(
                                yield* Effect.serviceOption(LibraryActor),
                              ),
                            });

                            const tag = Schema.decodeUnknownSync(
                              Schema.Struct({ _tag: Schema.String }),
                            )(command)._tag;

                            if (
                              (tag === "ImportSkill" && faults.importReply) ||
                              (tag === "FinalizeLibraryImport" && faults.finalizeReply)
                            ) {
                              faults.importReply = false;
                              faults.finalizeReply = false;

                              return yield* Effect.die(
                                "Injected lost command acknowledgement after commit",
                              );
                            }
                          }),
                        ),
                      ),
                  })),
                ),
            })),
          ),
      });
    }),
  ).pipe(Layer.provideMerge(memory.layer));

  const model = LibraryModel.layer(Layer.empty).pipe(Layer.provide(platform));

  const hosted = Layer.mergeAll(
    Layer.effect(
      SkillDetail,
      Effect.gen(function* () {
        const base = yield* SkillDetail;

        return SkillDetail.of({
          ...base,
          query: (key, options) =>
            Effect.gen(function* () {
              queries.push(options?.atLeast);
              yield* Deferred.succeed(projectionStarted, undefined);

              if (faults.projectionBlocked) return yield* Effect.never;
              yield* memory.control.drain;
              const found = yield* base.query(key, options);

              return Option.map(found, (detail) =>
                detail === null || !faults.corruptDetail
                  ? detail
                  : { ...detail, body: "corrupted" },
              );
            }),
        });
      }),
    ),
  ).pipe(Layer.provideMerge(model));

  const world = LibraryMigration.layer.pipe(
    Layer.provideMerge(hosted),
    Layer.provideMerge(legacy),
    Layer.provide(control),
    Layer.provide(
      Layer.succeed(LibraryMigrationPolicy, { totalMs: 10000, controlMs: 500, detailMs: 1000 }),
    ),
  );

  const context = yield* Layer.build(world);

  return {
    database,
    recovery,
    faults,
    sends,
    queries,
    projectionStarted,
    memory,
    legacy: Context.get(context, LibraryLegacyStore),
    migration: Context.get(context, LibraryMigration),
    libraries: Context.get(context, Library),
    details: Context.get(context, SkillDetail),
  };
});

it.effect(
  "imports exact accepted/proposed legacy identities and historical timestamps before readiness",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.legacy.writeSkill(
        "old",
        '{"id":"old","name":"Accepted","body":"Original body","status":"accepted","createdAt":4,"updatedAt":6}',
        900,
      );
      yield* f.legacy.writeSkill(
        "kitties-skill-0000000000000042",
        '{"id":"kitties-skill-0000000000000042","name":"Proposed","body":"🐈","status":"proposed"}',
        17,
      );
      const result = yield* f.migration.run("legacy-v1");
      expect(result).toEqual({
        inventoryId: "legacy-v1",
        epoch: 1,
        importedCount: 2,
        fallbackCount: 1,
        allocatorFloor: 42,
        alreadyReady: false,
      });
      const state = yield* f.libraries.state(LIBRARY_OWNER);
      expect(state.active).toEqual([
        {
          id: "kitties-skill-0000000000000042",
          name: "Proposed",
          status: "proposed",
          updatedAt: 17,
          proposalRevision: 1,
          detailRevision: 1,
        },
        {
          id: "old",
          name: "Accepted",
          status: "accepted",
          createdAt: 4,
          updatedAt: 6,
          proposalRevision: 2,
          detailRevision: 2,
        },
      ]);
      expect(state.highWater).toBe(42);
      expect((yield* f.recovery.status)?.phase).toBe("ready");
      expect(f.sends.map((send) => send.id)).toEqual([
        "library:1:import:legacy-v1:1",
        "library:1:import:legacy-v1:2",
        "library:1:import:legacy-v1:finalize",
      ]);
      expect(f.sends.map((send) => send.scope)).toEqual(
        Array(3).fill({ libraryId: "owner", epoch: 1 }),
      );
      expect(f.sends.map((send) => send.actor)).toEqual(
        Array(3).fill({ libraryId: "owner", authority: "import", importFinalized: false }),
      );
      expect(f.queries).toEqual([
        { stream: "Library/owner", version: 1 },
        { stream: "Library/owner", version: 2 },
      ]);

      const detail = Option.getOrNull(
        yield* f.details.query(skillDetailKey(LIBRARY_OWNER, SkillId.make("old"))),
      );

      expect(detail?.body).toBe("Original body");
      expect((yield* f.legacy.writeSkill("later", "{}", 20).pipe(Effect.flip)).reason).toBe(
        "frozen",
      );
    }).pipe(Effect.scoped),
);

it.effect("empty legacy inventory still records explicit finalization", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    expect(yield* f.migration.run("empty-v1")).toEqual({
      inventoryId: "empty-v1",
      epoch: 1,
      importedCount: 0,
      fallbackCount: 0,
      allocatorFloor: 0,
      alreadyReady: false,
    });
    expect(f.memory.control.commits).toEqual([{ aggregate: "Library", id: "owner", index: 0 }]);
    expect(f.sends.map((send) => send.id)).toEqual(["library:1:import:empty-v1:finalize"]);
  }).pipe(Effect.scoped),
);

for (const [name, key] of [
  ["row commit", "importReply"],
  ["finalization", "finalizeReply"],
  ["control publication", "finishReply"],
] as const) {
  it.effect(`resumes safely after losing the ${name} acknowledgement`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.legacy.writeSkill(
        "old",
        '{"id":"old","name":"Original","body":"Keep","status":"accepted"}',
        7,
      );
      f.faults[key] = true;
      const failed = yield* f.migration.run("legacy-v1").pipe(Effect.flip);
      expect(failed.reason).toBe("storage");
      const result = yield* f.migration.run("legacy-v1");
      expect(result.importedCount).toBe(1);
      expect(result.fallbackCount).toBe(1);
      expect(result.alreadyReady).toBe(key === "finishReply");
      expect(f.memory.control.commits).toEqual([
        { aggregate: "Library", id: "owner", index: 0 },
        { aggregate: "Library", id: "owner", index: 1 },
      ]);
      expect((yield* f.libraries.state(LIBRARY_OWNER)).active.map((skill) => skill.id)).toEqual([
        "old",
      ]);
      expect((yield* f.recovery.status)?.phase).toBe("ready");
    }).pipe(Effect.scoped),
  );
}

for (const [name, body] of [
  [
    "present null timestamp",
    '{"id":"old","name":"N","body":"B","status":"accepted","updatedAt":null}',
  ],
  [
    "present fractional timestamp",
    '{"id":"old","name":"N","body":"B","status":"accepted","updatedAt":1.2}',
  ],
  [
    "invalid created timestamp",
    '{"id":"old","name":"N","body":"B","status":"accepted","createdAt":-1}',
  ],
  ["ID/key mismatch", '{"id":"other","name":"N","body":"B","status":"accepted"}'],
  ["unknown status", '{"id":"old","name":"N","body":"B","status":"removed"}'],
  [
    "noncanonical reserved ID",
    '{"id":"kitties-skill-1","name":"N","body":"B","status":"accepted"}',
  ],
  ["malformed JSON", "{not json"],
] as const) {
  it.effect(`keeps schema failure visible and frozen for ${name}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const id = name === "noncanonical reserved ID" ? "kitties-skill-1" : "old";
      yield* f.legacy.writeSkill(id, body, 7);
      const failed = yield* f.migration.run("legacy-v1").pipe(Effect.flip);
      expect([failed.stage, failed.reason, failed.ordinal]).toEqual([
        name === "malformed JSON" ? "inventory" : "validation",
        "invalid",
        1,
      ]);
      expect(f.memory.control.commits).toEqual([]);
      expect(yield* f.recovery.status).toBeNull();
      expect((yield* f.legacy.removeSkill(id).pipe(Effect.flip)).reason).toBe("frozen");
    }).pipe(Effect.scoped),
  );
}

it.effect("projection mismatch keeps control importing after committed finalization", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.legacy.writeSkill(
      "old",
      '{"id":"old","name":"N","body":"Keep","status":"accepted"}',
      7,
    );
    f.faults.corruptDetail = true;
    const failed = yield* f.migration.run("legacy-v1").pipe(Effect.flip);
    expect([failed.stage, failed.reason]).toEqual(["projection", "conflict"]);
    expect((yield* f.recovery.status)?.phase).toBe("importing");
    expect((yield* f.libraries.state(LIBRARY_OWNER)).importProgress._tag).toBe("Finalized");
    f.faults.corruptDetail = false;
    yield* f.migration.run("legacy-v1");
    expect(f.memory.control.commits.length).toBe(2);
    expect((yield* f.recovery.status)?.phase).toBe("ready");
  }).pipe(Effect.scoped),
);

it.effect("an idle projection wait has a deterministic deadline and remains resumable", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.legacy.writeSkill(
      "old",
      '{"id":"old","name":"N","body":"Keep","status":"accepted"}',
      7,
    );
    f.faults.projectionBlocked = true;
    const run = yield* f.migration.run("legacy-v1").pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(f.projectionStarted);
    yield* TestClock.adjust(1000);
    const failed = yield* Fiber.join(run);
    expect([failed.stage, failed.reason]).toEqual(["projection", "timeout"]);
    expect((yield* f.recovery.status)?.phase).toBe("importing");
    f.faults.projectionBlocked = false;
    yield* f.migration.run("legacy-v1");
    expect(f.memory.control.commits.length).toBe(2);
  }).pipe(Effect.scoped),
);

it.effect("ready reruns never replay frozen legacy rows over new edits or removed identities", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.legacy.writeSkill(
      "old",
      '{"id":"old","name":"N","body":"Keep","status":"accepted"}',
      7,
    );
    yield* f.migration.run("legacy-v1");
    yield* f.libraries
      .send(
        LIBRARY_OWNER,
        new RemoveSkill({ skillId: SkillId.make("old"), expectedProposalRevision: 1 }),
        { commandId: "library:1:remove" },
      )
      .pipe(
        Effect.provideService(LibraryActor, {
          libraryId: LIBRARY_OWNER,
          authority: "owner",
          importFinalized: true,
        }),
      );
    yield* f.libraries
      .send(LIBRARY_OWNER, new ProposeSkill({ name: "New", body: "New body" }), {
        commandId: "library:1:new",
      })
      .pipe(
        Effect.provideService(LibraryActor, {
          libraryId: LIBRARY_OWNER,
          authority: "owner",
          importFinalized: true,
        }),
      );
    const committed = f.memory.control.commits.length;
    expect((yield* f.migration.run("legacy-v1")).alreadyReady).toBe(true);
    expect(f.memory.control.commits.length).toBe(committed);
    expect((yield* f.libraries.state(LIBRARY_OWNER)).active.map((skill) => skill.name)).toEqual([
      "New",
    ]);
    expect((yield* f.migration.run("different").pipe(Effect.flip)).reason).toBe("conflict");
  }).pipe(Effect.scoped),
);

it.effect("metadata capacity stops import without truncation before initializing control", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const insert = f.database.prepare("INSERT INTO records VALUES ('skill',?,?,1)");

    for (let index = 0; index < 2500; index++) {
      const id = `old-${String(index).padStart(4, "0")}`;
      insert.run(id, JSON.stringify({ id, name: "n".repeat(80), body: "", status: "accepted" }));
    }

    const failed = yield* f.migration.run("large-v1").pipe(Effect.flip);
    expect([failed.stage, failed.reason]).toEqual(["validation", "limit"]);
    // 2,442 metadata rows reserve 524,217 bytes; the next reserves 524,432.
    expect(failed.ordinal).toBe(2443);
    expect(f.memory.control.commits).toEqual([]);
    expect((yield* f.legacy.inventory("large-v1")).rowCount).toBe(2500);
    expect(yield* f.recovery.status).toBeNull();
  }).pipe(Effect.scoped),
);

it.effect(
  "imports across the64-row page boundary using aggregate source versions rather than detail cursors",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;

      for (let index = 0; index < 65; index++) {
        const id = `old-${String(index).padStart(3, "0")}`;
        yield* f.legacy.writeSkill(
          id,
          JSON.stringify({ id, name: "N", body: "Keep", status: "accepted", updatedAt: 0 }),
          999,
        );
      }

      const result = yield* f.migration.run("pages-v1");
      expect([result.importedCount, result.fallbackCount]).toEqual([65, 0]);
      expect(f.sends.slice(63).map((send) => send.id)).toEqual([
        "library:1:import:pages-v1:64",
        "library:1:import:pages-v1:65",
        "library:1:import:pages-v1:finalize",
      ]);
      expect(f.queries[64]).toEqual({ stream: "Library/owner", version: 65 });

      const snapshot = yield* f.details.snapshot(
        skillDetailKey(LIBRARY_OWNER, SkillId.make("old-064")),
      );

      expect(snapshot.cursor).toBe(1);
      expect(snapshot.state?.detailRevision).toBe(65);
      expect(snapshot.state?.updatedAt).toBe(0);
      expect(f.memory.control.commits.length).toBe(66);
    }).pipe(Effect.scoped),
);

it.effect("canonical imported maximum ordinal cannot be reused by a later proposal", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const id = "kitties-skill-9007199254740991";
    yield* f.legacy.writeSkill(
      id,
      JSON.stringify({ id, name: "N", body: "Keep", status: "accepted" }),
      7,
    );
    expect((yield* f.migration.run("max-v1")).allocatorFloor).toBe(9007199254740991);

    const rejected = yield* f.libraries
      .send(LIBRARY_OWNER, new ProposeSkill({ name: "New", body: "B" }), {
        commandId: "library:1:new",
      })
      .pipe(
        Effect.provideService(LibraryActor, {
          libraryId: LIBRARY_OWNER,
          authority: "owner",
          importFinalized: true,
        }),
        Effect.flip,
      );

    expect(rejected._tag).toBe("SkillAllocatorExhausted");
    expect(f.memory.control.commits.length).toBe(2);
  }).pipe(Effect.scoped),
);

it.effect("internal import IDs retain a full128-character inventory identity", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const inventoryId = "i".repeat(128);
    yield* f.legacy.writeSkill(
      "old",
      '{"id":"old","name":"N","body":"Keep","status":"accepted"}',
      7,
    );
    yield* f.migration.run(inventoryId);
    expect(f.sends.map((send) => send.id)).toEqual([
      `library:1:import:${inventoryId}:1`,
      `library:1:import:${inventoryId}:finalize`,
    ]);
    expect(f.memory.control.commits.length).toBe(2);
  }).pipe(Effect.scoped),
);
