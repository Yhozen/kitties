import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";
import {
  DEFAULT_LIBRARY_LEGACY_LIMITS,
  type LibraryLegacyDatabase,
  LibraryLegacyStore,
  LibraryMigrationControl,
} from "./library-legacy-store.ts";
import { LibraryRecoveryError, LibraryRecoveryState } from "./library-recovery-records.ts";

const authority = LibraryRecoveryState.make({
  libraryId: "owner",
  epoch: 1,
  lineage: "library-1",
  nextLineage: 2,
  phase: "ready",
  inventoryId: "legacy-v1",
  operationId: null,
  stagingLineage: null,
  allocatorFloor: 0,
});

interface LegacyControlFixture {
  state: LibraryRecoveryState | null;
  unavailable: boolean;
  failCommit: boolean;
}

const fixture = Effect.gen(function* () {
  const database = yield* Effect.acquireRelease(
    Effect.sync(() => new DatabaseSync(":memory:")),
    (db) => Effect.sync(() => db.close()),
  );

  database.exec(
    "CREATE TABLE records (kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(kind,id))",
  );

  const control: LegacyControlFixture = { state: null, unavailable: false, failCommit: false };

  const queries: Array<string> = [];

  const port: LibraryLegacyDatabase = {
    query: (statement, ...bindings) => {
      queries.push(statement);

      return Schema.decodeUnknownSync(Schema.Array(Schema.JsonObject))(
        database.prepare(statement).all(...bindings),
      );
    },
    transaction: (body) => {
      database.exec("BEGIN IMMEDIATE");

      try {
        const value = body();

        if (control.failCommit) {
          control.failCommit = false;
          throw new Error("Interrupted commit");
        }

        database.exec("COMMIT");

        return value;
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
  };

  const layer = Layer.succeed(LibraryMigrationControl, {
    status: Effect.suspend(() =>
      control.unavailable
        ? Effect.fail(new LibraryRecoveryError({ reason: "storage" }))
        : Effect.succeed(control.state),
    ),
    initialize: () => Effect.die("Constructor started migration"),
    finishImport: () => Effect.die("Constructor published import"),
  });

  const restart = (limits = DEFAULT_LIBRARY_LEGACY_LIMITS) =>
    Layer.build(LibraryLegacyStore.layer(port, limits).pipe(Layer.provide(layer))).pipe(
      Effect.map((context) => Context.get(context, LibraryLegacyStore)),
    );

  return { database, queries, control, restart, store: yield* restart() };
});

it.effect("constructor reconciliation does not freeze rows or start an import", () =>
  Effect.gen(function* () {
    const { database, store } = yield* fixture;
    yield* store.writeSkill("old", "{}", 17);
    expect(database.prepare("SELECT COUNT(*) AS count FROM library_legacy_marker").get()).toEqual({
      count: 0,
    });
    expect(
      database.prepare("SELECT body,updated_at FROM records WHERE kind='skill'").get(),
    ).toEqual({ body: "{}", updated_at: 17 });
  }).pipe(Effect.scoped),
);

it.effect(
  "freeze captures immutable bodies and timestamps and fences the actual write/remove seams",
  () =>
    Effect.gen(function* () {
      const { database, store } = yield* fixture;
      yield* store.writeSkill("z", '{"updatedAt":12,"body":"🐈"}', 33);
      yield* store.writeSkill("a", '{"body":"original"}', 44);
      const inventory = yield* store.freeze("legacy-v1");
      expect(inventory).toEqual({
        inventoryId: "legacy-v1",
        rowCount: 2,
        bytes: Buffer.byteLength('{"updatedAt":12,"body":"🐈"}{"body":"original"}'),
        fallbackCount: 1,
      });
      expect(yield* store.freeze("legacy-v1")).toEqual(inventory);
      expect(yield* store.page("legacy-v1", 0)).toEqual([
        { ordinal: 1, id: "a", body: '{"body":"original"}', updatedAt: 44 },
        { ordinal: 2, id: "z", body: '{"updatedAt":12,"body":"🐈"}', updatedAt: 33 },
      ]);
      expect((yield* store.writeSkill("a", "changed", 90).pipe(Effect.flip)).reason).toBe("frozen");
      expect((yield* store.removeSkill("z").pipe(Effect.flip)).reason).toBe("frozen");
      expect((yield* store.freeze("different").pipe(Effect.flip)).reason).toBe("conflict");
      expect(database.prepare("SELECT body FROM records WHERE id='a'").get()).toEqual({
        body: '{"body":"original"}',
      });
    }).pipe(Effect.scoped),
);

it.effect("freeze marker and materialization roll back together on an interrupted commit", () =>
  Effect.gen(function* () {
    const { database, control, store } = yield* fixture;
    yield* store.writeSkill("old", "{}", 4);
    control.failCommit = true;
    expect((yield* store.freeze("legacy-v1").pipe(Effect.flip)).reason).toBe("storage");
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM library_legacy_inventory").get(),
    ).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM library_legacy_marker").get()).toEqual({
      count: 0,
    });
    yield* store.writeSkill("old", "new", 5);
    expect((yield* store.freeze("legacy-v1")).rowCount).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("frozen inventory is paged in stable batches of at most64", () =>
  Effect.gen(function* () {
    const { database, store } = yield* fixture;
    const insert = database.prepare("INSERT INTO records VALUES ('skill',?,?,1)");

    for (let index = 128; index >= 0; index--) insert.run(String(index).padStart(3, "0"), "{}");
    yield* store.freeze("legacy-v1");
    const first = yield* store.page("legacy-v1", 0);
    const second = yield* store.page("legacy-v1", 64);
    const last = yield* store.page("legacy-v1", 128);
    expect([first.length, second.length, last.length]).toEqual([64, 64, 1]);
    expect([first[0]?.id, first[63]?.id, second[0]?.id, last[0]?.id]).toEqual([
      "000",
      "063",
      "064",
      "128",
    ]);
    expect(yield* store.page("legacy-v1", 129)).toEqual([]);
  }).pipe(Effect.scoped),
);

for (const [name, limits] of [
  ["row", { ...DEFAULT_LIBRARY_LEGACY_LIMITS, maxRows: 1 }],
  ["UTF-8 byte", { ...DEFAULT_LIBRARY_LEGACY_LIMITS, maxBytes: 3 }],
] as const) {
  it.effect(
    `over-${name}-cap freeze refuses explicitly without copying a truncated inventory`,
    () =>
      Effect.gen(function* () {
        const { database, restart } = yield* fixture;
        const store = yield* restart(limits);
        yield* store.writeSkill("a", "🐈", 1);
        yield* store.writeSkill("b", "{}", 2);
        expect((yield* store.freeze("legacy-v1").pipe(Effect.flip)).reason).toBe("limit");
        expect(
          database.prepare("SELECT COUNT(*) AS count FROM library_legacy_inventory").get(),
        ).toEqual({ count: 0 });
        expect(
          database.prepare("SELECT COUNT(*) AS count FROM library_legacy_marker").get(),
        ).toEqual({ count: 0 });
        yield* store.removeSkill("b");
        expect(database.prepare("SELECT COUNT(*) AS count FROM records").get()).toEqual({
          count: 1,
        });
      }).pipe(Effect.scoped),
  );
}

it.effect(
  "surviving control prevents Home PITR from reopening writers or recapturing old rows",
  () =>
    Effect.gen(function* () {
      const { database, store, control, restart } = yield* fixture;
      yield* store.writeSkill("old", "{}", 2);
      yield* store.freeze("legacy-v1");
      control.state = authority;
      database.exec("DELETE FROM library_legacy_marker; DELETE FROM library_legacy_inventory");
      const restored = yield* restart();
      expect((yield* restored.writeSkill("new", "{}", 3).pipe(Effect.flip)).reason).toBe("frozen");
      expect((yield* restored.removeSkill("old").pipe(Effect.flip)).reason).toBe("frozen");
      expect((yield* restored.freeze("legacy-v1").pipe(Effect.flip)).reason).toBe("missing");
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM library_legacy_inventory").get(),
      ).toEqual({ count: 0 });
    }).pipe(Effect.scoped),
);

it.effect("a durable local freeze remains closed even before Recovery initialization", () =>
  Effect.gen(function* () {
    const { store, restart } = yield* fixture;
    yield* store.freeze("legacy-v1");
    const resumed = yield* restart();
    expect((yield* resumed.writeSkill("new", "{}", 1).pipe(Effect.flip)).reason).toBe("frozen");
    expect(yield* resumed.inventory("legacy-v1")).toEqual({
      inventoryId: "legacy-v1",
      rowCount: 0,
      bytes: 0,
      fallbackCount: 0,
    });
  }).pipe(Effect.scoped),
);

it.effect("unavailable control fails closed before exposing the skill capability", () =>
  Effect.gen(function* () {
    const { restart, control } = yield* fixture;
    control.unavailable = true;
    expect((yield* restart().pipe(Effect.flip)).reason).toBe("authority");
  }).pipe(Effect.scoped),
);

it.effect("oversized body is refused using SQL size metadata before its page is materialized", () =>
  Effect.gen(function* () {
    const { store, queries } = yield* fixture;
    yield* store.writeSkill("old", "x".repeat(524289), 1);
    yield* store.freeze("legacy-v1");
    queries.length = 0;
    const error = yield* store.page("legacy-v1", 0).pipe(Effect.flip);
    expect([error.reason, error.ordinal]).toEqual(["limit", 1]);
    expect(queries.some((query) => query.startsWith("SELECT ordinal,id,body"))).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect(
  "inventory fallback count distinguishes missing timestamps from present invalid values",
  () =>
    Effect.gen(function* () {
      const { store } = yield* fixture;
      yield* store.writeSkill("a", "{}", 1);
      yield* store.writeSkill("b", '{"updatedAt":null}', 2);
      yield* store.writeSkill("c", "invalid json", 3);
      expect((yield* store.freeze("legacy-v1")).fallbackCount).toBe(1);
    }).pipe(Effect.scoped),
);

it.effect(
  "current status distinguishes legacy, frozen and ready authority without exposing bodies",
  () =>
    Effect.gen(function* () {
      const { store, control } = yield* fixture;
      expect(yield* store.status).toEqual({ authority: null, frozen: false, inventory: null });
      yield* store.writeSkill("old", "{}", 3);
      const inventory = yield* store.freeze("legacy-v1");
      expect(yield* store.status).toEqual({ authority: null, frozen: true, inventory });
      control.state = authority;
      expect(yield* store.status).toEqual({ authority, frozen: true, inventory });
      control.unavailable = true;
      expect((yield* store.status.pipe(Effect.flip)).reason).toBe("authority");
    }).pipe(Effect.scoped),
);

it.effect("current status also seals a stale live capability when control has appeared", () =>
  Effect.gen(function* () {
    const { store, control } = yield* fixture;
    control.state = authority;
    expect(yield* store.status).toEqual({ authority, frozen: true, inventory: null });
    control.state = null;
    expect(yield* store.status).toEqual({ authority: null, frozen: true, inventory: null });
    expect((yield* store.writeSkill("old", "{}", 3).pipe(Effect.flip)).reason).toBe("frozen");
  }).pipe(Effect.scoped),
);

it.effect("large rows use byte-bounded continuation pages without losing any inventory rows", () =>
  Effect.gen(function* () {
    const { store } = yield* fixture;
    const body = JSON.stringify({ body: "x".repeat(300000) });

    for (let index = 0; index < 7; index++) yield* store.writeSkill(String(index), body, 1);
    yield* store.freeze("large-pages");
    const first = yield* store.page("large-pages", 0);
    const second = yield* store.page("large-pages", 3);
    const last = yield* store.page("large-pages", 6);
    expect([first.length, second.length, last.length]).toEqual([3, 3, 1]);
    expect([...first, ...second, ...last].map((row) => row.id)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
    ]);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(2 * 1024 * 1024);
  }).pipe(Effect.scoped),
);

for (const [name, body] of [
  ["raw control characters", "\u0001".repeat(350000)],
  ["NUL after otherwise valid JSON", "{}\u0000".repeat(40000)],
] as const) {
  it.effect(`invalid ${name} refuses before materialization and retains the frozen ordinal`, () =>
    Effect.gen(function* () {
      const { store, database, queries } = yield* fixture;
      yield* store.writeSkill("old", body, 7);
      yield* store.freeze("invalid-encoding");
      queries.length = 0;

      const failed = yield* store.page("invalid-encoding", 0).pipe(
        Effect.match({
          onFailure: (error) => ({ reason: error.reason, ordinal: error.ordinal }),
          onSuccess: () => ({ reason: "unexpected-materialization", ordinal: 0 }),
        }),
      );

      expect([failed.reason, failed.ordinal]).toEqual(["invalid", 1]);
      expect(queries.some((query) => query.startsWith("SELECT ordinal,id,body"))).toBe(false);
      expect(
        database
          .prepare(
            "SELECT ordinal,length(CAST(body AS BLOB)) AS bytes FROM library_legacy_inventory",
          )
          .get(),
      ).toEqual({ ordinal: 1, bytes: Buffer.byteLength(body) });
      expect((yield* store.writeSkill("old", "{}", 8).pipe(Effect.flip)).reason).toBe("frozen");

      if (name === "raw control characters")
        expect(Buffer.byteLength(JSON.stringify({ body }))).toBeGreaterThan(2 * 1024 * 1024);
    }).pipe(Effect.scoped),
  );
}

it.effect("unsafe IDs including embedded NUL cannot escape the SQL wire-size precheck", () =>
  Effect.gen(function* () {
    const { store, queries } = yield* fixture;
    yield* store.writeSkill("old\u0000hidden", "{}", 7);
    yield* store.freeze("invalid-id");
    queries.length = 0;

    const failed = yield* store.page("invalid-id", 0).pipe(
      Effect.match({
        onFailure: (error) => ({ reason: error.reason, ordinal: error.ordinal }),
        onSuccess: () => ({ reason: "unexpected-materialization", ordinal: 0 }),
      }),
    );

    expect([failed.reason, failed.ordinal]).toEqual(["invalid", 1]);
    expect(queries.some((query) => query.startsWith("SELECT ordinal,id,body"))).toBe(false);
  }).pipe(Effect.scoped),
);
