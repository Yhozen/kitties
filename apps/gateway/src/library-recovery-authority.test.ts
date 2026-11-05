import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { expect } from "vite-plus/test";
import { GlobalRecoveryAuthority } from "./library-recovery-authority.ts";
import {
  LibraryRecoveryError,
  LibraryRecoveryState,
  LibraryRestoreIntent,
  type LibraryRestoreSource,
  type LibraryObjectRef,
} from "./library-recovery-records.ts";
import { LibraryRecoveryStore, type LibraryControlDatabase } from "./library-recovery-store.ts";

const codeDigest = "a".repeat(64);
const RestoreSources = Data.taggedEnum<LibraryRestoreSource>();

const fixture = Effect.gen(function* () {
  const sql = yield* Effect.acquireRelease(
    Effect.sync(() => new DatabaseSync(":memory:")),
    (database) => Effect.sync(() => database.close()),
  );

  let failCommit = false;

  const database: LibraryControlDatabase = {
    query: (statement, ...bindings) =>
      Schema.decodeUnknownSync(Schema.Array(Schema.JsonObject))(
        sql.prepare(statement).all(...bindings),
      ),
    transaction: (body) => {
      sql.exec("BEGIN IMMEDIATE");

      try {
        const result = body();

        if (failCommit) {
          failCommit = false;
          throw new Error("Commit interrupted");
        }

        sql.exec("COMMIT");

        return result;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  };

  sql.exec(
    "CREATE TABLE recovery_control (id INTEGER PRIMARY KEY,epoch INTEGER,operation_id TEXT,mode TEXT)",
  );
  sql.exec("INSERT INTO recovery_control VALUES (1,0,NULL,'ready')");
  sql.exec(
    "CREATE TABLE recovery_runs (workflow TEXT,id TEXT,epoch INTEGER,review INTEGER DEFAULT 0)",
  );
  sql.exec("INSERT INTO recovery_runs VALUES ('Restore','old',0,0),('Restore','future',100,0)");

  const authority = yield* GlobalRecoveryAuthority.pipe(
    Effect.provide(GlobalRecoveryAuthority.layer(database, () => 100)),
  );

  const attempt = <A>(body: () => A) =>
    Effect.try({
      try: () => database.transaction(body),
      catch: (cause) =>
        Schema.is(LibraryRecoveryError)(cause)
          ? cause
          : new LibraryRecoveryError({ reason: "storage" }),
    });

  const context = yield* Layer.build(LibraryRecoveryStore.layer(database, authority));

  return {
    database,
    authority,
    attempt,
    store: Context.get(context, LibraryRecoveryStore),
    control: () =>
      database.query("SELECT epoch,operation_id,mode FROM recovery_control WHERE id=1")[0],
    beginGlobal: (id: string) => attempt(() => authority.beginGlobal(id)),
    completeGlobal: (id: string) => attempt(() => authority.completeGlobal(id)),
    completePublication: (id: string) => attempt(() => authority.completePublication(id)),
    failCommit: Effect.sync(() => {
      failCommit = true;
    }),
  };
});

const source: LibraryObjectRef = {
  modelName: "LibraryModel",
  layout: 0,
  className: "LibraryModel.LibraryAggregate",
  lineage: "library-1",
  logicalName: "owner",
  physicalName: "r:library-1:owner",
  nativeId: "1".padStart(64, "0"),
};

const ready = Effect.fnUntraced(function* (store: LibraryRecoveryStore["Service"]) {
  yield* store.initialize("inventory");
  const ordinal = yield* store.register(source);
  yield* store.finishImport("inventory", 2);

  return ordinal;
});

const publishLibrary = Effect.fnUntraced(function* (f: Effect.Success<typeof fixture>) {
  const ordinal = yield* ready(f.store);
  yield* f.store.beginFreeze("library");
  yield* f.store.acknowledgeFreeze("library", ordinal, "before", null);
  yield* f.store.acknowledgeFreeze("library", ordinal, "before", "after");
  const image = { digest: "b".repeat(64), kvCount: 12, sqlCount: 3 };
  yield* f.store.recordImage("library", ordinal, image);
  yield* f.store.seal("library", 7, "a".repeat(64));
  yield* f.store.prepareRestore("library", "library");

  const destination = yield* f.store.register(
    {
      ...source,
      lineage: "library-2",
      physicalName: "r:library-2:owner",
      nativeId: "2".padStart(64, "0"),
    },
    "library",
  );

  yield* f.store.recordLoaded("library", ordinal, destination, image);
  yield* f.store.beginActivation("library");
  yield* f.store.acknowledgeActive("library", destination);

  return yield* f.store.publish("library", 7);
});

const publicationMarkers = (f: Effect.Success<typeof fixture>) =>
  f.database.query(
    "SELECT id,body FROM library_journal WHERE kind='publication-complete' ORDER BY id",
  );

it.effect("restore intent and destructive authority commit atomically before image work", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* ready(f.store);

    const intent = LibraryRestoreIntent.make({
      setId: "restore",
      codeDigest,
      source: RestoreSources.Retained({ archiveId: "archive", manifestDigest: "c".repeat(64) }),
    });

    yield* f.failCommit;
    expect(yield* Effect.flip(f.store.beginRestore("restore", intent))).toEqual(
      new LibraryRecoveryError({ reason: "storage" }),
    );
    expect(f.control()).toEqual({ epoch: 0, operation_id: null, mode: "ready" });
    expect(yield* f.store.status).toMatchObject({ phase: "ready", operationId: null });
    expect(yield* f.store.restoreIntent("restore")).toBeNull();
    expect(f.database.query("SELECT id,review FROM recovery_runs ORDER BY id")).toEqual([
      { id: "future", review: 0 },
      { id: "old", review: 0 },
    ]);
    yield* f.store.beginRestore("restore", intent);
    const acquired = { epoch: 100, operation_id: "restore", mode: "recovering" };
    expect(f.control()).toEqual(acquired);
    expect(f.database.query("SELECT id,review FROM recovery_runs ORDER BY id")).toEqual([
      { id: "future", review: 0 },
      { id: "old", review: 1 },
    ]);
    expect(
      yield* Effect.flip(
        f.store.beginRestore("restore", { ...intent, source: RestoreSources.Native() }),
      ),
    ).toEqual(new LibraryRecoveryError({ reason: "conflict" }));
    expect(yield* f.store.restoreIntent("restore")).toEqual(intent);
    expect(f.control()).toEqual(acquired);
    expect(yield* f.store.beginRestore("restore", intent)).toMatchObject({ phase: "frozen" });
    expect(f.control()).toEqual(acquired);
    expect(yield* Effect.flip(f.store.beginCapture("capture", codeDigest))).toEqual(
      new LibraryRecoveryError({ reason: "fenced" }),
    );
  }),
);

