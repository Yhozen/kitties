import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type { LibraryControlDatabase } from "./library-recovery-store.ts";
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
} from "./library-recovery-records.ts";
import {
  LibraryArchiveCaptureSource,
  LibraryArchiveKey,
  LibraryArchiveObjects,
  LibraryRetainedArchive,
  type LibraryArchiveReadRequest,
  LIBRARY_ARCHIVE_OBJECT_BYTES,
} from "./library-retained-archive.ts";
import {
  LibraryArchiveError,
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
  const calls = { read: 0, authorize: 0, puts: 0, getBounds: new Set<number>(), raceChanged };
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
