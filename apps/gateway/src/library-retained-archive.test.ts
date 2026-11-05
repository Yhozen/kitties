import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { LibraryRecoveryStore, type LibraryControlDatabase } from "./library-recovery-store.ts";
import { GlobalRecoveryAuthority } from "./library-recovery-authority.ts";
import { LibraryImagePart } from "./library-object-admin.ts";
import {
  encodeLibraryValue,
  libraryImageDigest,
  LIBRARY_IMAGE_PART_CHARS,
} from "./library-image.ts";
import {
  LibraryObjectRef,
  LibraryObjectImage,
  LibraryRecoverySet,
  RegisteredLibraryObject,
  LibraryRestoreIntent,
  type LibraryRestoreSource,
} from "./library-recovery-records.ts";
import { LibraryArchivePruneRequest } from "./library-capture-prune-records.ts";
import {
  LibraryArchiveCaptureSource,
  LibraryArchiveKey,
  LibraryArchiveObjects,
  LibraryRetainedArchive,
  type LibraryArchiveReadRequest,
  LIBRARY_ARCHIVE_OBJECT_BYTES,
  LIBRARY_ARCHIVE_VERIFY_BATCH,
} from "./library-retained-archive.ts";
import {
  LibraryArchiveError,
  LibraryArchivePruneCursor,
  LIBRARY_ARCHIVE_RETENTION_MS,
  LibraryRetainedArchiveJournal,
} from "./library-retained-archive-store.ts";
import { open, seal } from "./secrets.ts";

const CODE = "a".repeat(64);
const KEK = "b".repeat(64);

const REQUEST = {
  archiveId: "retained",
  grantId: "export-grant",
  captureId: "capture",
  codeDigest: CODE,
};

const PRUNE_KEYS = {
  manifest: "exports/library-v1/retained/manifest.json",
  page: "exports/library-v1/retained/metadata/0.json",
  part: "exports/library-v1/retained/parts/1/1/0.json",
};

const PRUNE_SEQUENCES = { manifest: 0, page: 1, part: 2 };

const ref = (ordinal: number): LibraryObjectRef => ({
  modelName: "LibraryModel",
  layout: 0,
  className: "LibraryModel.LibraryAggregate",
  lineage: "library-1",
  logicalName: `owner-${ordinal}`,
  physicalName: `r:library-1:owner-${ordinal}`,
  nativeId: String(ordinal).padStart(64, "0"),
});

const registered = (ordinal: number): RegisteredLibraryObject => ({
  ...ref(ordinal),
  ordinal,
  phase: "active",
});

const fail = () => new LibraryArchiveError({ reason: "storage" });