it.effect("capture quiesces Library without changing the global epoch or workflow review", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const ordinal = yield* ready(f.store);
    const control = f.control();
    yield* f.store.beginCapture("backup", codeDigest);
    expect(f.control()).toEqual(control);
    expect(yield* Effect.flip(f.beginGlobal("backup"))).toEqual(
      new LibraryRecoveryError({ reason: "conflict" }),
    );
    expect(yield* Effect.flip(f.beginGlobal("home"))).toEqual(
      new LibraryRecoveryError({ reason: "fenced" }),
    );
    expect(yield* Effect.flip(f.completeGlobal("backup"))).toEqual(
      new LibraryRecoveryError({ reason: "conflict" }),
    );
    expect(yield* Effect.flip(f.store.prepareRestore("backup", "backup"))).toEqual(
      new LibraryRecoveryError({ reason: "fenced" }),
    );
    yield* f.store.acknowledgeFreeze("backup", ordinal, "running", null);
    yield* f.store.acknowledgeFreeze("backup", ordinal, "running", "held");
    yield* f.store.recordImage("backup", ordinal, {
      digest: "b".repeat(64),
      kvCount: 1,
      sqlCount: 1,
    });
    yield* f.store.seal("backup", 7, "a".repeat(64));
    yield* f.store.beginCaptureResume("backup");
    expect(yield* Effect.flip(f.beginGlobal("home"))).toEqual(
      new LibraryRecoveryError({ reason: "fenced" }),
    );
    yield* f.store.acknowledgeResumed("backup", ordinal, "release", null);
    yield* f.store.acknowledgeResumed("backup", ordinal, "release", "fresh");
    const complete = yield* f.store.completeCapture("backup");
    expect(complete).toMatchObject({
      phase: "ready",
      epoch: 1,
      lineage: "library-1",
      nextLineage: 2,
    });
    expect(f.control()).toEqual({ epoch: 0, operation_id: null, mode: "ready" });
    expect(f.database.query("SELECT id,review FROM recovery_runs ORDER BY id")).toEqual([
      { id: "future", review: 0 },
      { id: "old", review: 0 },
    ]);
    yield* f.beginGlobal("home");
    expect(yield* f.store.completeCapture("backup")).toEqual(complete);
    expect(f.control()).toEqual({ epoch: 100, operation_id: "home", mode: "recovering" });
    expect(yield* Effect.flip(f.beginGlobal("backup"))).toEqual(
      new LibraryRecoveryError({ reason: "conflict" }),
    );
    expect(yield* Effect.flip(f.completeGlobal("backup"))).toEqual(
      new LibraryRecoveryError({ reason: "conflict" }),
    );
  }),
);

