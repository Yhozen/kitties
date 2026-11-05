import { DatabaseSync } from "node:sqlite";
import * as InMemory from "@alchemy.run/domain/InMemory";
import { LibraryModel } from "@kitties/domain/Library.model";
import { it } from "@effect/vitest";
import { Clock, Data, Deferred, Effect, Fiber, Layer, Redacted, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";
import { LibraryArchiveOperations } from "./library-archive-operations.ts";
import { LibraryControl } from "./library-control.ts";
import { encodeLibraryValue, libraryImageDigest } from "./library-image.ts";
import { LibraryImagePart } from "./library-object-admin.ts";
import { GlobalRecoveryAuthority } from "./library-recovery-authority.ts";
import { LibraryRecoveryCoordinator } from "./library-recovery-coordinator.ts";
import { LibraryObjectAdministration } from "./library-recovery-host.ts";
import {
  LibraryObjectRef,
  LibraryRecoveryError,
  type LibraryRestoreSource,
} from "./library-recovery-records.ts";
import { LibraryRecoveryStore, type LibraryControlDatabase } from "./library-recovery-store.ts";
import {
  LibraryArchiveError,
  LibraryRetainedArchiveJournal,
} from "./library-retained-archive-store.ts";
import {
  LibraryArchiveCaptureSource,
  LibraryArchiveKey,
  LibraryArchiveObjects,
  LibraryArchivePolicy,
  LibraryRetainedArchive,
} from "./library-retained-archive.ts";

const CODE = "a".repeat(64);
const Sources = Data.taggedEnum<LibraryRestoreSource>();
const request = { operationId: "restore", archiveId: "archive", codeDigest: CODE };

const fixture = Effect.gen(function* () {
  const sql = yield* Effect.acquireRelease(
    Effect.sync(() => new DatabaseSync(":memory:")),
    (database) => Effect.sync(() => database.close()),
  );

  const database: LibraryControlDatabase = {
    query: (statement, ...bindings) =>
      Schema.decodeUnknownSync(Schema.Array(Schema.JsonObject))(
        sql.prepare(statement).all(...bindings),
      ),
    transaction: (body) => {
      sql.exec("BEGIN IMMEDIATE");

      try {
        const value = body();
        sql.exec("COMMIT");

        return value;
      } catch (cause) {
        sql.exec("ROLLBACK");
        throw cause;
      }
    },
  };

  sql.exec(
    "CREATE TABLE recovery_control (id INTEGER PRIMARY KEY,epoch INTEGER,operation_id TEXT,mode TEXT)",
  );
  sql.exec("INSERT INTO recovery_control VALUES (1,7,NULL,'ready')");
  sql.exec("CREATE TABLE recovery_runs (workflow TEXT,id TEXT,epoch INTEGER,review INTEGER)");

  const authority = yield* GlobalRecoveryAuthority.pipe(
    Effect.provide(GlobalRecoveryAuthority.layer(database, () => 100)),
  );

  const completePublication = (id: string) =>
    Effect.try({
      try: () => {
        database.transaction(() => {
          authority.completePublication(id);
        });
      },
      catch: (cause) =>
        Schema.is(LibraryRecoveryError)(cause)
          ? cause
          : new LibraryRecoveryError({ reason: "storage" }),
    });

  const storeLayer = LibraryRecoveryStore.layer(database, authority);
  const store = yield* LibraryRecoveryStore.pipe(Effect.provide(storeLayer));
  yield* store.initialize("inventory");

  const source = LibraryObjectRef.make({
    modelName: "LibraryModel",
    layout: 0,
    className: "LibraryModel.LibraryAggregate",
    lineage: "library-1",
    logicalName: "owner",
    physicalName: "r:library-1:owner",
    nativeId: "1".repeat(64),
  });

  const ordinal = yield* store.register(source);
  yield* store.finishImport("inventory", 3);
  const body = encodeLibraryValue(null);
  const digest = yield* libraryImageDigest(body);
  const initial = yield* libraryImageDigest("kitties-library-image-v1");

  const image = {
    digest: yield* libraryImageDigest(`${initial}\nalarm\nalarm\n${digest}`),
    kvCount: 0,
    sqlCount: 0,
  };

  const part = LibraryImagePart.make({
    row: 1,
    kind: "alarm",
    key: "alarm",
    digest,
    part: 0,
    parts: 1,
    chars: body.length,
    chunk: body,
  });

  yield* store.beginCapture("capture", CODE);
  yield* store.acknowledgeFreeze("capture", ordinal, "running", null);
  yield* store.acknowledgeFreeze("capture", ordinal, "running", "held");
  yield* store.recordImage("capture", ordinal, image);
  const set = yield* store.seal("capture", 3, CODE);
  yield* store.beginCaptureResume("capture");
  yield* store.acknowledgeResumed("capture", ordinal, "resume", null);
  yield* store.acknowledgeResumed("capture", ordinal, "resume", "fresh");
  yield* store.completeCapture("capture");
  yield* store.grantExport("export", "capture");
  const reachedManifest = yield* Deferred.make<void>();
  const releasedManifest = yield* Deferred.make<void>();
  const reachedAdmin = yield* Deferred.make<void>();
  const adminCalls: Array<string> = [];
  const objectReads: Array<string> = [];
  const retained = new Map<string, { body: string; uploadedAt: number }>();
  let mode: "open" | "failure" | "timeout" = "open";

  // Only object storage and admin I/O are controlled. Both journals, encrypted
  // archive source, operations and raw restore coordinator are production code.
  const objects = LibraryArchiveObjects.of({
    get: (key) =>
      Effect.gen(function* () {
        objectReads.push(key);

        if (mode !== "open" && key.endsWith("/manifest.json")) {
          yield* Deferred.succeed(reachedManifest, undefined);

          if (mode === "failure") return yield* new LibraryArchiveError({ reason: "storage" });

          return yield* Effect.never.pipe(
            Effect.ensuring(Deferred.succeed(releasedManifest, undefined)),
          );
        }

        return retained.get(key) ?? null;
      }),
    putIfAbsent: (key, value) =>
      Effect.gen(function* () {
        if (!retained.has(key))
          retained.set(key, { body: value, uploadedAt: yield* Clock.currentTimeMillis });
      }),
  });

  const captureSource = LibraryArchiveCaptureSource.of({
    recoverySet: () => Effect.succeed(set),
    inventory: (_, after) =>
      store
        .captureInventory("capture", after)
        .pipe(Effect.mapError(() => new LibraryArchiveError({ reason: "storage" }))),
    authorize: (grant, capture, member) =>
      store
        .authorizeExport(grant, capture, member)
        .pipe(Effect.mapError(() => new LibraryArchiveError({ reason: "storage" }))),
    read: () => Effect.succeed(part),
  });

  const restart = Effect.gen(function* () {
    const freshStore = yield* LibraryRecoveryStore.pipe(Effect.provide(storeLayer));

    const journal = yield* LibraryRetainedArchiveJournal.pipe(
      Effect.provide(LibraryRetainedArchiveJournal.layer(database)),
    );

    const control = Layer.succeed(LibraryControl, {
      ...freshStore,
      complete: () => Effect.die("Unexpected global completion"),
      completePublication,
    });

    const archive = yield* LibraryRetainedArchive.pipe(
      Effect.provide(
        LibraryRetainedArchive.layer.pipe(
          Layer.provide([
            Layer.succeed(LibraryRetainedArchiveJournal, journal),
            Layer.succeed(LibraryArchiveObjects, objects),
            Layer.succeed(LibraryArchiveCaptureSource, captureSource),
            Layer.succeed(LibraryArchiveKey, { value: Redacted.make("b".repeat(64)) }),
          ]),
        ),
      ),
      Effect.provideService(LibraryArchivePolicy, { callMs: 50, uploadMs: 1000 }),
    );

    const coordinator = yield* LibraryRecoveryCoordinator.pipe(
      Effect.provide(
        LibraryRecoveryCoordinator.layer.pipe(
          Layer.provide([
            control,
            LibraryModel.layer(Layer.empty).pipe(
              Layer.provide(InMemory.make({ manual: true }).layer),
            ),
            Layer.succeed(LibraryObjectAdministration, {
              derive: () => Effect.die("Unexpected destination creation"),
              call: (_, input) =>
                Effect.gen(function* () {
                  adminCalls.push(input._tag);
                  yield* Deferred.succeed(reachedAdmin, undefined);

                  return yield* Effect.never;
                }),
            }),
          ]),
        ),
      ),
    );

    const operations = yield* LibraryArchiveOperations.pipe(
      Effect.provide(
        LibraryArchiveOperations.layer.pipe(
          Layer.provide([
            control,
            Layer.succeed(LibraryRecoveryCoordinator, coordinator),
            Layer.succeed(LibraryRetainedArchive, archive),
            Layer.succeed(LibraryRetainedArchiveJournal, journal),
          ]),
        ),
      ),
    );

    return { operations, coordinator, store: freshStore, archive, journal };
  });

  const runtime = yield* restart;

  const committed = yield* runtime.archive.upload({
    archiveId: "archive",
    grantId: "export",
    captureId: "capture",
    codeDigest: CODE,
  });

  if (committed.commit === null || committed.expiresAt === null)
    return yield* Effect.die("Archive seed did not commit");

  return {
    runtime,
    restart,
    source,
    ordinal,
    image,
    completePublication,
    adminCalls,
    objectReads,
    reachedManifest,
    releasedManifest,
    reachedAdmin,
    manifestDigest: committed.commit.receipt.plainSha256,
    expiresAt: committed.expiresAt,
    failPreflight: (value: "open" | "failure" | "timeout") =>
      Effect.sync(() => {
        mode = value;
      }),
    global: () => database.query("SELECT epoch,operation_id,mode FROM recovery_control"),
  };
});

it.effect("a known expired archive refuses before changing any recovery authority or pin", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    expect(f.expiresAt).toBe(90 * 86400000);
    yield* TestClock.setTime(f.expiresAt);

    const before = yield* f.runtime.store.status;
    const global = f.global();
    const pins = yield* f.runtime.journal.pins("archive", "");
    const archive = yield* f.runtime.journal.status("archive");
    const reads = f.objectReads.length;

    expect(before).toMatchObject({ phase: "ready", epoch: 1, operationId: null });
    expect(global).toEqual([{ epoch: 7, operation_id: null, mode: "ready" }]);
    expect(yield* f.runtime.store.restoreIntent("restore")).toBeNull();
    expect(yield* f.runtime.journal.restorePin("restore")).toBeNull();
    expect(yield* Effect.flip(f.runtime.operations.restore(request))).toEqual(
      new LibraryArchiveError({ reason: "expired" }),
    );
    expect(yield* f.runtime.store.status).toEqual(before);
    expect(f.global()).toEqual(global);
    expect(yield* f.runtime.store.restoreIntent("restore")).toBeNull();
    expect(yield* f.runtime.journal.restorePin("restore")).toBeNull();
    expect(yield* f.runtime.journal.pins("archive", "")).toEqual(pins);
    expect(yield* f.runtime.journal.status("archive")).toEqual(archive);
    expect(f.adminCalls).toEqual([]);
    expect(f.objectReads.length).toBe(reads);
  }),
);