const fixture = Effect.fnUntraced(function* (
  objectCount = 1,
  storage?: Layer.Layer<LibraryArchiveObjects>,
) {
  const database = yield* Effect.acquireRelease(
    Effect.sync(() => new DatabaseSync(":memory:")),
    (db) => Effect.sync(() => db.close()),
  );

  let failNextCommit = false;

  const port: LibraryControlDatabase = {
    query: (sql, ...args) =>
      Schema.decodeUnknownSync(Schema.Array(Schema.JsonObject))(database.prepare(sql).all(...args)),
    transaction: (body) => {
      database.exec("BEGIN IMMEDIATE");

      try {
        const value = body();

        if (failNextCommit) {
          failNextCommit = false;
          throw Error("Injected durable commit failure");
        }

        database.exec("COMMIT");

        return value;
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
  };

  port.query(
    "CREATE TABLE library_journal (kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id))",
  );

  const chunks = new Map<string, LibraryImagePart>();
  let chain = yield* libraryImageDigest("kitties-library-image-v1");

  for (const [index, row] of [
    {
      kind: "kv",
      key: "events",
      body: encodeLibraryValue("private retained instructions".repeat(450)),
    },
    { kind: "alarm", key: "alarm", body: encodeLibraryValue(null) },
  ].entries()) {
    const rowDigest = yield* libraryImageDigest(row.body);
    const parts = Math.ceil(row.body.length / LIBRARY_IMAGE_PART_CHARS);

    for (let part = 0; part < parts; part++)
      chunks.set(
        `${index + 1}/${part}`,
        Schema.decodeUnknownSync(LibraryImagePart)({
          row: index + 1,
          kind: row.kind,
          key: row.key,
          digest: rowDigest,
          part,
          parts,
          chars: row.body.length,
          chunk: row.body.slice(
            part * LIBRARY_IMAGE_PART_CHARS,
            (part + 1) * LIBRARY_IMAGE_PART_CHARS,
          ),
        }),
      );
    chain = yield* libraryImageDigest(`${chain}\n${row.kind}\n${row.key}\n${rowDigest}`);
  }

  const image = LibraryObjectImage.make({ digest: chain, kvCount: 1, sqlCount: 0 });

  const set = {
    ...LibraryRecoverySet.make({
      id: "capture",
      sourceLineage: "library-1",
      inventoryId: "inventory",
      allocatorFloor: 9,
      objectCount,
      codeDigest: CODE,
    }),
    capturedAt: 0,
  };

  const retained = new Map<string, { body: string; uploadedAt: number }>();
  const raceChanged: Array<boolean> = [];
  const gets: Array<string> = [];
  const calls = { read: 0, authorize: 0, puts: 0, gets, getBounds: new Set<number>(), raceChanged };
  let failAfterPut = false;
  let substituteClass = false;
  let localAvailable = true;
  let race = false;
  let blocked = false;

  const source = LibraryArchiveCaptureSource.of({
    recoverySet: () => (localAvailable ? Effect.succeed(set) : Effect.fail(fail())),
    inventory: (_, after) =>
      Effect.succeed(
        Array.from({ length: objectCount }, (_, index) => registered(index + 1))
          .filter((member) => member.ordinal > after)
          .slice(0, 64),
      ),
    authorize: (grantId, captureId, ordinal) =>
      Effect.gen(function* () {
        calls.authorize++;

        if (grantId !== "export-grant" || captureId !== "capture") return yield* fail();

        return {
          captureId,
          ordinal,
          source: {
            ...ref(ordinal),
            className: substituteClass
              ? "LibraryModel.SkillDetailViewV1"
              : "LibraryModel.LibraryAggregate",
          },
          image,
        };
      }),
    read: ({ row, part }) =>
      Effect.gen(function* () {
        calls.read++;
        const value = chunks.get(`${row}/${part}`);

        if (!localAvailable || value === undefined) return yield* fail();

        return value;
      }),
  });

  const objects = LibraryArchiveObjects.of({
    get: (key, maxBytes) =>
      Effect.suspend(() => {
        calls.gets.push(key);

        if (blocked) return Effect.never;
        calls.getBounds.add(maxBytes);

        return Effect.succeed(retained.get(key) ?? null);
      }),
    putIfAbsent: (key, body) =>
      Effect.gen(function* () {
        calls.puts++;

        if (!retained.has(key)) {
          let winner = body;

          if (race) {
            const envelope = Schema.decodeUnknownSync(
              Schema.fromJsonString(
                Schema.Struct({ kid: Schema.String, iv: Schema.String, ct: Schema.String }),
              ),
            )(body);

            const plaintext = yield* Effect.promise(() =>
              open(KEK, `kitties-library-archive-v1:${key}`, envelope),
            );

            const changed = yield* Effect.promise(() =>
              seal(KEK, `kitties-library-archive-v1:${key}`, plaintext),
            );

            winner = JSON.stringify(changed);
            calls.raceChanged.push(winner !== body);
          }

          retained.set(key, { body: winner, uploadedAt: yield* Clock.currentTimeMillis });
        }

        if (failAfterPut) {
          failAfterPut = false;

          return yield* fail();
        }
      }),
  });

  const restart = Effect.gen(function* () {
    const journalContext = yield* Layer.build(LibraryRetainedArchiveJournal.layer(port));
    const journal = Context.get(journalContext, LibraryRetainedArchiveJournal);

    const context = yield* Layer.build(
      LibraryRetainedArchive.layer.pipe(
        Layer.provide([
          Layer.succeed(LibraryRetainedArchiveJournal, journal),
          Layer.succeed(LibraryArchiveCaptureSource, source),
          storage ?? Layer.succeed(LibraryArchiveObjects, objects),
          Layer.succeed(LibraryArchiveKey, { value: Redacted.make(KEK) }),
        ]),
      ),
    );

    return { archive: Context.get(context, LibraryRetainedArchive), journal };
  });

  const preparePrune = Effect.gen(function* () {
    port.query(
      "CREATE TABLE recovery_control (id INTEGER PRIMARY KEY,epoch INTEGER,operation_id TEXT,mode TEXT)",
    );
    port.query("INSERT INTO recovery_control VALUES (1,7,NULL,'ready')");
    port.query("CREATE TABLE recovery_runs (workflow TEXT,id TEXT,epoch INTEGER,review INTEGER)");
    port.query("INSERT INTO recovery_runs VALUES ('Existing','one',7,0)");

    const authority = yield* GlobalRecoveryAuthority.pipe(
      Effect.provide(GlobalRecoveryAuthority.layer(port, () => 100)),
    );

    const control = yield* LibraryRecoveryStore.pipe(
      Effect.provide(LibraryRecoveryStore.layer(port, authority)),
    );

    yield* control.initialize("inventory");

    for (let ordinal = 1; ordinal <= objectCount; ordinal++) yield* control.register(ref(ordinal));
    yield* control.finishImport("inventory", 9);
    yield* control.beginCapture("capture", CODE);

    for (let ordinal = 1; ordinal <= objectCount; ordinal++) {
      yield* control.acknowledgeFreeze("capture", ordinal, "running", null);
      yield* control.acknowledgeFreeze("capture", ordinal, "running", "held");
      yield* control.recordImage("capture", ordinal, image);
    }

    yield* control.seal("capture", 9, CODE);
    yield* control.beginCaptureResume("capture");

    for (let ordinal = 1; ordinal <= objectCount; ordinal++) {
      yield* control.acknowledgeResumed("capture", ordinal, "resume", null);
      yield* control.acknowledgeResumed("capture", ordinal, "resume", "fresh");
    }

    yield* control.completeCapture("capture");
    yield* control.grantExport("export-grant", "capture");

    return { control, authority };
  });

  return {
    ...(yield* restart),
    blockReads: Effect.sync(() => {
      blocked = true;
    }),
    publish: (id: string, setId: string, completed = true) =>
      Effect.sync(() => {
        port.query(
          "INSERT OR REPLACE INTO library_journal VALUES ('operation',?,?)",
          id,
          JSON.stringify({ setId, kind: "restore" }),
        );
        port.query(
          "INSERT OR REPLACE INTO library_journal VALUES ('published',?,?)",
          id,
          JSON.stringify({
            libraryId: "owner",
            epoch: 2,
            lineage: "library-2",
            nextLineage: 3,
            phase: "ready",
            inventoryId: "inventory",
            operationId: null,
            operationKind: "restore",
            stagingLineage: null,
            allocatorFloor: 9,
          }),
        );

        if (completed)
          port.query(
            "INSERT OR REPLACE INTO library_journal VALUES ('publication-complete',?,?)",
            id,
            JSON.stringify({ libraryEpoch: 2 }),
          );
      }),
    restart,
    preparePrune,
    port,
    image,
    set,
    chunks,
    retained,
    calls,
    lostPutAck: Effect.sync(() => {
      failAfterPut = true;
    }),
    loseLocalCapture: Effect.sync(() => {
      localAvailable = false;
      chunks.clear();
    }),
    wrongClass: Effect.sync(() => {
      substituteClass = true;
    }),
    conditionalRace: Effect.sync(() => {
      race = true;
    }),
    failCommit: Effect.sync(() => {
      failNextCommit = true;
    }),
  };
});

const readRequest = (image: LibraryObjectImage, part = 0): LibraryArchiveReadRequest => ({
  operationId: "restore",
  captureId: "capture",
  source: registered(1),
  image,
  row: 1,
  part,
});

const pruneFixture = Effect.fnUntraced(function* (objectCount = 1) {
  const f = yield* fixture(objectCount);
  const controls = yield* f.preparePrune;
  const status = yield* f.archive.upload(REQUEST);

  if (status.commit === null) return yield* new LibraryArchiveError({ reason: "incomplete" });

  const request = LibraryArchivePruneRequest.make({
    pruneId: "prune",
    archiveId: "retained",
    captureId: "capture",
    codeDigest: CODE,
    manifestDigest: status.commit.receipt.plainSha256,
  });

  yield* TestClock.adjust("30 days");

  return { ...f, ...controls, request, committed: status };
});

it.effect("retained upload encrypts bounded parts and commits verified paged metadata last", () =>
  Effect.gen(function* () {
    const f = yield* fixture(10);
    const result = yield* f.archive.upload(REQUEST);
    expect(result).toMatchObject({
      phase: "committed",
      objectCount: 10,
      completeObjects: 10,
      partCount: 30,
      pageCount: 2,
      oldestUploadedAt: 0,
      uploadVerifiedAt: 0,
      expiresAt: LIBRARY_ARCHIVE_RETENTION_MS,
    });
    expect([...f.retained.keys()].at(-1)).toBe("exports/library-v1/retained/manifest.json");
    expect(
      [...f.retained.values()].every(
        (entry) => !entry.body.includes("private retained instructions"),
      ),
    ).toBe(true);
    expect(f.calls.getBounds).toEqual(new Set([LIBRARY_ARCHIVE_OBJECT_BYTES]));
    expect(yield* f.journal.pins("retained", "")).toEqual([
      { id: "retained", archiveId: "retained", kind: "upload", completed: true },
    ]);
    const puts = f.calls.puts;
    expect(yield* f.archive.upload(REQUEST)).toEqual(result);
    expect(f.calls.puts).toBe(puts);
  }),
);

it.effect(
  "same ID resumes a real stored part after lost upload ACK without rewriting ciphertext or capturedAt",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.lostPutAck;
      expect(yield* Effect.flip(f.archive.upload(REQUEST))).toEqual(fail());
      const original = f.retained.get("exports/library-v1/retained/parts/1/1/0.json");
      expect(original).toBeDefined();
      expect(yield* f.archive.status("retained")).toMatchObject({
        phase: "uploading",
        partCount: 0,
        header: { capturedAt: 0 },
      });
      expect(yield* f.journal.pins("retained", "")).toEqual([
        { id: "retained", archiveId: "retained", kind: "upload", completed: false },
      ]);
      yield* TestClock.adjust("1 day");
      const fresh = yield* f.restart;
      const result = yield* fresh.archive.upload(REQUEST);
      expect(result).toMatchObject({
        phase: "committed",
        oldestUploadedAt: 0,
        uploadVerifiedAt: 86400000,
        expiresAt: LIBRARY_ARCHIVE_RETENTION_MS,
        header: { capturedAt: 0 },
      });
      expect(f.retained.get("exports/library-v1/retained/parts/1/1/0.json")).toEqual(original);
      expect(yield* Effect.flip(fresh.archive.begin({ ...REQUEST, captureId: "other" }))).toEqual(
        new LibraryArchiveError({ reason: "conflict" }),
      );
    }),
);