it.effect("retains destructive identities across completion so capture cannot adopt them", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* ready(f.store);
    yield* f.beginGlobal("home-first");
    yield* f.completeGlobal("home-first");
    yield* f.beginGlobal("home-second");
    yield* f.completeGlobal("home-second");
    const completed = f.control();
    expect(yield* Effect.flip(f.store.beginCapture("home-first", codeDigest))).toEqual(
      new LibraryRecoveryError({ reason: "conflict" }),
    );
    expect(yield* Effect.flip(f.store.beginFreeze("home-first"))).toEqual(
      new LibraryRecoveryError({ reason: "conflict" }),
    );
    expect(f.control()).toEqual(completed);
    yield* f.store.beginCapture("backup", codeDigest);
    expect(f.control()).toEqual(completed);
    expect(yield* Effect.flip(f.store.beginFreeze("backup"))).toEqual(
      new LibraryRecoveryError({ reason: "conflict" }),
    );
  }),
);

it.effect("capture acquisition rolls back and cannot overtake a destructive lease", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* ready(f.store);
    yield* f.failCommit;
    expect(yield* Effect.flip(f.store.beginCapture("backup", codeDigest))).toEqual(
      new LibraryRecoveryError({ reason: "storage" }),
    );
    expect(yield* f.store.status).toMatchObject({ phase: "ready", operationId: null });
    yield* f.beginGlobal("home");
    expect(yield* Effect.flip(f.store.beginCapture("backup", codeDigest))).toEqual(
      new LibraryRecoveryError({ reason: "fenced" }),
    );
    yield* f.completeGlobal("home");
    expect(yield* f.store.beginCapture("backup", codeDigest)).toMatchObject({
      phase: "frozen",
      operationKind: "capture",
    });
  }),
);

it.effect(
  "a later destructive begin reserves the known pre-journal owner before replacing it",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* ready(f.store);
      f.database.query(
        "UPDATE recovery_control SET epoch=50,operation_id='historical',mode='ready' WHERE id=1",
      );
      yield* f.beginGlobal("next");
      yield* f.completeGlobal("next");
      expect(yield* Effect.flip(f.store.beginCapture("historical", codeDigest))).toEqual(
        new LibraryRecoveryError({ reason: "conflict" }),
      );
      expect(f.control()).toEqual({ epoch: 100, operation_id: "next", mode: "ready" });
    }),
);

it.effect("read and journal setup stay available before global authority exists", () =>
  Effect.gen(function* () {
    const { database, authority } = yield* fixture;
    database.query("DELETE FROM recovery_control");

    expect(
      yield* Effect.exit(Effect.sync(() => authority.authorize({ kind: "read" }))),
    ).toMatchObject({ value: undefined });
    const context = yield* Layer.build(LibraryRecoveryStore.layer(database, authority));
    const store = Context.get(context, LibraryRecoveryStore);
    expect(yield* store.status).toBeNull();
    expect(yield* Effect.flip(store.initialize("inventory"))).toEqual(
      new LibraryRecoveryError({ reason: "uninitialized" }),
    );
  }),
);