it.effect(
  "completed retained publication replays at expiry without reopening a later capture",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const { store, journal } = f.runtime;
      yield* store.beginRestore("restore", {
        setId: "capture",
        codeDigest: CODE,
        source: Sources.Retained({ archiveId: "archive", manifestDigest: f.manifestDigest }),
      });
      yield* journal.pinRestore("restore", "archive", 0);
      yield* store.acknowledgeFreeze("restore", f.ordinal, "running", null);
      yield* store.acknowledgeFreeze("restore", f.ordinal, "running", "held");
      yield* store.recordImage("restore", f.ordinal, f.image);
      yield* store.seal("restore", 3, CODE);
      yield* store.prepareRestore("restore", "capture");

      const destination = yield* store.register(
        LibraryObjectRef.make({
          ...f.source,
          lineage: "library-2",
          physicalName: "r:library-2:owner",
          nativeId: "2".repeat(64),
        }),
        "restore",
      );

      yield* store.recordLoaded("restore", f.ordinal, destination, f.image);
      yield* store.beginActivation("restore");
      yield* store.acknowledgeActive("restore", destination);

      const published = yield* store.publish("restore", 3);
      yield* f.completePublication("restore");
      yield* journal.finishRestore("restore");
      yield* store.beginCapture("later", CODE);
      yield* TestClock.setTime(f.expiresAt);
      yield* f.failPreflight("failure");

      const before = yield* store.status;
      const global = f.global();
      const intent = yield* store.restoreIntent("restore");
      const pins = yield* journal.pins("archive", "");
      const reads = f.objectReads.length;

      expect(before).toMatchObject({ phase: "frozen", epoch: 2, operationId: "later" });
      expect(yield* f.runtime.operations.restore(request)).toEqual(published);
      expect(yield* store.status).toEqual(before);
      expect(f.global()).toEqual(global);
      expect(yield* store.restoreIntent("restore")).toEqual(intent);
      expect(yield* journal.pins("archive", "")).toEqual(pins);
      expect(yield* journal.restorePin("restore")).toMatchObject({ completed: true });
      expect(f.objectReads.length).toBe(reads);
      expect(f.adminCalls).toEqual([]);
    }),
);