it.effect(
  "conditional write race authenticates the randomized winning ciphertext and records its exact hash",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.conditionalRace;
      expect((yield* f.archive.upload(REQUEST)).phase).toBe("committed");
      expect(f.calls.raceChanged.length).toBeGreaterThan(0);
      expect(f.calls.raceChanged.every(Boolean)).toBe(true);
      const stored = f.retained.get("exports/library-v1/retained/parts/1/1/0.json");
      expect(stored).toBeDefined();
      const receipt = yield* f.journal.part("retained", 1, 1, 0);
      expect(receipt?.cipherSha256).toBe(yield* libraryImageDigest(stored!.body));
    }),
);

it.effect(
  "retained source survives loss of every local capture row and fences operation/source/code substitution",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const original = f.chunks.get("1/0");
      yield* f.archive.upload(REQUEST);
      yield* f.loseLocalCapture;
      const fresh = yield* f.restart;
      const reads = f.calls.read;

      const source = yield* fresh.archive.retainedSource({
        archiveId: "retained",
        restoreId: "restore",
        codeDigest: CODE,
      });

      expect(yield* source.read(readRequest(f.image))).toEqual(original);
      expect(f.calls.read).toBe(reads);
      expect(yield* fresh.journal.restorePin("restore")).toEqual({
        id: "restore",
        archiveId: "retained",
        kind: "restore",
        completed: false,
      });
      expect(
        yield* Effect.flip(source.read({ ...readRequest(f.image), operationId: "other" })),
      ).toEqual(new LibraryArchiveError({ reason: "conflict" }));
      expect(
        yield* Effect.flip(
          source.read({
            ...readRequest(f.image),
            source: { ...registered(1), className: "LibraryModel.SkillDetailViewV1" },
          }),
        ),
      ).toEqual(new LibraryArchiveError({ reason: "conflict" }));
      expect(
        yield* Effect.flip(
          source.read({ ...readRequest(f.image), image: { ...f.image, digest: "c".repeat(64) } }),
        ),
      ).toEqual(new LibraryArchiveError({ reason: "conflict" }));
      expect(
        yield* Effect.flip(
          fresh.archive.retainedSource({
            archiveId: "retained",
            restoreId: "other",
            codeDigest: "c".repeat(64),
          }),
        ),
      ).toEqual(new LibraryArchiveError({ reason: "conflict" }));
      yield* f.publish("restore", "capture");
      yield* fresh.archive.finishRestore("restore");
      expect(yield* fresh.archive.finishRestore("restore")).toMatchObject({ completed: true });
      expect(yield* Effect.flip(source.read(readRequest(f.image)))).toEqual(
        new LibraryArchiveError({ reason: "conflict" }),
      );
    }),
);

it.effect(
  "a committed manifest or part with modified bytes fails closed without calling native capture",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.archive.upload(REQUEST);

      const source = yield* f.archive.retainedSource({
        archiveId: "retained",
        restoreId: "restore",
        codeDigest: CODE,
      });

      const key = "exports/library-v1/retained/parts/1/1/0.json";
      const original = f.retained.get(key)!;
      f.retained.set(key, { ...original, body: original.body.replace(/.$/, " ") });
      const reads = f.calls.read;
      expect((yield* Effect.flip(source.read(readRequest(f.image)))).reason).toBe("invalid");
      expect(f.calls.read).toBe(reads);
      f.retained.set(key, original);
      const manifest = "exports/library-v1/retained/manifest.json";
      f.retained.set(manifest, { body: "{}", uploadedAt: 0 });
      expect(
        (yield* Effect.flip(
          f.archive.retainedSource({
            archiveId: "retained",
            restoreId: "second",
            codeDigest: CODE,
          }),
        )).reason,
      ).toBe("invalid");
      expect(yield* f.journal.restorePin("second")).toMatchObject({ completed: false });
    }),
);