it.effect(
  "legacy Home recovery keeps its owner and epoch on retry and completes idempotently",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const owner = "legacy:home snapshot";

      expect(yield* f.beginGlobal(owner)).toEqual({
        epoch: 100,
        operation_id: owner,
        mode: "recovering",
      });
      expect(yield* f.beginGlobal(owner)).toEqual({
        epoch: 100,
        operation_id: owner,
        mode: "recovering",
      });
      expect(f.database.query("SELECT id,review FROM recovery_runs ORDER BY id")).toEqual([
        { id: "future", review: 0 },
        { id: "old", review: 1 },
      ]);
      expect(yield* Effect.flip(f.beginGlobal("other"))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(yield* Effect.flip(f.completeGlobal("other"))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(yield* f.completeGlobal(owner)).toEqual({
        epoch: 100,
        operation_id: owner,
        mode: "ready",
      });
      expect(yield* f.completeGlobal(owner)).toEqual({
        epoch: 100,
        operation_id: owner,
        mode: "ready",
      });
      expect(yield* Effect.flip(f.beginGlobal(owner))).toEqual(
        new LibraryRecoveryError({ reason: "conflict" }),
      );
      expect(yield* f.beginGlobal("next")).toEqual({
        epoch: 101,
        operation_id: "next",
        mode: "recovering",
      });
    }),
);

it.effect(
  "global Home restore blocks normal library bootstrap, writes and admission without blocking status",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.beginGlobal("home");
      expect(yield* f.store.status).toBeNull();
      expect(yield* Effect.flip(f.store.initialize("inventory"))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      yield* f.completeGlobal("home");
      yield* ready(f.store);
      yield* f.beginGlobal("home-next");
      expect(yield* f.store.status).toMatchObject({ phase: "ready", epoch: 1 });
      expect(yield* Effect.flip(f.store.admit(1))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(yield* Effect.flip(f.store.finishImport("inventory", 2))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(yield* Effect.flip(f.store.register(source))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(yield* Effect.flip(f.store.beginFreeze("foreign-library-owner"))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      yield* f.completeGlobal("home-next");
      expect(yield* f.store.admit(1)).toEqual({
        libraryId: "owner",
        epoch: 1,
        lineage: "library-1",
      });
    }),
);

it.effect("unfinished import cannot be claimed by global recovery and resumes normally", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.store.initialize("inventory");
    expect(yield* Effect.flip(f.beginGlobal("home"))).toEqual(
      new LibraryRecoveryError({ reason: "fenced" }),
    );
    expect(yield* Effect.flip(f.store.beginFreeze("library"))).toEqual(
      new LibraryRecoveryError({ reason: "fenced" }),
    );
    expect(f.control()).toEqual({ epoch: 0, operation_id: null, mode: "ready" });
    yield* f.store.register(source);
    yield* f.store.finishImport("inventory", 2);
    expect(yield* f.beginGlobal("home")).toMatchObject({
      mode: "recovering",
      operation_id: "home",
    });
  }),
);

it.effect(
  "a failed journal commit rolls back the global claim, epoch, reviews and library phase together",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* ready(f.store);
      yield* f.failCommit;
      expect(yield* Effect.flip(f.store.beginFreeze("library"))).toEqual(
        new LibraryRecoveryError({ reason: "storage" }),
      );
      expect(f.control()).toEqual({ epoch: 0, operation_id: null, mode: "ready" });
      expect(f.database.query("SELECT review FROM recovery_runs WHERE id='old'")).toEqual([
        { review: 0 },
      ]);
      expect(yield* f.store.status).toMatchObject({ phase: "ready", operationId: null });
      expect(yield* f.store.beginFreeze("library")).toMatchObject({
        phase: "frozen",
        operationId: "library",
      });
      expect(f.control()).toEqual({ epoch: 100, operation_id: "library", mode: "recovering" });
    }),
);

