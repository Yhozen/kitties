import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  LibraryObjectImage,
  LibraryObjectRef,
  LibraryRecoveryError,
} from "./library-recovery-records.ts";
import { LibraryRecoveryStore, type LibraryControlDatabase } from "./library-recovery-store.ts";

const CODE = "a".repeat(64);
const IMAGE = LibraryObjectImage.make({ digest: "b".repeat(64), kvCount: 12, sqlCount: 3 });

const objectRef = (lineage = "library-1", id = 1, logicalName = "owner"): LibraryObjectRef => ({
  modelName: "LibraryModel",
  layout: 0,
  className: "LibraryModel.LibraryAggregate",
  lineage,
  logicalName,
  physicalName: `r:${lineage}:${logicalName}`,
  nativeId: String(id).padStart(64, "0"),
});

const databaseFixture = Effect.gen(function* () {
  const database = yield* Effect.acquireRelease(
    Effect.sync(() => new DatabaseSync(":memory:")),
    (database) => Effect.sync(() => database.close()),
  );

  let failNextCommit = false;

  const port: LibraryControlDatabase = {
    query: (statement, ...bindings) =>
      Schema.decodeUnknownSync(Schema.Array(Schema.JsonObject))(
        database.prepare(statement).all(...bindings),
      ),
    transaction: (body) => {
      database.exec("BEGIN IMMEDIATE");

      try {
        const result = body();

        if (failNextCommit) {
          failNextCommit = false;
          throw new Error("Injected commit interruption");
        }

        database.exec("COMMIT");

        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };

  const restart = Effect.gen(function* () {
    const context = yield* Layer.build(LibraryRecoveryStore.layer(port, { authorize: () => {} }));

    return Context.get(context, LibraryRecoveryStore);
  });

  return {
    store: yield* restart,
    restart,
    failCommit: Effect.sync(() => {
      failNextCommit = true;
    }),
  };
});

const ready = Effect.fnUntraced(function* (store: LibraryRecoveryStore["Service"]) {
  yield* store.initialize("legacy-inventory");
  const ordinal = yield* store.register(objectRef());
  yield* store.finishImport("legacy-inventory", 2);

  return ordinal;
});

const capture = Effect.fnUntraced(function* (
  store: LibraryRecoveryStore["Service"],
  operationId: string,
  floor: number,
) {
  const state = yield* store.beginFreeze(operationId);
  const objects = yield* store.inventory(state.lineage);

  for (const object of objects) {
    yield* store.acknowledgeFreeze(operationId, object.ordinal, "before", null);
    yield* store.acknowledgeFreeze(operationId, object.ordinal, "before", "after");
    yield* store.recordImage(operationId, object.ordinal, IMAGE);
  }

  return yield* store.seal(operationId, floor, CODE);
});

const stage = Effect.fnUntraced(function* (
  store: LibraryRecoveryStore["Service"],
  operationId: string,
  setId: string,
  sourceOrdinal = 1,
  destinationId = 2,
) {
  const state = yield* store.prepareRestore(operationId, setId);

  const destination = yield* store.register(
    objectRef(state.stagingLineage!, destinationId),
    operationId,
  );

  yield* store.recordLoaded(operationId, sourceOrdinal, destination, IMAGE);
  yield* store.beginActivation(operationId);
  yield* store.acknowledgeActive(operationId, destination);

  return destination;
});

it.effect("authorizes only the selected sealed capture while restoring a retired lineage", () =>
  Effect.gen(function* () {
    const { store } = yield* databaseFixture;
    const original = yield* ready(store);
    yield* capture(store, "first", 5);
    const second = yield* stage(store, "first", "first", original, 2);
    yield* store.publish("first", 5);
    yield* capture(store, "restore-old", 9);
    yield* store.prepareRestore("restore-old", "first");

    expect(yield* store.authorizeCapture("restore-old", "first", original)).toEqual(IMAGE);
    expect(yield* Effect.flip(store.authorizeCapture("first", "first", original))).toEqual(
      new LibraryRecoveryError({ reason: "conflict" }),
    );
    expect(
      yield* Effect.flip(store.authorizeCapture("restore-old", "restore-old", second)),
    ).toEqual(new LibraryRecoveryError({ reason: "fenced" }));
    expect(yield* Effect.flip(store.authorizeCapture("restore-old", "first", second))).toEqual(
      new LibraryRecoveryError({ reason: "fenced" }),
    );
  }),
);

it.effect("keeps an absent or unfinished import closed and never overwrites its inventory", () =>
  Effect.gen(function* () {
    const { store } = yield* databaseFixture;
    expect(yield* store.status).toBeNull();
    expect(yield* Effect.flip(store.admit(1))).toEqual(
      new LibraryRecoveryError({ reason: "uninitialized" }),
    );
    expect(yield* store.initialize("legacy-inventory")).toMatchObject({
      phase: "importing",
      epoch: 1,
    });
    expect(yield* Effect.flip(store.admit(1))).toEqual(
      new LibraryRecoveryError({ reason: "fenced" }),
    );
    expect(yield* Effect.flip(store.initialize("replacement"))).toEqual(
      new LibraryRecoveryError({ reason: "conflict" }),
    );
    yield* store.finishImport("legacy-inventory", 7);
    yield* store.finishImport("legacy-inventory", 7);
    expect(yield* store.admit(1)).toEqual({ libraryId: "owner", epoch: 1, lineage: "library-1" });
    expect(yield* Effect.flip(store.finishImport("legacy-inventory", 0))).toEqual(
      new LibraryRecoveryError({ reason: "conflict" }),
    );
    expect(yield* store.status).toMatchObject({ allocatorFloor: 7 });
  }),
);

it.effect(
  "registers an identity before invocation and rejects conflicting names or native IDs",
  () =>
    Effect.gen(function* () {
      const { store, restart } = yield* databaseFixture;
      yield* store.initialize("legacy-inventory");
      expect(yield* store.register(objectRef())).toBe(1);
      expect(yield* store.register(objectRef())).toBe(1);
      const afterCrash = yield* restart;
      expect(yield* afterCrash.inventory("library-1")).toEqual([
        { ...objectRef(), ordinal: 1, phase: "importing" },
      ]);
      expect(yield* Effect.flip(afterCrash.register(objectRef("library-1", 2)))).toEqual(
        new LibraryRecoveryError({ reason: "conflict" }),
      );
      expect(yield* Effect.flip(afterCrash.register(objectRef("library-1", 1, "foreign")))).toEqual(
        new LibraryRecoveryError({ reason: "conflict" }),
      );
      expect(yield* afterCrash.lookup("LibraryModel.LibraryAggregate", "f".repeat(64))).toBeNull();
    }),
);

it.effect("pages the complete registry without omitting a registration at the page boundary", () =>
  Effect.gen(function* () {
    const { store } = yield* databaseFixture;
    yield* store.initialize("legacy-inventory");

    for (let index = 1; index <= 70; index++)
      yield* store.register(objectRef("library-1", index, `key-${index}`));

    const first = yield* store.inventory("library-1");
    const second = yield* store.inventory("library-1", 64);
    expect(first).toHaveLength(64);
    expect(first.at(-1)?.logicalName).toBe("key-64");
    expect(second.map((item) => item.logicalName)).toEqual([
      "key-65",
      "key-66",
      "key-67",
      "key-68",
      "key-69",
      "key-70",
    ]);
    expect(yield* store.inventory("library-1", 70)).toEqual([]);
  }),
);

it.effect(
  "freezing closes admission and new background registration before capturing any object",
  () =>
    Effect.gen(function* () {
      const { store } = yield* databaseFixture;
      yield* ready(store);
      yield* store.beginFreeze("restore-one");
      expect(yield* Effect.flip(store.admit(1))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(yield* Effect.flip(store.register(objectRef("library-1", 2, "new-key")))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(yield* Effect.flip(store.register(objectRef()))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(yield* Effect.flip(store.beginFreeze("other-operation"))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(
        yield* store.lookup("LibraryModel.LibraryAggregate", objectRef().nativeId),
      ).toMatchObject({ phase: "frozen" });
    }),
);

it.effect(
  "requires a durable freeze acknowledgement and a distinct constructor before image capture",
  () =>
    Effect.gen(function* () {
      const { store } = yield* databaseFixture;
      const ordinal = yield* ready(store);
      yield* store.beginFreeze("capture-one");
      expect(yield* Effect.flip(store.acknowledgeFreeze("capture-one", ordinal, "a", "b"))).toEqual(
        new LibraryRecoveryError({ reason: "incomplete" }),
      );
      yield* store.acknowledgeFreeze("capture-one", ordinal, "a", null);
      expect(yield* Effect.flip(store.recordImage("capture-one", ordinal, IMAGE))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(yield* Effect.flip(store.acknowledgeFreeze("capture-one", ordinal, "a", "a"))).toEqual(
        new LibraryRecoveryError({ reason: "invalid" }),
      );
      yield* store.acknowledgeFreeze("capture-one", ordinal, "a", "b");
      yield* store.recordImage("capture-one", ordinal, IMAGE);
      expect(yield* store.seal("capture-one", 3, CODE)).toMatchObject({
        objectCount: 1,
        allocatorFloor: 3,
      });
      expect(
        yield* Effect.flip(
          store.recordImage("capture-one", ordinal, { ...IMAGE, digest: "c".repeat(64) }),
        ),
      ).toEqual(new LibraryRecoveryError({ reason: "conflict" }));
    }),
);

it.effect("does not seal a partial capture or select a missing recovery set", () =>
  Effect.gen(function* () {
    const { store } = yield* databaseFixture;
    yield* ready(store);
    yield* store.beginFreeze("capture-one");
    expect(yield* Effect.flip(store.seal("capture-one", 3, CODE))).toEqual(
      new LibraryRecoveryError({ reason: "incomplete" }),
    );
    expect(yield* Effect.flip(store.prepareRestore("capture-one", "missing"))).toEqual(
      new LibraryRecoveryError({ reason: "incomplete" }),
    );
    expect(yield* store.status).toMatchObject({
      phase: "frozen",
      nextLineage: 2,
      stagingLineage: null,
    });
  }),
);

it.effect(
  "rejects mismatched copied images and keeps staging inaccessible to public operations",
  () =>
    Effect.gen(function* () {
      const { store } = yield* databaseFixture;
      yield* ready(store);
      yield* capture(store, "restore-one", 7);
      yield* store.prepareRestore("restore-one", "restore-one");
      expect(yield* Effect.flip(store.register(objectRef("library-2", 2)))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      const destination = yield* store.register(objectRef("library-2", 2), "restore-one");
      expect(
        yield* Effect.flip(
          store.recordLoaded("restore-one", 1, destination, { ...IMAGE, kvCount: 11 }),
        ),
      ).toEqual(new LibraryRecoveryError({ reason: "conflict" }));
      expect(yield* Effect.flip(store.beginActivation("restore-one"))).toEqual(
        new LibraryRecoveryError({ reason: "incomplete" }),
      );
      expect(yield* Effect.flip(store.admit(2))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      yield* store.recordLoaded("restore-one", 1, destination, IMAGE);
      yield* store.beginActivation("restore-one");
      expect(yield* Effect.flip(store.publish("restore-one", 7))).toEqual(
        new LibraryRecoveryError({ reason: "incomplete" }),
      );
    }),
);

it.effect("resumes the same staged lineage after restart and publishes exactly once", () =>
  Effect.gen(function* () {
    const { store, restart } = yield* databaseFixture;
    yield* ready(store);
    yield* capture(store, "restore-one", 7);
    yield* store.prepareRestore("restore-one", "restore-one");
    const restarted = yield* restart;
    expect(yield* restarted.prepareRestore("restore-one", "restore-one")).toMatchObject({
      stagingLineage: "library-2",
      nextLineage: 3,
    });
    yield* stage(restarted, "restore-one", "restore-one");
    const published = yield* restarted.publish("restore-one", 7);
    expect(published).toMatchObject({
      phase: "ready",
      epoch: 2,
      lineage: "library-2",
      allocatorFloor: 7,
    });
    expect(yield* restarted.publish("restore-one", 7)).toEqual(published);
    expect(yield* Effect.flip(restarted.beginFreeze("restore-one"))).toEqual(
      new LibraryRecoveryError({ reason: "conflict" }),
    );
    expect(yield* Effect.flip(restarted.admit(1))).toEqual(
      new LibraryRecoveryError({ reason: "fenced" }),
    );
    expect(yield* restarted.resolve(1)).toBe("library-1");
    expect(yield* restarted.admit(2)).toEqual({
      libraryId: "owner",
      epoch: 2,
      lineage: "library-2",
    });
  }),
);

it.effect(
  "freezes restored membership during activation and permits new work only after publication",
  () =>
    Effect.gen(function* () {
      const { store } = yield* databaseFixture;
      yield* ready(store);
      yield* capture(store, "restore-one", 7);
      yield* stage(store, "restore-one", "restore-one");
      expect(yield* store.register(objectRef("library-2", 2), "restore-one")).toBe(2);
      expect(
        yield* Effect.flip(
          store.register(objectRef("library-2", 3, "new-pending-key"), "restore-one"),
        ),
      ).toEqual(new LibraryRecoveryError({ reason: "fenced" }));
      yield* store.publish("restore-one", 7);
      expect(yield* store.register(objectRef("library-2", 3, "new-pending-key"))).toBe(3);
    }),
);

it.effect("a lower capture report cannot reduce the durable allocator floor", () =>
  Effect.gen(function* () {
    const { store, restart } = yield* databaseFixture;
    yield* ready(store);

    expect(yield* capture(store, "lower-report", 0)).toMatchObject({ allocatorFloor: 2 });

    const reconstructed = yield* restart;

    expect(yield* reconstructed.status).toMatchObject({ allocatorFloor: 2, phase: "frozen" });
  }),
);

it.effect("retains the outgoing allocator floor when restoring an older set", () =>
  Effect.gen(function* () {
    const { store } = yield* databaseFixture;
    yield* ready(store);
    yield* capture(store, "first", 7);
    yield* stage(store, "first", "first");
    yield* store.publish("first", 7);
    yield* capture(store, "second", 12);
    yield* stage(store, "second", "first", 1, 3);
    expect(yield* Effect.flip(store.publish("second", 7))).toEqual(
      new LibraryRecoveryError({ reason: "incomplete" }),
    );
    expect(yield* store.publish("second", 12)).toMatchObject({
      epoch: 3,
      lineage: "library-3",
      allocatorFloor: 12,
    });
    expect(yield* Effect.flip(store.register(objectRef("library-1", 1)))).toEqual(
      new LibraryRecoveryError({ reason: "fenced" }),
    );
    expect(yield* Effect.flip(store.admit(2))).toEqual(
      new LibraryRecoveryError({ reason: "fenced" }),
    );
    expect(yield* store.resolve(2)).toBe("library-2");
    expect(
      yield* store.lookup("LibraryModel.LibraryAggregate", objectRef().nativeId),
    ).toMatchObject({ phase: "retired" });
  }),
);

it.effect("rolls back both authority pointers if publication loses its transaction", () =>
  Effect.gen(function* () {
    const { store, failCommit, restart } = yield* databaseFixture;
    yield* ready(store);
    yield* capture(store, "restore-one", 7);
    yield* stage(store, "restore-one", "restore-one");
    yield* failCommit;
    expect(yield* Effect.flip(store.publish("restore-one", 7))).toEqual(
      new LibraryRecoveryError({ reason: "storage" }),
    );
    const restarted = yield* restart;
    expect(yield* restarted.status).toMatchObject({
      phase: "activating",
      epoch: 1,
      lineage: "library-1",
    });
    expect(
      yield* restarted.lookup("LibraryModel.LibraryAggregate", objectRef().nativeId),
    ).toMatchObject({ phase: "frozen" });
    expect(yield* Effect.flip(restarted.admit(2))).toEqual(
      new LibraryRecoveryError({ reason: "fenced" }),
    );
    expect(yield* restarted.publish("restore-one", 7)).toMatchObject({
      epoch: 2,
      lineage: "library-2",
    });
  }),
);