it.effect("oldest uploaded part limits expiry and pins never extend the ninety-day lifecycle", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.lostPutAck;
    yield* Effect.flip(f.archive.upload(REQUEST));
    yield* TestClock.adjust("89 days");
    const result = yield* f.archive.upload(REQUEST);
    expect(result.expiresAt).toBe(LIBRARY_ARCHIVE_RETENTION_MS);

    const source = yield* f.archive.retainedSource({
      archiveId: "retained",
      restoreId: "restore",
      codeDigest: CODE,
    });

    expect((yield* source.read(readRequest(f.image))).row).toBe(1);
    yield* TestClock.adjust("1 day");
    expect(yield* Effect.flip(source.read(readRequest(f.image)))).toEqual(
      new LibraryArchiveError({ reason: "expired" }),
    );
    expect(
      yield* Effect.flip(
        f.archive.retainedSource({ archiveId: "retained", restoreId: "later", codeDigest: CODE }),
      ),
    ).toEqual(new LibraryArchiveError({ reason: "expired" }));
    expect(yield* f.journal.restorePin("restore")).toMatchObject({ completed: false });
  }),
);

it.effect(
  "already expired upload never publishes a completed manifest or releases its upload pin",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.lostPutAck;
      yield* Effect.flip(f.archive.upload(REQUEST));
      yield* TestClock.adjust("90 days");
      expect(yield* Effect.flip(f.archive.upload(REQUEST))).toEqual(
        new LibraryArchiveError({ reason: "expired" }),
      );
      expect(f.retained.has("exports/library-v1/retained/manifest.json")).toBe(false);
      expect(yield* f.journal.pins("retained", "")).toEqual([
        { id: "retained", archiveId: "retained", kind: "upload", completed: false },
      ]);
    }),
);

it.effect(
  "capture grant/source mismatch is refused before any R2 write or object membership receipt",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.wrongClass;
      expect(yield* Effect.flip(f.archive.upload(REQUEST))).toEqual(
        new LibraryArchiveError({ reason: "conflict" }),
      );
      expect(f.calls.authorize).toBe(1);
      expect(f.calls.puts).toBe(0);
      expect(yield* f.journal.objects("retained", 0)).toEqual([]);
    }),
);

it.effect(
  "journal ACK transaction rollback leaves no partial part receipt and fresh service can resume",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.archive.begin(REQUEST);
      yield* f.journal.recordObject("retained", { ordinal: 1, source: ref(1), image: f.image });
      yield* f.failCommit;
      expect(
        yield* Effect.flip(
          f.journal.recordPart("retained", 1, {
            row: 1,
            part: 0,
            parts: 2,
            plainSha256: CODE,
            cipherSha256: CODE,
            bytes: 100,
            uploadedAt: 0,
            verifiedAt: 0,
          }),
        ),
      ).toEqual(fail());
      expect(yield* f.journal.part("retained", 1, 1, 0)).toBeNull();
      const fresh = yield* f.restart;
      expect((yield* fresh.archive.upload(REQUEST)).phase).toBe("committed");
      expect(yield* fresh.journal.part("retained", 1, 1, 0)).not.toBeNull();
    }),
);

it.effect(
  "ciphertext copied to another archive key fails its AAD even before a receipt exists",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.archive.upload(REQUEST);
      const original = f.retained.get("exports/library-v1/retained/parts/1/1/0.json");
      expect(original).toBeDefined();
      f.retained.set("exports/library-v1/substitute/parts/1/1/0.json", original!);
      expect(yield* Effect.flip(f.archive.upload({ ...REQUEST, archiveId: "substitute" }))).toEqual(
        new LibraryArchiveError({ reason: "conflict" }),
      );
      expect(f.retained.has("exports/library-v1/substitute/manifest.json")).toBe(false);
      expect(yield* f.archive.status("substitute")).toMatchObject({
        phase: "uploading",
        partCount: 0,
      });
    }),
);

it.effect("a chunk whose full row hash is wrong cannot commit object metadata or manifest", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const first = f.chunks.get("1/0");
    expect(first).toBeDefined();
    f.chunks.set("1/0", { ...first!, chunk: `X${first!.chunk.slice(1)}` });
    expect(yield* Effect.flip(f.archive.upload(REQUEST))).toEqual(
      new LibraryArchiveError({ reason: "conflict" }),
    );
    expect(yield* f.archive.status("retained")).toMatchObject({
      phase: "uploading",
      completeObjects: 0,
      pageCount: 0,
    });
    expect(f.retained.has("exports/library-v1/retained/manifest.json")).toBe(false);
  }),
);

it.effect(
  "incomplete part sequences and absent metadata pages cannot publish a journal manifest",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const status = yield* f.archive.begin(REQUEST);
      yield* f.journal.recordObject("retained", { ordinal: 1, source: ref(1), image: f.image });

      const receipt = {
        plainSha256: CODE,
        cipherSha256: CODE,
        bytes: 100,
        uploadedAt: 0,
        verifiedAt: 0,
      };

      expect(
        yield* Effect.flip(
          f.journal.recordPart("retained", 1, { ...receipt, row: 1, part: 1, parts: 2 }),
        ),
      ).toEqual(new LibraryArchiveError({ reason: "conflict" }));
      yield* f.journal.recordPart("retained", 1, { ...receipt, row: 1, part: 0, parts: 2 });
      expect(yield* Effect.flip(f.journal.completeObject("retained", 1))).toEqual(
        new LibraryArchiveError({ reason: "incomplete" }),
      );
      expect(
        yield* Effect.flip(
          f.journal.commit(
            "retained",
            {
              manifest: {
                format: "kitties-library-archive-v1",
                header: status.header,
                objectCount: 1,
                partCount: 1,
                pageCount: 0,
                lastPageSha256: "0".repeat(64),
                oldestUploadedAt: 0,
                expiresAt: LIBRARY_ARCHIVE_RETENTION_MS,
              },
              receipt,
            },
            0,
          ),
        ),
      ).toEqual(new LibraryArchiveError({ reason: "incomplete" }));
      expect(yield* f.journal.status("retained")).toMatchObject({
        phase: "uploading",
        commit: null,
      });
    }),
);