it.effect(
  "only the owning recovery can progress, and completion waits for published library authority",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const ordinal = yield* ready(f.store);
      yield* f.store.beginFreeze("library");
      expect(yield* f.store.beginFreeze("library")).toMatchObject({ phase: "frozen" });
      expect(yield* Effect.flip(f.beginGlobal("other"))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(yield* Effect.flip(f.completeGlobal("library"))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(
        yield* Effect.flip(
          f.attempt(() => f.authority.authorize({ kind: "operation", operationId: "other" })),
        ),
      ).toEqual(new LibraryRecoveryError({ reason: "fenced" }));
      yield* f.store.acknowledgeFreeze("library", ordinal, "before", null);
      yield* f.store.acknowledgeFreeze("library", ordinal, "before", "after");
      const image = { digest: "b".repeat(64), kvCount: 12, sqlCount: 3 };
      yield* f.store.recordImage("library", ordinal, image);
      yield* f.store.seal("library", 7, "a".repeat(64));
      yield* f.store.prepareRestore("library", "library");
      expect(yield* Effect.flip(f.completeGlobal("library"))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );

      const destination = yield* f.store.register(
        {
          ...source,
          lineage: "library-2",
          physicalName: "r:library-2:owner",
          nativeId: "2".padStart(64, "0"),
        },
        "library",
      );

      yield* f.store.recordLoaded("library", ordinal, destination, image);
      yield* f.store.beginActivation("library");
      expect(yield* Effect.flip(f.completeGlobal("library"))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      yield* f.store.acknowledgeActive("library", destination);
      const published = yield* f.store.publish("library", 7);
      expect(published).toMatchObject({ lineage: "library-2", epoch: 2, allocatorFloor: 7 });
      expect(yield* Effect.flip(f.store.admit(2))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(yield* f.completeGlobal("library")).toMatchObject({ mode: "ready", epoch: 100 });
      expect(yield* f.store.publish("library", 0)).toEqual(published);
      expect(yield* f.store.admit(2)).toEqual({
        libraryId: "owner",
        epoch: 2,
        lineage: "library-2",
      });
      expect(
        yield* Effect.flip(
          f.attempt(() => f.authority.authorize({ kind: "operation", operationId: "library" })),
        ),
      ).toEqual(new LibraryRecoveryError({ reason: "fenced" }));
    }),
);

it.effect("the independent unfinished authority cannot be bypassed by a ready global marker", () =>
  Effect.gen(function* () {
    const f = yield* fixture;

    const phases: ReadonlyArray<LibraryRecoveryState["phase"]> = [
      "importing",
      "frozen",
      "staging",
      "activating",
    ];

    for (const phase of phases) {
      const state = LibraryRecoveryState.make({
        libraryId: "owner",
        epoch: 1,
        lineage: "library-1",
        nextLineage: 2,
        phase,
        inventoryId: "inventory",
        operationId: phase === "importing" ? null : "owner",
        stagingLineage: null,
        allocatorFloor: 7,
      });

      f.database.query(
        "INSERT OR REPLACE INTO library_control VALUES (1,?)",
        JSON.stringify(state),
      );
      expect(yield* Effect.flip(f.beginGlobal("other"))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(f.control()).toEqual({ epoch: 0, operation_id: null, mode: "ready" });
    }

    expect(yield* f.beginGlobal("owner")).toEqual({
      epoch: 100,
      operation_id: "owner",
      mode: "recovering",
    });
    expect(yield* f.beginGlobal("owner")).toEqual({
      epoch: 100,
      operation_id: "owner",
      mode: "recovering",
    });
  }),
);

it.effect("invalid Library IDs and exhausted global epochs fail before changing authority", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    expect(
      yield* Effect.flip(
        f.attempt(() => f.authority.authorize({ kind: "begin", operationId: "invalid/id" })),
      ),
    ).toEqual(new LibraryRecoveryError({ reason: "invalid" }));
    f.database.query("UPDATE recovery_control SET epoch=? WHERE id=1", Number.MAX_SAFE_INTEGER);
    expect(yield* Effect.flip(f.beginGlobal("last"))).toEqual(
      new LibraryRecoveryError({ reason: "exhausted" }),
    );
    expect(f.control()).toEqual({
      epoch: Number.MAX_SAFE_INTEGER,
      operation_id: null,
      mode: "ready",
    });
  }),
);

it.effect(
  "publication completion requires a ready immutable receipt and preserves unfinished authority",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      expect(yield* Effect.flip(f.completePublication("missing"))).toEqual(
        new LibraryRecoveryError({ reason: "incomplete" }),
      );
      expect(f.control()).toEqual({ epoch: 0, operation_id: null, mode: "ready" });
      expect(publicationMarkers(f)).toEqual([]);
      const published = yield* publishLibrary(f);
      f.database.query(
        "UPDATE library_control SET body=? WHERE id=1",
        JSON.stringify({ ...published, phase: "frozen", operationId: "library" }),
      );
      expect(yield* Effect.flip(f.completePublication("library"))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(f.control()).toEqual({ epoch: 100, operation_id: "library", mode: "recovering" });
      expect(publicationMarkers(f)).toEqual([]);
    }),
);

