import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { SkillId } from "@kitties/domain/Library/Skill.id";
import { LibraryLegacyStore, type LibraryLegacyStatus } from "./library-legacy-store.ts";
import { LibraryRecoveryState } from "./library-recovery-records.ts";
import { LibrarySnapshot, type CapturedLibrary } from "./library-snapshot.ts";
import { LIBRARY_OWNER } from "./library-session.ts";
import { TurnConfiguration, TurnConfigurationUnavailable } from "./turn-configuration.ts";

const authority = LibraryRecoveryState.make({
  libraryId: "owner",
  epoch: 2,
  lineage: "library-2",
  nextLineage: 3,
  phase: "ready",
  inventoryId: "legacy",
  operationId: null,
  stagingLineage: null,
  allocatorFloor: 2,
});

const status: LibraryLegacyStatus = { authority, frozen: true, inventory: null };

const snapshot = (body: string): CapturedLibrary => ({
  epoch: 2,
  catalogueRevision: 7,
  skills: [
    {
      libraryId: LIBRARY_OWNER,
      id: SkillId.make("skill-1"),
      name: "Review",
      body,
      status: "accepted",
      updatedAt: 10,
      proposalRevision: 1,
      detailRevision: 7,
    },
  ],
});

const fixture = Effect.gen(function* () {
  const db = yield* Effect.acquireRelease(
    Effect.sync(() => new DatabaseSync(":memory:")),
    (db) => Effect.sync(() => db.close()),
  );

  db.exec(
    "CREATE TABLE records (kind TEXT,id TEXT,body TEXT,updated_at INTEGER,PRIMARY KEY(kind,id))",
  );
  db.exec("CREATE TABLE library_legacy_marker (id INTEGER PRIMARY KEY)");
  db.prepare("INSERT INTO records VALUES ('kitty','cat',?,1)").run(
    JSON.stringify({ id: "cat", name: "Cat", soul: "Helpful", createdAt: 1 }),
  );
  let inTransaction = false;

  const database = {
    query: (sql: string, ...bindings: ReadonlyArray<string | number | null>) =>
      Schema.decodeUnknownSync(Schema.Array(Schema.JsonObject))(db.prepare(sql).all(...bindings)),
    transaction: <A>(body: () => A): A => {
      db.exec("BEGIN IMMEDIATE");
      inTransaction = true;

      try {
        const result = body();
        db.exec("COMMIT");

        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        inTransaction = false;
      }
    },
  };

  const build = Effect.fnUntraced(function* (
    capture: LibrarySnapshot["Service"]["capture"],
    current: Effect.Effect<LibraryLegacyStatus> = Effect.succeed(status),
  ) {
    const unused = () => Effect.die("Unexpected legacy mutation");

    const layer = TurnConfiguration.layer(database).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(LibrarySnapshot, { capture }),
          Layer.succeed(LibraryLegacyStore, {
            status: current,
            freeze: unused,
            inventory: unused,
            page: unused,
            writeSkill: unused,
            removeSkill: unused,
          }),
        ),
      ),
    );

    return Context.get(yield* Layer.build(layer), TurnConfiguration);
  });

  const body = (id: string) => {
    const result = db.prepare("SELECT body FROM records WHERE kind='turn-config' AND id=?").get(id);

    if (result === undefined) return undefined;

    return Schema.decodeUnknownSync(Schema.Struct({ body: Schema.String }))(result).body;
  };

  return { db, build, body, inTransaction: () => inTransaction };
});

it.effect("captures Domain outside the Home transaction and reuses the first body on retries", () =>
  Effect.gen(function* () {
    const home = yield* fixture;
    let calls = 0;

    const turns = yield* home.build(() =>
      Effect.sync(() => {
        expect(home.inTransaction()).toBe(false);
        calls++;

        return snapshot("First accepted body");
      }),
    );

    expect(yield* turns.prepare("turn-1", "cat", "healthy")).toBe(12);
    const saved = home.body("turn-1");
    expect(saved).toBeDefined();
    expect(JSON.parse(saved!)).toMatchObject({
      library: { epoch: 2, catalogueRevision: 7 },
      skills: [{ body: "First accepted body" }],
    });
    expect(yield* turns.prepare("turn-1", "cat", "retry")).toBe(12);
    expect(home.body("turn-1")).toBe(saved);
    expect(calls).toBe(1);
    expect(home.db.prepare("SELECT body FROM records WHERE kind='run-health'").get()).toMatchObject(
      { body: "retry" },
    );
  }),
);

it.effect("a slower initializer cannot overwrite another initializer's confirmed snapshot", () =>
  Effect.gen(function* () {
    const home = yield* fixture;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let calls = 0;

    const turns = yield* home.build(() =>
      Effect.gen(function* () {
        calls++;

        if (calls === 1) {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);

          return snapshot("Slow body");
        }

        return snapshot("Winning body");
      }),
    );

    const slow = yield* turns.prepare("shared", "cat", "slow").pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* turns.prepare("shared", "cat", "fast");
    const winning = home.body("shared");
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(slow);
    expect(home.body("shared")).toBe(winning);
    expect(JSON.parse(winning!)).toMatchObject({ skills: [{ body: "Winning body" }] });
  }),
);

it.effect("uses accepted legacy rows only before the permanent migration fence", () =>
  Effect.gen(function* () {
    const home = yield* fixture;
    home.db.prepare("INSERT INTO records VALUES ('skill','old',?,1)").run(
      JSON.stringify({
        id: "old",
        name: "Old",
        body: "Legacy body",
        status: "accepted",
        updatedAt: 1,
      }),
    );

    const turns = yield* home.build(
      () => Effect.die("Domain must not run before migration"),
      Effect.succeed({ authority: null, frozen: false, inventory: null }),
    );

    yield* turns.prepare("legacy-turn", "cat", "healthy");
    expect(JSON.parse(home.body("legacy-turn")!)).toMatchObject({
      skills: [{ body: "Legacy body" }],
    });
    expect(JSON.parse(home.body("legacy-turn")!)).not.toHaveProperty("library");
  }),
);

it.effect("refuses new turns throughout import and recovery", () =>
  Effect.gen(function* () {
    for (const phase of ["importing", "frozen", "staging", "activating"] as const) {
      const home = yield* fixture;

      const turns = yield* home.build(
        () => Effect.die("Cannot capture fenced library"),
        Effect.succeed({ ...status, authority: { ...authority, phase } }),
      );

      expect(yield* Effect.flip(turns.prepare("blocked", "cat", "healthy"))).toEqual(
        new TurnConfigurationUnavailable({ reason: "library" }),
      );
      expect(home.body("blocked")).toBeUndefined();
    }
  }),
);

it.effect(
  "checks the local fence again if migration freezes after the initial authority read",
  () =>
    Effect.gen(function* () {
      const home = yield* fixture;

      const turns = yield* home.build(
        () => Effect.die("Cannot capture legacy through Domain"),
        Effect.sync(() => {
          home.db.exec("INSERT INTO library_legacy_marker VALUES (1)");

          return { authority: null, frozen: false, inventory: null };
        }),
      );

      expect(yield* Effect.flip(turns.prepare("raced", "cat", "healthy"))).toEqual(
        new TurnConfigurationUnavailable({ reason: "library" }),
      );
      expect(home.body("raced")).toBeUndefined();
    }),
);