it.effect(
  "immutable identity retries conflict and source responses exceeding the byte bound fail explicitly",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const initial = yield* f.archive.begin(REQUEST);
      expect(yield* Effect.flip(f.journal.begin({ ...initial.header, capturedAt: 1 }))).toEqual(
        new LibraryArchiveError({ reason: "conflict" }),
      );
      yield* f.archive.upload(REQUEST);

      const source = yield* f.archive.retainedSource({
        archiveId: "retained",
        restoreId: "restore",
        codeDigest: CODE,
      });

      f.retained.set("exports/library-v1/retained/parts/1/1/0.json", {
        body: " ".repeat(LIBRARY_ARCHIVE_OBJECT_BYTES + 1),
        uploadedAt: 0,
      });
      expect(yield* Effect.flip(source.read(readRequest(f.image)))).toEqual(
        new LibraryArchiveError({ reason: "limit" }),
      );
    }),
);

it.effect(
  "restore pin release requires exact durable restore publication and matching completion marker",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.archive.upload(REQUEST);
      yield* f.archive.retainedSource({
        archiveId: "retained",
        restoreId: "restore",
        codeDigest: CODE,
      });
      expect(yield* Effect.flip(f.archive.finishRestore("restore"))).toEqual(
        new LibraryArchiveError({ reason: "incomplete" }),
      );
      yield* f.publish("restore", "capture", false);
      expect(yield* Effect.flip(f.archive.finishRestore("restore"))).toEqual(
        new LibraryArchiveError({ reason: "incomplete" }),
      );
      yield* f.publish("restore", "different-capture");
      expect(yield* Effect.flip(f.archive.finishRestore("restore"))).toEqual(
        new LibraryArchiveError({ reason: "conflict" }),
      );
      yield* f.publish("restore", "capture");
      f.port.query(
        "UPDATE library_journal SET body=? WHERE kind='publication-complete' AND id='restore'",
        JSON.stringify({ libraryEpoch: 99 }),
      );
      expect(yield* Effect.flip(f.archive.finishRestore("restore"))).toEqual(
        new LibraryArchiveError({ reason: "conflict" }),
      );
      yield* f.publish("restore", "capture");
      f.port.query(
        "UPDATE library_journal SET body=? WHERE kind='operation' AND id='restore'",
        JSON.stringify({ setId: "capture", kind: "capture" }),
      );
      expect(yield* Effect.flip(f.archive.finishRestore("restore"))).toEqual(
        new LibraryArchiveError({ reason: "storage" }),
      );
      expect(yield* f.journal.restorePin("restore")).toMatchObject({ completed: false });
      yield* f.publish("restore", "capture");
      expect(yield* f.archive.finishRestore("restore")).toMatchObject({ completed: true });
      expect(yield* f.archive.finishRestore("restore")).toMatchObject({ completed: true });
    }),
);

it.effect("a retained manifest read timeout retains its durable restore pin", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.archive.upload(REQUEST);
    yield* f.blockReads;

    const pending = yield* Effect.forkChild(
      Effect.flip(
        f.archive.retainedSource({ archiveId: "retained", restoreId: "restore", codeDigest: CODE }),
      ),
    );

    yield* TestClock.adjust("10 seconds");
    expect(yield* Fiber.join(pending)).toEqual(new LibraryArchiveError({ reason: "timeout" }));
    expect(yield* f.journal.restorePin("restore")).toMatchObject({ completed: false });
  }),
);

it.effect(
  "empty immutable inventory still uploads an authenticated empty metadata page before manifest",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(0);
      const result = yield* f.archive.upload(REQUEST);
      expect(result).toMatchObject({
        phase: "committed",
        objectCount: 0,
        partCount: 0,
        pageCount: 1,
        oldestUploadedAt: 0,
        expiresAt: LIBRARY_ARCHIVE_RETENTION_MS,
      });
      expect([...f.retained.keys()]).toEqual([
        "exports/library-v1/retained/metadata/0.json",
        "exports/library-v1/retained/manifest.json",
      ]);
    }),
);

it.effect(
  "R2 body timeout cancels the actual pending Web Stream reader and never ACKs an upload",
  () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      let acknowledgeCancellation: (() => void) | undefined;

      const cancellationAcknowledgement = new Promise<void>((resolve) => {
        acknowledgeCancellation = resolve;
      });

      let cancellations = 0;
      let writes = 0;

      const stream = new ReadableStream<Uint8Array>(
        {
          pull: () => {
            Deferred.doneUnsafe(reading, Effect.void);
          },
          cancel: () => {
            cancellations++;

            return cancellationAcknowledgement;
          },
        },
        { highWaterMark: 0 },
      );

      const adapter = LibraryArchiveObjects.layerR2({
        get: async () => ({
          size: 1,
          uploaded: new Date(0),
          body: {
            getReader: () => {
              const reader = stream.getReader();

              return {
                read: () => reader.read(),
                cancel: () => reader.cancel(),
                releaseLock: () => {
                  reader.releaseLock();
                  Deferred.doneUnsafe(released, Effect.void);
                },
              };
            },
          },
        }),
        put: async () => {
          writes++;

          return null;
        },
      });

      const f = yield* fixture(1, adapter);
      const pending = yield* Effect.forkChild(Effect.flip(f.archive.upload(REQUEST)));
      yield* Deferred.await(reading);
      expect(stream.locked).toBe(true);
      expect(cancellations).toBe(0);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(pending)).toEqual(new LibraryArchiveError({ reason: "timeout" }));
      expect(cancellations).toBe(1);
      yield* Deferred.await(released);
      expect(stream.locked).toBe(false);
      expect(writes).toBe(0);
      expect(yield* f.archive.status("retained")).toMatchObject({
        phase: "uploading",
        partCount: 0,
        commit: null,
      });
      expect(yield* f.journal.part("retained", 1, 1, 0)).toBeNull();
      expect(yield* f.journal.pins("retained", "")).toEqual([
        { id: "retained", archiveId: "retained", kind: "upload", completed: false },
      ]);

      if (acknowledgeCancellation === undefined) throw Error("Missing cancellation control");
      acknowledgeCancellation();
    }),
);