for (const mode of ["failure", "timeout"] as const)
  it.effect(
    `retained manifest preflight ${mode} preserves source ownership across raw retry and reconstruction`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.failPreflight(mode);

        const first = yield* f.runtime.operations
          .restore(request)
          .pipe(Effect.flip, Effect.forkChild);

        yield* Deferred.await(f.reachedManifest);

        if (mode === "timeout") yield* TestClock.adjust("50 millis");

        expect(yield* Fiber.join(first)).toEqual(
          new LibraryArchiveError({ reason: mode === "timeout" ? "timeout" : "storage" }),
        );

        if (mode === "timeout") expect(yield* Deferred.isDone(f.releasedManifest)).toBe(true);

        expect(yield* f.runtime.store.restoreIntent("restore")).toEqual({
          setId: "capture",
          codeDigest: "a".repeat(64),
          source: Sources.Retained({ archiveId: "archive", manifestDigest: f.manifestDigest }),
        });
        expect(yield* f.runtime.journal.restorePin("restore")).toEqual({
          id: "restore",
          archiveId: "archive",
          kind: "restore",
          completed: false,
        });
        expect(f.adminCalls).toEqual([]);
        expect(
          yield* Effect.flip(
            f.runtime.coordinator.restore({
              operationId: "restore",
              setId: "capture",
              codeDigest: CODE,
            }),
          ),
        ).toEqual(new LibraryRecoveryError({ reason: "conflict" }));
        expect(f.adminCalls).toEqual([]);
        expect(f.global()).toEqual([{ epoch: 100, operation_id: "restore", mode: "recovering" }]);
        yield* f.failPreflight("open");
        const fresh = yield* f.restart;
        const retry = yield* fresh.operations.restore(request).pipe(Effect.forkChild);
        yield* Deferred.await(f.reachedAdmin);
        expect(f.adminCalls).toEqual(["Freeze"]);
        expect(yield* fresh.store.restoreIntent("restore")).toMatchObject({
          setId: "capture",
          source: Sources.Retained({ archiveId: "archive", manifestDigest: f.manifestDigest }),
        });
        expect(f.global()).toEqual([{ epoch: 100, operation_id: "restore", mode: "recovering" }]);
        yield* Fiber.interrupt(retry);
      }),
  );