it.effect(
  "completed Library publication replays across a later Home recovery without changing its owner",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const published = yield* publishLibrary(f);
      const first = yield* f.completePublication("library");
      expect(first).toEqual({ epoch: 100, operation_id: "library", mode: "ready" });
      expect(publicationMarkers(f)).toEqual([{ id: "library", body: '{"libraryEpoch":2}' }]);
      expect(yield* f.completePublication("library")).toEqual(first);
      const home = yield* f.beginGlobal("home-next");
      expect(yield* f.completePublication("library")).toEqual(home);
      expect(f.control()).toEqual({ epoch: 101, operation_id: "home-next", mode: "recovering" });
      expect(yield* Effect.flip(f.completeGlobal("library"))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      const finishedHome = yield* f.completeGlobal("home-next");
      expect(yield* f.completePublication("library")).toEqual(finishedHome);
      expect(yield* f.store.status).toEqual(published);
      expect(yield* Effect.flip(f.beginGlobal("library"))).toEqual(
        new LibraryRecoveryError({ reason: "conflict" }),
      );
      expect(f.control()).toEqual(finishedHome);
    }),
);

it.effect(
  "an older publication without a completion marker records history without closing another global fence",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* publishLibrary(f);
      yield* f.completeGlobal("library");
      const home = yield* f.beginGlobal("home-next");
      expect(publicationMarkers(f)).toEqual([]);
      expect(yield* f.completePublication("library")).toEqual(home);
      expect(f.control()).toEqual({ epoch: 101, operation_id: "home-next", mode: "recovering" });
      expect(publicationMarkers(f)).toEqual([{ id: "library", body: '{"libraryEpoch":2}' }]);
      yield* f.completeGlobal("home-next");
      expect(yield* Effect.flip(f.beginGlobal("library"))).toEqual(
        new LibraryRecoveryError({ reason: "conflict" }),
      );
    }),
);

it.effect("an unmarked published Library identity cannot be reopened by a legacy recovery", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* publishLibrary(f);
    yield* f.completeGlobal("library");
    yield* f.beginGlobal("home-next");
    const finishedHome = yield* f.completeGlobal("home-next");
    expect(publicationMarkers(f)).toEqual([]);
    expect(yield* Effect.flip(f.beginGlobal("library"))).toEqual(
      new LibraryRecoveryError({ reason: "conflict" }),
    );
    expect(f.control()).toEqual(finishedHome);
  }),
);

it.effect(
  "publication completion and its marker roll back atomically and survive authority reconstruction",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* publishLibrary(f);
      yield* f.failCommit;
      expect(yield* Effect.flip(f.completePublication("library"))).toEqual(
        new LibraryRecoveryError({ reason: "storage" }),
      );
      expect(f.control()).toEqual({ epoch: 100, operation_id: "library", mode: "recovering" });
      expect(publicationMarkers(f)).toEqual([]);
      yield* f.completePublication("library");
      expect(publicationMarkers(f)).toEqual([{ id: "library", body: '{"libraryEpoch":2}' }]);
      // Simulate a previous deployment reusing the string identity. A retained marker
      // must keep a stale publication retry from closing that different incarnation.
      f.database.query("UPDATE recovery_control SET epoch=101,mode='recovering' WHERE id=1");

      const rebuilt = yield* GlobalRecoveryAuthority.pipe(
        Effect.provide(GlobalRecoveryAuthority.layer(f.database, () => 200)),
      );

      expect(yield* f.attempt(() => rebuilt.completePublication("library"))).toEqual({
        epoch: 101,
        operation_id: "library",
        mode: "recovering",
      });
      expect(f.control()).toEqual({ epoch: 101, operation_id: "library", mode: "recovering" });
      expect(publicationMarkers(f)).toEqual([{ id: "library", body: '{"libraryEpoch":2}' }]);
    }),
);