it.effect(
  "prune verification authenticates every encrypted receipt in bounded restartable steps",
  () =>
    Effect.gen(function* () {
      const f = yield* pruneFixture(10);
      const library = yield* f.control.status;
      const global = f.port.query("SELECT * FROM recovery_control");
      const permissions = f.port.query("SELECT * FROM recovery_runs");
      const local = [...f.chunks.entries()];
      const sourceReads = f.calls.read;
      const writes = f.calls.puts;
      let state = yield* f.journal.reservePrune(f.request, yield* Clock.currentTimeMillis);
      expect(state).toMatchObject({
        phase: "verifying",
        sequence: 0,
        cursor: Data.taggedEnum<typeof LibraryArchivePruneCursor.Type>().Manifest(),
      });
      const observed: Array<number> = [];
      const readKeys: Array<string> = [];

      for (let step = 0; step < 5; step++) {
        const fresh = yield* f.restart;
        const before = f.calls.gets.length;
        state = yield* fresh.archive.verifyPrune(f.request);
        const reads = f.calls.gets.slice(before);
        expect(reads.length).toBeLessThanOrEqual(LIBRARY_ARCHIVE_VERIFY_BATCH);
        readKeys.push(...reads);
        observed.push(state.sequence);
      }

      expect(observed).toEqual([8, 16, 24, 32, 33]);
      expect(state).toMatchObject({
        phase: "verified",
        sequence: 33,
        cursor: Data.taggedEnum<typeof LibraryArchivePruneCursor.Type>().Done(),
        reservedAt: 30 * 86400000,
        verifiedAt: 30 * 86400000,
        expiresAt: 90 * 86400000,
      });
      expect(readKeys.length).toBe(33);
      expect(new Set(readKeys)).toEqual(new Set(f.retained.keys()));
      expect(f.calls.read).toBe(sourceReads);
      expect(f.calls.puts).toBe(writes);
      expect([...f.chunks.entries()]).toEqual(local);
      expect(yield* f.control.status).toEqual(library);
      expect(f.port.query("SELECT * FROM recovery_control")).toEqual(global);
      expect(f.port.query("SELECT * FROM recovery_runs")).toEqual(permissions);
      expect((yield* Effect.flip(f.archive.finishPrune("prune"))).reason).toBe("incomplete");
      expect((yield* f.archive.pruneStatus("prune"))?.phase).toBe("verified");
    }),
);

for (const kind of ["manifest", "page", "part"] as const) {
  it.effect(
    `a missing encrypted ${kind} leaves failed-item progress held and resumes the same intent`,
    () =>
      Effect.gen(function* () {
        const f = yield* pruneFixture();
        const key = PRUNE_KEYS[kind];
        const original = f.retained.get(key)!;
        const local = [...f.chunks.entries()];
        f.retained.delete(key);
        expect((yield* Effect.flip(f.archive.verifyPrune(f.request))).reason).toBe("incomplete");
        const held = yield* f.archive.pruneStatus("prune");
        expect(held).toMatchObject({
          phase: "verifying",
          sequence: PRUNE_SEQUENCES[kind],
        });
        expect([...f.chunks.entries()]).toEqual(local);
        expect(
          (yield* Effect.flip(
            f.journal.pinRestore("restore", "retained", yield* Clock.currentTimeMillis),
          )).reason,
        ).toBe("conflict");
        expect((yield* Effect.flip(f.control.beginCapture("new-capture", CODE))).reason).toBe(
          "fenced",
        );
        expect(
          (yield* Effect.flip(
            f.control.beginRestore(
              "native",
              LibraryRestoreIntent.make({
                setId: "capture",
                codeDigest: CODE,
                source: Data.taggedEnum<LibraryRestoreSource>().Native(),
              }),
            ),
          )).reason,
        ).toBe("fenced");
        expect(yield* f.archive.pruneStatus("prune")).toEqual(held);
        const fresh = yield* f.restart;
        expect(
          (yield* Effect.flip(
            fresh.archive.verifyPrune({ ...f.request, manifestDigest: "c".repeat(64) }),
          )).reason,
        ).toBe("conflict");
        f.retained.set(key, original);
        expect((yield* fresh.archive.verifyPrune(f.request)).phase).toBe("verified");
      }),
  );
}

for (const kind of ["manifest", "page", "part"] as const) {
  it.effect(
    `corrupt encrypted ${kind} cannot produce a verification grant or release source protection`,
    () =>
      Effect.gen(function* () {
        const f = yield* pruneFixture();
        const key = PRUNE_KEYS[kind];
        const original = f.retained.get(key)!;
        f.retained.set(key, { ...original, body: "{}" });
        expect((yield* Effect.flip(f.archive.verifyPrune(f.request))).reason).toBe("invalid");
        expect(yield* f.archive.pruneStatus("prune")).toMatchObject({
          phase: "verifying",
          sequence: PRUNE_SEQUENCES[kind],
        });
        expect(f.chunks.size).toBe(3);
        expect((yield* Effect.flip(f.archive.finishPrune("prune"))).reason).toBe("incomplete");
        f.retained.set(key, original);
        expect((yield* f.archive.verifyPrune(f.request)).phase).toBe("verified");
      }),
  );
}

for (const kind of ["upload", "restore"] as const) {
  it.effect(
    `prune reservation excludes active ${kind} alias pins and then fences new alias acquisitions`,
    () =>
      Effect.gen(function* () {
        const f = yield* pruneFixture();

        if (kind === "restore") {
          yield* f.archive.upload({ ...REQUEST, archiveId: "alias" });
          yield* f.journal.pinRestore("restore-alias", "alias", yield* Clock.currentTimeMillis);
        } else yield* f.archive.begin({ ...REQUEST, archiveId: "alias" });
        expect((yield* Effect.flip(f.archive.verifyPrune(f.request))).reason).toBe("conflict");
        expect(yield* f.archive.pruneStatus("prune")).toBeNull();
        expect(f.port.query("SELECT id FROM library_capture_prunes")).toEqual([]);

        if (kind === "restore") {
          yield* f.publish("restore-alias", "capture");
          yield* f.archive.finishRestore("restore-alias");
        } else yield* f.archive.upload({ ...REQUEST, archiveId: "alias" });
        expect((yield* f.archive.verifyPrune(f.request)).phase).toBe("verified");
        expect(
          (yield* Effect.flip(f.journal.pinRestore("new", "alias", yield* Clock.currentTimeMillis)))
            .reason,
        ).toBe("conflict");
        expect(
          (yield* Effect.flip(f.archive.begin({ ...REQUEST, archiveId: "new-alias" }))).reason,
        ).toBe("conflict");
        expect(
          (yield* Effect.flip(
            f.archive.verifyPrune({ ...f.request, pruneId: "other", archiveId: "alias" }),
          )).reason,
        ).toBe("conflict");
        expect((yield* f.archive.pruneStatus("prune"))?.phase).toBe("verified");
      }),
  );
}

it.effect("reservation commit failure rolls back both barriers before any encrypted read", () =>
  Effect.gen(function* () {
    const f = yield* pruneFixture();
    const before = f.calls.gets.length;
    yield* f.failCommit;
    expect((yield* Effect.flip(f.archive.verifyPrune(f.request))).reason).toBe("storage");
    expect(f.port.query("SELECT id FROM library_capture_prunes")).toEqual([]);
    expect(yield* f.archive.pruneStatus("prune")).toBeNull();
    expect(f.calls.gets.length).toBe(before);
    expect((yield* f.archive.verifyPrune(f.request)).phase).toBe("verified");
  }),
);

it.effect("verification timeout holds its reservation without acknowledging the stalled item", () =>
  Effect.gen(function* () {
    const f = yield* pruneFixture();
    yield* f.blockReads;
    const pending = yield* f.archive.verifyPrune(f.request).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("10 seconds");
    expect(yield* Fiber.join(pending)).toEqual(new LibraryArchiveError({ reason: "timeout" }));
    expect(yield* f.archive.pruneStatus("prune")).toMatchObject({
      phase: "verifying",
      sequence: 0,
      cursor: Data.taggedEnum<typeof LibraryArchivePruneCursor.Type>().Manifest(),
    });
    expect(f.chunks.size).toBe(3);
    expect(
      (yield* Effect.flip(
        f.journal.pinRestore("blocked", "retained", yield* Clock.currentTimeMillis),
      )).reason,
    ).toBe("conflict");
  }),
);

it.effect("lost verification ACK retries retain exact progress and original expiry", () =>
  Effect.gen(function* () {
    const f = yield* pruneFixture();
    yield* f.journal.reservePrune(f.request, yield* Clock.currentTimeMillis);
    const work = yield* f.journal.pruneNext("prune", yield* Clock.currentTimeMillis);

    if (work === null) return yield* fail();
    yield* f.failCommit;
    expect(
      (yield* Effect.flip(
        f.journal.acknowledgePrune(
          "prune",
          work.sequence,
          { ...work.receipt, verifiedAt: yield* Clock.currentTimeMillis },
          yield* Clock.currentTimeMillis,
        ),
      )).reason,
    ).toBe("storage");
    expect(yield* f.archive.pruneStatus("prune")).toMatchObject({
      sequence: 0,
      phase: "verifying",
    });
    yield* TestClock.adjust("1 day");
    const receipt = { ...work.receipt, verifiedAt: yield* Clock.currentTimeMillis };

    const once = yield* f.journal.acknowledgePrune(
      "prune",
      work.sequence,
      receipt,
      yield* Clock.currentTimeMillis,
    );

    expect(
      yield* f.journal.acknowledgePrune(
        "prune",
        work.sequence,
        receipt,
        yield* Clock.currentTimeMillis,
      ),
    ).toEqual(once);
    expect((yield* f.archive.verifyPrune(f.request)).phase).toBe("verified");
    expect((yield* f.archive.pruneStatus("prune"))?.expiresAt).toBe(90 * 86400000);
    yield* TestClock.adjust("59 days");
    expect((yield* Effect.flip(f.archive.verifyPrune(f.request))).reason).toBe("expired");
    expect((yield* f.archive.pruneStatus("prune"))?.phase).toBe("verified");
    expect((yield* Effect.flip(f.archive.finishPrune("prune"))).reason).toBe("incomplete");
  }),
);

it.effect(
  "prune completion requires the exact permanent delete proof and permits retained restore afterwards",
  () =>
    Effect.gen(function* () {
      const f = yield* pruneFixture();
      expect((yield* f.archive.verifyPrune(f.request)).phase).toBe("verified");

      const plan = {
        request: f.request,
        phase: "complete",
        reservedAt: 30 * 86400000,
        expiresAt: 90 * 86400000,
        capturedAt: 0,
        objectCount: 1,
      };

      f.port.query(
        "UPDATE library_capture_prunes SET phase='complete',body=? WHERE id='prune'",
        JSON.stringify(plan),
      );
      expect((yield* Effect.flip(f.archive.finishPrune("prune"))).reason).toBe("incomplete");
      expect(
        (yield* Effect.flip(
          f.journal.pinRestore("early", "retained", yield* Clock.currentTimeMillis),
        )).reason,
      ).toBe("conflict");

      const completion = {
        request: { ...f.request, captureId: "wrong" },
        objectCount: 1,
        completedAt: 30 * 86400000,
      };

      f.port.query(
        "INSERT INTO library_journal VALUES ('capture-prune-complete','prune',?)",
        JSON.stringify(completion),
      );
      expect((yield* Effect.flip(f.archive.finishPrune("prune"))).reason).toBe("conflict");
      expect(
        (yield* Effect.flip(
          f.journal.pinRestore("wrong-proof", "retained", yield* Clock.currentTimeMillis),
        )).reason,
      ).toBe("conflict");
      f.port.query(
        "UPDATE library_journal SET body=? WHERE kind='capture-prune-complete' AND id='prune'",
        JSON.stringify({ ...completion, request: f.request }),
      );
      expect((yield* f.archive.finishPrune("prune")).phase).toBe("complete");
      expect((yield* f.archive.finishPrune("prune")).phase).toBe("complete");

      const source = yield* f.archive.retainedSource({
        archiveId: "retained",
        restoreId: "after-prune",
        codeDigest: CODE,
      });

      expect(yield* source.read({ ...readRequest(f.image), operationId: "after-prune" })).toEqual(
        f.chunks.get("1/0"),
      );
      yield* TestClock.adjust("90 days");
      expect((yield* f.archive.finishPrune("prune")).phase).toBe("complete");
    }),
);

for (const initialPhase of ["verifying", "verified"] as const) {
  it.effect(
    `expired ${initialPhase} reservation releases only after exact permanent abandonment proof`,
    () =>
      Effect.gen(function* () {
        const f = yield* pruneFixture(initialPhase === "verifying" ? 10 : 1);
        // A separate alias remains within its original provider retention window.
        yield* f.archive.upload({ ...REQUEST, archiveId: "alias" });
        const before = yield* f.archive.verifyPrune(f.request);
        expect(before.phase).toBe(initialPhase);
        yield* TestClock.adjust("60 days");
        expect((yield* Effect.flip(f.archive.finishAbandon("prune"))).reason).toBe("incomplete");

        const plan = {
          request: f.request,
          phase: "stopping",
          reservedAt: 30 * 86400000,
          expiresAt: 90 * 86400000,
          capturedAt: 0,
          objectCount: initialPhase === "verifying" ? 10 : 1,
          stoppingAt: 90 * 86400000,
        };

        f.port.query(
          "UPDATE library_capture_prunes SET phase='stopping',body=? WHERE id='prune'",
          JSON.stringify(plan),
        );
        expect((yield* Effect.flip(f.archive.finishAbandon("prune"))).reason).toBe("incomplete");
        expect(
          (yield* Effect.flip(f.journal.pruneNext("prune", yield* Clock.currentTimeMillis))).reason,
        ).toBe("conflict");
        f.port.query(
          "UPDATE library_capture_prunes SET phase='abandoned',body=? WHERE id='prune'",
          JSON.stringify({ ...plan, phase: "abandoned" }),
        );
        expect((yield* Effect.flip(f.archive.finishAbandon("prune"))).reason).toBe("incomplete");
        expect(
          (yield* Effect.flip(
            f.journal.pinRestore("too-early", "alias", yield* Clock.currentTimeMillis),
          )).reason,
        ).toBe("conflict");
        f.port.query(
          "INSERT INTO library_journal VALUES ('capture-prune-abandoned','prune',?)",
          JSON.stringify({
            request: f.request,
            objectCount: plan.objectCount,
            abandonedAt: 90 * 86400000,
          }),
        );

        const result = yield* f.archive.finishAbandon("prune");
        expect(result).toEqual({ ...before, phase: "abandoned" });
        expect(yield* f.archive.finishAbandon("prune")).toEqual(result);
        const gets = f.calls.gets.length;
        expect(yield* f.archive.verifyPrune(f.request)).toEqual(result);
        expect(f.calls.gets.length).toBe(gets);
        expect((yield* Effect.flip(f.archive.finishPrune("prune"))).reason).toBe("incomplete");
        expect(
          (yield* Effect.flip(
            f.archive.retainedSource({
              archiveId: "retained",
              restoreId: "expired",
              codeDigest: CODE,
            }),
          )).reason,
        ).toBe("expired");

        const alias = yield* f.archive.retainedSource({
          archiveId: "alias",
          restoreId: "valid-alias",
          codeDigest: CODE,
        });

        expect(yield* alias.read({ ...readRequest(f.image), operationId: "valid-alias" })).toEqual(
          f.chunks.get("1/0"),
        );
        expect(f.chunks.size).toBe(3);
        expect((yield* f.archive.status("retained"))?.expiresAt).toBe(90 * 86400000);
      }),
  );
}

it.effect(
  "abandonment refuses mismatched, early and undrained permanent facts without releasing pins",
  () =>
    Effect.gen(function* () {
      const f = yield* pruneFixture();
      yield* f.archive.upload({ ...REQUEST, archiveId: "alias" });
      const before = yield* f.archive.verifyPrune(f.request);
      yield* TestClock.adjust("60 days");

      const plan = {
        request: f.request,
        phase: "abandoned",
        reservedAt: 30 * 86400000,
        expiresAt: 90 * 86400000,
        capturedAt: 0,
        objectCount: 1,
        stoppingAt: 90 * 86400000,
      };

      const proof = { request: f.request, objectCount: 1, abandonedAt: 90 * 86400000 };

      const cases = [
        { plan, proof: { ...proof, request: { ...f.request, captureId: "wrong" } } },
        { plan: { ...plan, request: { ...f.request, manifestDigest: "c".repeat(64) } }, proof },
        { plan: { ...plan, phase: "stopping" }, proof },
        { plan: { ...plan, stoppingAt: undefined }, proof },
        { plan: { ...plan, stoppingAt: 90 * 86400000 - 1 }, proof },
        { plan, proof: { ...proof, abandonedAt: 90 * 86400000 - 1 } },
        { plan, proof: { ...proof, objectCount: 2 } },
        { plan: { ...plan, expiresAt: 91 * 86400000 }, proof },
        { plan: { ...plan, reservedAt: 31 * 86400000 }, proof },
      ];

      for (const sample of cases) {
        f.port.query(
          "UPDATE library_capture_prunes SET phase=?,body=? WHERE id='prune'",
          sample.plan.phase,
          JSON.stringify(sample.plan),
        );
        f.port.query(
          "INSERT OR REPLACE INTO library_journal VALUES ('capture-prune-abandoned','prune',?)",
          JSON.stringify(sample.proof),
        );
        expect(yield* f.archive.finishAbandon("prune").pipe(Effect.isFailure)).toBe(true);
        expect(yield* f.archive.pruneStatus("prune")).toEqual(before);
        expect(
          (yield* Effect.flip(
            f.journal.pinRestore("blocked", "alias", yield* Clock.currentTimeMillis),
          )).reason,
        ).toBe("conflict");
        expect(
          (yield* Effect.flip(f.archive.begin({ ...REQUEST, archiveId: "new-alias" }))).reason,
        ).toBe("conflict");
      }
    }),
);

it.effect("terminal pin release rejects complete/abandoned cross-pairs", () =>
  Effect.gen(function* () {
    const f = yield* pruneFixture();
    yield* f.archive.upload({ ...REQUEST, archiveId: "alias" });
    const before = yield* f.archive.verifyPrune(f.request);
    yield* TestClock.adjust("60 days");

    const plan = {
      request: f.request,
      reservedAt: 30 * 86400000,
      expiresAt: 90 * 86400000,
      capturedAt: 0,
      objectCount: 1,
      stoppingAt: 90 * 86400000,
    };

    for (const pair of [
      { plan: "complete", verification: "abandoned" },
      { plan: "abandoned", verification: "complete" },
    ]) {
      f.port.query(
        "UPDATE library_capture_prunes SET phase=?,body=? WHERE id='prune'",
        pair.plan,
        JSON.stringify({ ...plan, phase: pair.plan }),
      );
      f.port.query(
        "UPDATE library_retained_prunes SET body=? WHERE id='prune'",
        JSON.stringify({ ...before, phase: pair.verification }),
      );
      expect(
        (yield* Effect.flip(
          f.journal.pinRestore("crossed", "alias", yield* Clock.currentTimeMillis),
        )).reason,
      ).toBe("conflict");
      expect(
        (yield* Effect.flip(f.archive.begin({ ...REQUEST, archiveId: "new-alias" }))).reason,
      ).toBe("conflict");
    }

    expect((yield* Effect.flip(f.archive.finishAbandon("prune"))).reason).toBe("conflict");
  }),
);
