import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Clock from "effect/Clock";
import {
  GlobalRecoveryAuthority,
  reserveLibraryCapturePrune,
} from "./library-recovery-authority.ts";
import {
  LIBRARY_CAPTURE_PRUNE_MIN_AGE_MS,
  LibraryArchivePruneRequest,
  type LibraryCapturePruneCandidate,
  LibraryCapturePruneCandidatesPage,
  LibraryCapturePruneVerification,
} from "./library-capture-prune-records.ts";
import {
  LibraryObjectImage,
  LibraryObjectRef,
  LibraryRecoveryError,
  LibraryRecoverySet,
  LibraryRestoreIntent,
  type LibraryRestoreSource,
} from "./library-recovery-records.ts";
import { LibraryRecoveryStore, type LibraryControlDatabase } from "./library-recovery-store.ts";

const CODE = "a".repeat(64);
const IMAGE = LibraryObjectImage.make({ digest: "b".repeat(64), kvCount: 12, sqlCount: 3 });
const RestoreSources = Data.taggedEnum<LibraryRestoreSource>();
const Candidates = Data.taggedEnum<LibraryCapturePruneCandidate>();

const retainedIntent = LibraryRestoreIntent.make({
  setId: "restore",
  codeDigest: CODE,
  source: RestoreSources.Retained({ archiveId: "archive", manifestDigest: "c".repeat(64) }),
});

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
    port,
    store: yield* restart,
    restart,
    failCommit: Effect.sync(() => {
      failNextCommit = true;
    }),
  };
});

// These tests supply the retained journal's trusted verified record. Encrypted
// provider verification is exercised separately by the retained archive tests.
const pruneFixture = Effect.fnUntraced(function* (members = 2) {
  const base = yield* databaseFixture;
  const { port } = base;
  port.query(
    "CREATE TABLE recovery_control (id INTEGER PRIMARY KEY,epoch INTEGER,operation_id TEXT,mode TEXT)",
  );
  port.query("INSERT INTO recovery_control VALUES (1,7,NULL,'ready')");
  port.query("CREATE TABLE recovery_runs (id TEXT,epoch INTEGER,review INTEGER)");
  port.query("INSERT INTO recovery_runs VALUES ('live',7,0)");
  port.query("CREATE TABLE library_retained_archives (id TEXT PRIMARY KEY,body TEXT)");
  port.query("CREATE TABLE library_retained_commits (archive_id TEXT PRIMARY KEY,body TEXT)");
  port.query(
    "CREATE TABLE library_retained_pins (kind TEXT,id TEXT,archive_id TEXT,body TEXT,PRIMARY KEY(kind,id))",
  );
  port.query(
    "CREATE TABLE library_retained_prunes (id TEXT PRIMARY KEY,archive_id TEXT,capture_id TEXT,body TEXT)",
  );

  const authority = yield* GlobalRecoveryAuthority.pipe(
    Effect.provide(GlobalRecoveryAuthority.layer(port, () => 100)),
  );

  const restart = LibraryRecoveryStore.pipe(
    Effect.provide(LibraryRecoveryStore.layer(port, authority)),
  );

  const store = yield* restart;
  yield* ready(store);

  for (let ordinal = 2; ordinal <= members; ordinal++)
    yield* store.register(objectRef("library-1", ordinal, `member-${ordinal}`));
  yield* store.beginCapture("backup", CODE);

  for (let ordinal = 1; ordinal <= members; ordinal++) {
    yield* store.acknowledgeFreeze("backup", ordinal, "running", null);
    yield* store.acknowledgeFreeze("backup", ordinal, "running", "held");
    yield* store.recordImage("backup", ordinal, IMAGE);
  }

  const set = yield* store.seal("backup", 8, CODE);
  yield* store.beginCaptureResume("backup");

  for (let ordinal = 1; ordinal <= members; ordinal++) {
    yield* store.acknowledgeResumed("backup", ordinal, "release", null);
    yield* store.acknowledgeResumed("backup", ordinal, "release", "fresh");
  }

  yield* store.completeCapture("backup");
  const expiresAt = 90 * 86400000;
  const header = { archiveId: "archive", grantId: "upload", set, capturedAt: 0 };
  port.query(
    "INSERT INTO library_retained_archives VALUES (?,?)",
    "archive",
    JSON.stringify(header),
  );
  port.query(
    "INSERT INTO library_retained_commits VALUES (?,?)",
    "archive",
    JSON.stringify({ manifest: { header, expiresAt }, receipt: { plainSha256: "c".repeat(64) } }),
  );

  const request = LibraryArchivePruneRequest.make({
    pruneId: "prune",
    archiveId: "archive",
    captureId: "backup",
    codeDigest: CODE,
    manifestDigest: "c".repeat(64),
  });

  const attempt = <A>(body: () => A) =>
    Effect.try({
      try: () => port.transaction(body),
      catch: (cause) =>
        Schema.is(LibraryRecoveryError)(cause)
          ? cause
          : new LibraryRecoveryError({ reason: "storage" }),
    });

  const reserve = Effect.fnUntraced(function* (input = request, expiry = expiresAt) {
    const now = yield* Clock.currentTimeMillis;

    return yield* attempt(() => {
      const plan = reserveLibraryCapturePrune(port, input, expiry, now);

      if (
        port.query("SELECT id FROM library_retained_prunes WHERE id=?", input.pruneId)[0] ===
        undefined
      ) {
        const proof = LibraryCapturePruneVerification.make({
          request: input,
          phase: "verifying",
          reservedAt: plan.reservedAt,
          expiresAt: expiry,
          verifiedAt: null,
        });

        port.query(
          "INSERT INTO library_retained_prunes VALUES (?,?,?,?)",
          input.pruneId,
          input.archiveId,
          input.captureId,
          JSON.stringify(proof),
        );
      }

      return plan;
    });
  });

  const markVerified = Effect.fnUntraced(function* () {
    const now = yield* Clock.currentTimeMillis;
    const plan = yield* store.capturePrune("prune");

    if (plan === null) return yield* Effect.die("Missing fixture reservation");

    const proof = LibraryCapturePruneVerification.make({
      request,
      phase: "verified",
      reservedAt: plan.reservedAt,
      expiresAt,
      verifiedAt: now,
    });

    port.query(
      "INSERT OR REPLACE INTO library_retained_prunes VALUES (?,?,?,?)",
      "prune",
      "archive",
      "backup",
      JSON.stringify(proof),
    );
  });

  return {
    ...base,
    store,
    restart,
    request,
    reserve,
    markVerified,
    expiresAt,
    set,
    header,
    beginGlobal: (id: string) => attempt(() => authority.beginGlobal(id)),
  };
});

// Discovery reads durable metadata only; these rows do not claim encrypted I/O verification.
const candidateFixture = Effect.gen(function* () {
  const f = yield* pruneFixture(1);
  const completed = yield* f.store.status;

  if (completed === null) return yield* Effect.die("Missing fixture control");

  const archive = (id: string, set = f.set, expiresAt = f.expiresAt) => {
    const header = { ...f.header, archiveId: id, set };
    f.port.query(
      "INSERT OR REPLACE INTO library_retained_archives VALUES (?,?)",
      id,
      JSON.stringify(header),
    );
    f.port.query(
      "INSERT OR REPLACE INTO library_retained_commits VALUES (?,?)",
      id,
      JSON.stringify({ manifest: { header, expiresAt } }),
    );
  };

  const capture = (id: string) => {
    const set = LibraryRecoverySet.make({ ...f.set, id });
    f.port.query("INSERT INTO library_journal VALUES ('set',?,?)", id, JSON.stringify(set));
    f.port.query(
      "INSERT INTO library_journal VALUES ('operation',?,?)",
      id,
      JSON.stringify({ kind: "capture", setId: null, codeDigest: CODE }),
    );
    f.port.query(
      "INSERT INTO library_journal VALUES ('capture-complete',?,?)",
      id,
      JSON.stringify(completed),
    );
    archive(`archive-${id}`, set);
  };

  return { ...f, archive, capture };
});

it.effect(
  "candidate discovery advances over sixty-four ineligible keys without changing authority",
  () =>
    Effect.gen(function* () {
      const f = yield* candidateFixture;
      yield* TestClock.adjust("30 days");

      for (let index = 0; index < 64; index++) {
        const id = `a${String(index).padStart(3, "0")}`;
        f.port.query(
          "INSERT INTO library_journal VALUES ('set',?,?)",
          id,
          JSON.stringify({ ...f.set, id }),
        );
      }

      const changes = f.port.query("SELECT total_changes() AS value");
      const library = yield* f.store.status;
      const global = f.port.query("SELECT * FROM recovery_control");
      const permits = f.port.query("SELECT * FROM recovery_runs");
      expect(yield* f.store.capturePruneCandidates({ after: null })).toEqual({
        items: [],
        next: "a063",
      });
      const fresh = yield* f.restart;
      expect(yield* fresh.capturePruneCandidates({ after: "a063" })).toEqual({
        items: [Candidates.New({ captureId: "backup", archiveId: "archive" })],
        next: null,
      });
      expect(f.port.query("SELECT total_changes() AS value")).toEqual(changes);
      expect(yield* fresh.status).toEqual(library);
      expect(f.port.query("SELECT * FROM recovery_control")).toEqual(global);
      expect(f.port.query("SELECT * FROM recovery_runs")).toEqual(permits);
      expect(f.port.query("SELECT * FROM library_capture_prunes")).toEqual([]);
    }),
);

it.effect("candidate discovery pages sixty-four eligible keys and a final empty page", () =>
  Effect.gen(function* () {
    const f = yield* candidateFixture;

    for (let index = 0; index < 63; index++) f.capture(`capture-${String(index).padStart(3, "0")}`);
    yield* TestClock.adjust("30 days");
    const page = yield* f.store.capturePruneCandidates({ after: null });
    expect(page.items).toHaveLength(64);
    expect(page.items[0]).toEqual(Candidates.New({ captureId: "backup", archiveId: "archive" }));
    expect(page.items[63]).toEqual(
      Candidates.New({ captureId: "capture-062", archiveId: "archive-capture-062" }),
    );
    expect(page.next).toBe("capture-062");
    const fresh = yield* f.restart;
    expect(yield* fresh.capturePruneCandidates({ after: "capture-062" })).toEqual({
      items: [],
      next: null,
    });
    expect(
      Schema.is(LibraryCapturePruneCandidatesPage)({
        ...page,
        items: [...page.items, page.items[0]],
      }),
    ).toBe(false);
  }),
);

it.effect("candidate discovery uses the server age boundary and refuses caller policy knobs", () =>
  Effect.gen(function* () {
    const f = yield* candidateFixture;
    yield* TestClock.adjust(30 * 86400000 - 1);
    expect(yield* f.store.capturePruneCandidates({ after: null })).toEqual({
      items: [],
      next: null,
    });
    yield* TestClock.adjust(1);
    expect(yield* f.store.capturePruneCandidates({ after: null })).toEqual({
      items: [Candidates.New({ captureId: "backup", archiveId: "archive" })],
      next: null,
    });

    const callerPolicy = { after: null, now: 0, age: 0, limit: 1000 };
    expect(yield* Effect.flip(f.store.capturePruneCandidates(callerPolicy))).toEqual(
      new LibraryRecoveryError({ reason: "invalid" }),
    );
    expect(yield* Effect.flip(f.store.capturePruneCandidates({ after: "../backup" }))).toEqual(
      new LibraryRecoveryError({ reason: "invalid" }),
    );
  }),
);

it.effect(
  "candidate discovery selects the first exact committed unexpired archive rather than fresh header time",
  () =>
    Effect.gen(function* () {
      const f = yield* candidateFixture;
      yield* TestClock.adjust("30 days");
      f.archive("a-expired", f.set, 30 * 86400000);
      f.port.query(
        "UPDATE library_retained_archives SET body=json_set(body,'$.capturedAt',?) WHERE id='a-expired'",
        30 * 86400000,
      );
      f.port.query(
        "INSERT INTO library_retained_archives VALUES ('a-uncommitted',?)",
        JSON.stringify({ ...f.header, archiveId: "a-uncommitted" }),
      );
      f.archive("z-valid");
      f.archive("b-valid");
      expect(yield* f.store.capturePruneCandidates({ after: null })).toEqual({
        items: [Candidates.New({ captureId: "backup", archiveId: "archive" })],
        next: null,
      });

      // Exact typed metadata equality must not depend on JSON object field order.
      const reordered = {
        capturedAt: 0,
        codeDigest: CODE,
        objectCount: 1,
        allocatorFloor: 8,
        inventoryId: "legacy-inventory",
        sourceLineage: "library-1",
        id: "backup",
      };

      f.port.query(
        "UPDATE library_retained_commits SET body=json_set(body,'$.manifest.header.set',json(?)) WHERE archive_id='b-valid'",
        JSON.stringify(reordered),
      );
      f.port.query("DELETE FROM library_retained_commits WHERE archive_id='archive'");
      const fresh = yield* f.restart;
      expect(yield* fresh.capturePruneCandidates({ after: null })).toEqual({
        items: [Candidates.New({ captureId: "backup", archiveId: "b-valid" })],
        next: null,
      });
      yield* TestClock.adjust("60 days");
      expect(yield* fresh.capturePruneCandidates({ after: null })).toEqual({
        items: [],
        next: null,
      });
    }),
);

it.effect(
  "candidate discovery rejects every changed set field in either archive metadata copy",
  () =>
    Effect.gen(function* () {
      const f = yield* candidateFixture;
      yield* TestClock.adjust("30 days");

      const mismatches = [
        { field: "id", value: "other-capture" },
        { field: "sourceLineage", value: "library-2" },
        { field: "inventoryId", value: "other-inventory" },
        { field: "allocatorFloor", value: 9 },
        { field: "objectCount", value: 2 },
        { field: "codeDigest", value: "d".repeat(64) },
        { field: "capturedAt", value: 1 },
      ];

      for (const mismatch of mismatches) {
        f.archive("archive");
        f.port.query(
          "UPDATE library_retained_archives SET body=json_set(body,?,?) WHERE id='archive'",
          `$.set.${mismatch.field}`,
          mismatch.value,
        );
        expect(yield* f.store.capturePruneCandidates({ after: null })).toEqual({
          items: [],
          next: null,
        });
        f.archive("archive");
        f.port.query(
          "UPDATE library_retained_commits SET body=json_set(body,?,?) WHERE archive_id='archive'",
          `$.manifest.header.set.${mismatch.field}`,
          mismatch.value,
        );
        expect(yield* f.store.capturePruneCandidates({ after: null })).toEqual({
          items: [],
          next: null,
        });
      }

      f.archive("archive");
      f.port.query("DELETE FROM library_journal WHERE kind='capture-complete' AND id='backup'");
      expect(yield* f.store.capturePruneCandidates({ after: null })).toEqual({
        items: [],
        next: null,
      });
      f.port.query(
        "INSERT INTO library_journal VALUES ('capture-complete','backup',?)",
        JSON.stringify(yield* f.store.status),
      );
      f.port.query(
        "UPDATE library_journal SET body=json_remove(body,'$.capturedAt') WHERE kind='set' AND id='backup'",
      );
      expect(yield* f.store.capturePruneCandidates({ after: null })).toEqual({
        items: [],
        next: null,
      });
    }),
);

it.effect(
  "candidate discovery excludes incomplete pins on every alias but permits completed and unrelated pins",
  () =>
    Effect.gen(function* () {
      const f = yield* candidateFixture;
      yield* TestClock.adjust("30 days");
      f.archive("alias");

      for (const kind of ["upload", "restore"]) {
        for (const completed of [false, null]) {
          f.port.query(
            "INSERT OR REPLACE INTO library_retained_pins VALUES (?,?,'alias',?)",
            kind,
            kind,
            JSON.stringify({ id: kind, archiveId: "alias", kind, completed }),
          );
          expect(yield* f.store.capturePruneCandidates({ after: null })).toEqual({
            items: [],
            next: null,
          });
        }

        f.port.query(
          "UPDATE library_retained_pins SET body=json_remove(body,'$.completed') WHERE id=?",
          kind,
        );
        expect(yield* f.store.capturePruneCandidates({ after: null })).toEqual({
          items: [],
          next: null,
        });
        f.port.query(
          "UPDATE library_retained_pins SET body=json_set(body,'$.completed',json('true')) WHERE id=?",
          kind,
        );
      }

      f.archive("unrelated", { ...f.set, id: "other-capture" });
      f.port.query(
        "INSERT INTO library_retained_pins VALUES ('upload','other','unrelated',?)",
        JSON.stringify({ id: "other", archiveId: "unrelated", kind: "upload", completed: false }),
      );
      expect(yield* f.store.capturePruneCandidates({ after: null })).toEqual({
        items: [Candidates.New({ captureId: "backup", archiveId: "alias" })],
        next: null,
      });
    }),
);

it.effect(
  "candidate discovery retains original pending IDs across expiry stopping and reconstruction",
  () =>
    Effect.gen(function* () {
      const f = yield* candidateFixture;
      yield* TestClock.adjust("30 days");
      yield* f.reserve();
      f.archive("a-new-alias");

      const resume = {
        items: [
          Candidates.Resume({ operationId: "prune", captureId: "backup", archiveId: "archive" }),
        ],
        next: null,
      };

      expect(yield* f.store.capturePruneCandidates({ after: null })).toEqual(resume);
      yield* f.markVerified();
      yield* f.store.beginCapturePrune("prune");
      const fresh = yield* f.restart;
      expect(yield* fresh.capturePruneCandidates({ after: null })).toEqual(resume);
      yield* TestClock.adjust("60 days");

      const blocked = {
        items: [
          Candidates.BlockedExpired({
            operationId: "prune",
            captureId: "backup",
            archiveId: "archive",
          }),
        ],
        next: null,
      };

      expect(yield* fresh.capturePruneCandidates({ after: null })).toEqual(blocked);
      yield* fresh.beginAbandonCapturePrune("prune");
      const stopping = yield* f.restart;
      yield* TestClock.setTime(30 * 86400000);
      expect(yield* stopping.capturePruneCandidates({ after: null })).toEqual(blocked);
      yield* TestClock.setTime(90 * 86400000);
      const authorization = yield* stopping.authorizeCapturePruneStop("prune", 1);
      yield* stopping.acknowledgeCapturePruneStopped("prune", { authorization });
      yield* stopping.completeAbandonCapturePrune("prune");
      const abandoned = yield* f.restart;
      yield* TestClock.setTime(30 * 86400000);
      expect(yield* abandoned.capturePruneCandidates({ after: null })).toEqual({
        items: [],
        next: null,
      });
    }),
);

it.effect(
  "candidate discovery never selects a completed prune again even with another archive",
  () =>
    Effect.gen(function* () {
      const f = yield* candidateFixture;
      yield* TestClock.adjust("30 days");
      yield* f.reserve();
      yield* f.markVerified();
      yield* f.store.beginCapturePrune("prune");
      const authorization = yield* f.store.authorizeCapturePrune("prune", 1);
      yield* f.store.acknowledgeCapturePrune("prune", { authorization, removedRows: 0 });
      yield* f.store.completeCapturePrune("prune");
      f.archive("a-new-alias");
      const fresh = yield* f.restart;
      expect(yield* fresh.capturePruneCandidates({ after: null })).toEqual({
        items: [],
        next: null,
      });
    }),
);

it.effect(
  "prune reservation enforces the exact30day boundary and rolls back its source fence",
  () =>
    Effect.gen(function* () {
      const f = yield* pruneFixture();
      const library = yield* f.store.status;
      const global = f.port.query("SELECT * FROM recovery_control");
      const permits = f.port.query("SELECT * FROM recovery_runs");
      yield* TestClock.adjust(LIBRARY_CAPTURE_PRUNE_MIN_AGE_MS - 1);
      expect(yield* Effect.flip(f.reserve())).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(yield* f.store.capturePrune("prune")).toBeNull();
      yield* TestClock.adjust(1);
      yield* f.failCommit;
      expect(yield* Effect.flip(f.reserve())).toEqual(
        new LibraryRecoveryError({ reason: "storage" }),
      );
      expect(yield* f.store.capturePrune("prune")).toBeNull();
      const plan = yield* f.reserve();
      expect(plan).toEqual({
        request: f.request,
        phase: "reserved",
        reservedAt: 30 * 86400000,
        capturedAt: 0,
        expiresAt: 90 * 86400000,
        objectCount: 2,
      });
      expect(yield* f.reserve()).toEqual(plan);
      expect(yield* f.store.status).toEqual(library);
      expect(f.port.query("SELECT * FROM recovery_control")).toEqual(global);
      expect(f.port.query("SELECT * FROM recovery_runs")).toEqual(permits);
      expect(yield* f.store.admit(1)).toEqual({
        libraryId: "owner",
        epoch: 1,
        lineage: "library-1",
      });
    }),
);

it.effect("prune reservation excludes every archive alias pin and unbound Native intent", () =>
  Effect.gen(function* () {
    const f = yield* pruneFixture();
    yield* TestClock.adjust("30 days");
    f.port.query(
      "INSERT INTO library_retained_archives VALUES ('alias',?)",
      JSON.stringify({ ...f.header, archiveId: "alias" }),
    );

    for (const kind of ["upload", "restore"]) {
      f.port.query(
        "INSERT INTO library_retained_pins VALUES (?,?,'alias',?)",
        kind,
        kind,
        JSON.stringify({ id: kind, archiveId: "alias", kind, completed: false }),
      );
      expect(yield* Effect.flip(f.reserve())).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      f.port.query("DELETE FROM library_retained_pins WHERE id=?", kind);
    }

    f.port.query(
      "INSERT INTO library_journal VALUES ('operation','legacy',?)",
      JSON.stringify({ setId: null }),
    );
    expect(yield* Effect.flip(f.reserve())).toEqual(new LibraryRecoveryError({ reason: "fenced" }));
    f.port.query(
      "UPDATE library_journal SET body=? WHERE kind='operation' AND id='legacy'",
      JSON.stringify({
        kind: "restore",
        setId: "backup",
        intent: { setId: "backup", codeDigest: CODE, source: RestoreSources.Native() },
      }),
    );
    expect(yield* Effect.flip(f.reserve())).toEqual(new LibraryRecoveryError({ reason: "fenced" }));
    expect(yield* f.store.capturePrune("prune")).toBeNull();
    f.port.query(
      "INSERT INTO library_journal VALUES ('published','legacy',?)",
      JSON.stringify(yield* f.store.status),
    );
    expect(yield* f.reserve()).toMatchObject({ phase: "reserved" });
  }),
);

it.effect(
  "prune reservation binds original archive inputs and fences Native reads before verification",
  () =>
    Effect.gen(function* () {
      const f = yield* pruneFixture();
      yield* f.store.grantExport("upload", "backup");
      yield* TestClock.adjust("30 days");
      expect(
        yield* Effect.flip(f.reserve({ ...f.request, manifestDigest: "d".repeat(64) })),
      ).toEqual(new LibraryRecoveryError({ reason: "conflict" }));
      expect(yield* Effect.flip(f.reserve({ ...f.request, pruneId: "backup" }))).toEqual(
        new LibraryRecoveryError({ reason: "conflict" }),
      );
      yield* f.reserve();
      expect(yield* Effect.flip(f.reserve({ ...f.request, archiveId: "alias" }))).toEqual(
        new LibraryRecoveryError({ reason: "conflict" }),
      );
      expect(yield* Effect.flip(f.store.beginCapturePrune("prune"))).toEqual(
        new LibraryRecoveryError({ reason: "incomplete" }),
      );
      expect(yield* Effect.flip(f.store.authorizeExport("upload", "backup", 1))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(yield* Effect.flip(f.store.grantExport("new-export", "backup"))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(yield* Effect.flip(f.beginGlobal("destructive"))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(yield* Effect.flip(f.store.beginCapture("capture-new", CODE))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(
        yield* Effect.flip(
          f.store.beginRestore("native", {
            setId: "backup",
            codeDigest: CODE,
            source: RestoreSources.Native(),
          }),
        ),
      ).toEqual(new LibraryRecoveryError({ reason: "fenced" }));
      expect(f.port.query("SELECT epoch,operation_id,mode FROM recovery_control")).toEqual([
        { epoch: 7, operation_id: null, mode: "ready" },
      ]);
    }),
);

it.effect(
  "verified pruning resumes only pending sealed objects with immutable exact receipts",
  () =>
    Effect.gen(function* () {
      const f = yield* pruneFixture(70);
      yield* TestClock.adjust("30 days");
      yield* f.reserve();
      yield* f.markVerified();
      yield* f.store.beginCapturePrune("prune");
      yield* f.store.register(objectRef("library-1", 71, "post-capture"));
      expect(
        (yield* f.store.capturePruneInventory("prune")).map((ref) => ref.ordinal),
      ).toHaveLength(64);
      expect((yield* f.store.capturePruneInventory("prune", 64)).map((ref) => ref.ordinal)).toEqual(
        [65, 66, 67, 68, 69, 70],
      );
      expect(yield* Effect.flip(f.store.authorizeCapturePrune("prune", 71))).toEqual(
        new LibraryRecoveryError({ reason: "incomplete" }),
      );
      const first = yield* f.store.authorizeCapturePrune("prune", 1);
      const receipt = { authorization: first, removedRows: 42 };
      expect(
        yield* Effect.flip(
          f.store.acknowledgeCapturePrune("prune", {
            ...receipt,
            authorization: {
              ...first,
              source: { ...first.source, className: "LibraryModel.DomainDirectory" },
            },
          }),
        ),
      ).toEqual(new LibraryRecoveryError({ reason: "conflict" }));
      yield* f.failCommit;
      expect(yield* Effect.flip(f.store.acknowledgeCapturePrune("prune", receipt))).toEqual(
        new LibraryRecoveryError({ reason: "storage" }),
      );
      expect((yield* f.store.capturePruneInventory("prune"))[0]?.ordinal).toBe(1);
      yield* f.store.acknowledgeCapturePrune("prune", receipt);
      const fresh = yield* f.restart;
      expect((yield* fresh.capturePruneInventory("prune"))[0]?.ordinal).toBe(2);
      expect(yield* fresh.acknowledgeCapturePrune("prune", receipt)).toEqual(receipt);
      expect(
        yield* Effect.flip(fresh.acknowledgeCapturePrune("prune", { ...receipt, removedRows: 43 })),
      ).toEqual(new LibraryRecoveryError({ reason: "conflict" }));
      expect(yield* Effect.flip(fresh.completeCapturePrune("prune"))).toEqual(
        new LibraryRecoveryError({ reason: "incomplete" }),
      );

      for (let ordinal = 2; ordinal <= 70; ordinal++)
        yield* fresh.acknowledgeCapturePrune("prune", {
          authorization: yield* fresh.authorizeCapturePrune("prune", ordinal),
          removedRows: 1,
        });
      const proof = yield* fresh.completeCapturePrune("prune");
      expect(proof).toEqual({ request: f.request, objectCount: 70, completedAt: 30 * 86400000 });
      expect(yield* fresh.completeCapturePrune("prune")).toEqual(proof);
      expect(yield* fresh.capturePruneInventory("prune")).toEqual([]);
      expect(yield* fresh.image("backup", 1)).toEqual(IMAGE);
      expect(yield* fresh.recoverySet("backup")).toEqual(f.set);
      expect(yield* fresh.inventory("library-1")).toHaveLength(64);
      expect((yield* fresh.inventory("library-1", 64)).map((ref) => ref.ordinal)).toEqual([
        65, 66, 67, 68, 69, 70, 71,
      ]);
      expect(yield* Effect.flip(fresh.beginCapture("prune", CODE))).toEqual(
        new LibraryRecoveryError({ reason: "conflict" }),
      );
      expect(yield* Effect.flip(f.beginGlobal("prune"))).toEqual(
        new LibraryRecoveryError({ reason: "conflict" }),
      );
      expect(
        yield* Effect.flip(
          fresh.beginRestore("native-later", {
            setId: "backup",
            codeDigest: CODE,
            source: RestoreSources.Native(),
          }),
        ),
      ).toEqual(new LibraryRecoveryError({ reason: "fenced" }));
      expect(
        yield* fresh.beginRestore("retained", {
          setId: "backup",
          codeDigest: CODE,
          source: RestoreSources.Retained({ archiveId: "archive", manifestDigest: "c".repeat(64) }),
        }),
      ).toMatchObject({ phase: "frozen", operationId: "retained" });
    }),
);

it.effect("prune grants and unrecorded acknowledgements stop at exact archive expiry", () =>
  Effect.gen(function* () {
    const f = yield* pruneFixture();
    yield* TestClock.adjust("30 days");
    yield* f.reserve();
    yield* f.markVerified();
    yield* f.store.beginCapturePrune("prune");
    const authorization = yield* f.store.authorizeCapturePrune("prune", 1);
    yield* TestClock.adjust("60 days");
    expect(yield* Effect.flip(f.store.authorizeCapturePrune("prune", 1))).toEqual(
      new LibraryRecoveryError({ reason: "fenced" }),
    );
    expect(
      yield* Effect.flip(
        f.store.acknowledgeCapturePrune("prune", { authorization, removedRows: 1 }),
      ),
    ).toEqual(new LibraryRecoveryError({ reason: "fenced" }));
    expect(yield* Effect.flip(f.store.completeCapturePrune("prune"))).toEqual(
      new LibraryRecoveryError({ reason: "fenced" }),
    );
    expect(yield* f.store.capturePrune("prune")).toMatchObject({ phase: "deleting" });
    expect(yield* Effect.flip(f.store.beginCapture("unrelated", CODE))).toEqual(
      new LibraryRecoveryError({ reason: "fenced" }),
    );
  }),
);

it.effect(
  "expired cleanup drains every sealed stop acknowledgement before releasing the maintenance barrier",
  () =>
    Effect.gen(function* () {
      const f = yield* pruneFixture(70);
      yield* TestClock.adjust("30 days");
      yield* f.reserve();
      yield* f.markVerified();
      yield* f.store.beginCapturePrune("prune");

      const deleted = {
        authorization: yield* f.store.authorizeCapturePrune("prune", 1),
        removedRows: 42,
      };

      yield* f.store.acknowledgeCapturePrune("prune", deleted);
      const library = yield* f.store.status;
      const global = f.port.query("SELECT * FROM recovery_control");
      const permits = f.port.query("SELECT * FROM recovery_runs");
      yield* TestClock.adjust(60 * 86400000 - 1);
      expect(yield* Effect.flip(f.store.beginAbandonCapturePrune("prune"))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(yield* f.store.capturePrune("prune")).toMatchObject({ phase: "deleting" });
      yield* TestClock.adjust(1);
      yield* f.failCommit;
      expect(yield* Effect.flip(f.store.beginAbandonCapturePrune("prune"))).toEqual(
        new LibraryRecoveryError({ reason: "storage" }),
      );
      expect(yield* f.store.capturePrune("prune")).toMatchObject({ phase: "deleting" });
      const stopping = yield* f.store.beginAbandonCapturePrune("prune");
      expect(stopping).toEqual({
        request: f.request,
        phase: "stopping",
        reservedAt: 30 * 86400000,
        capturedAt: 0,
        expiresAt: 90 * 86400000,
        objectCount: 70,
        stoppingAt: 90 * 86400000,
      });
      expect(yield* Effect.flip(f.store.authorizeCapturePrune("prune", 2))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(yield* Effect.flip(f.store.beginCapturePrune("prune"))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(yield* Effect.flip(f.store.completeCapturePrune("prune"))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      yield* f.store.register(objectRef("library-1", 71, "post-reservation"));
      const firstPage = yield* f.store.capturePruneStopInventory("prune");
      expect(firstPage).toHaveLength(64);
      expect(firstPage[0]?.ordinal).toBe(1);
      expect(
        (yield* f.store.capturePruneStopInventory("prune", 64)).map((ref) => ref.ordinal),
      ).toEqual([65, 66, 67, 68, 69, 70]);
      expect(yield* Effect.flip(f.store.authorizeCapturePruneStop("prune", 71))).toEqual(
        new LibraryRecoveryError({ reason: "incomplete" }),
      );
      const authorization = yield* f.store.authorizeCapturePruneStop("prune", 1);
      const receipt = { authorization };
      expect(
        yield* Effect.flip(
          f.store.acknowledgeCapturePruneStopped("prune", {
            authorization: { ...authorization, stoppingAt: authorization.stoppingAt + 1 },
          }),
        ),
      ).toEqual(new LibraryRecoveryError({ reason: "conflict" }));
      yield* f.failCommit;
      expect(yield* Effect.flip(f.store.acknowledgeCapturePruneStopped("prune", receipt))).toEqual(
        new LibraryRecoveryError({ reason: "storage" }),
      );
      expect((yield* f.store.capturePruneStopInventory("prune"))[0]?.ordinal).toBe(1);
      yield* f.store.acknowledgeCapturePruneStopped("prune", receipt);
      const fresh = yield* f.restart;
      expect((yield* fresh.capturePruneStopInventory("prune"))[0]?.ordinal).toBe(2);
      expect(yield* fresh.acknowledgeCapturePruneStopped("prune", receipt)).toEqual(receipt);
      expect(yield* Effect.flip(fresh.completeAbandonCapturePrune("prune"))).toEqual(
        new LibraryRecoveryError({ reason: "incomplete" }),
      );
      expect(yield* Effect.flip(f.beginGlobal("still-held"))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      yield* TestClock.adjust("1 minute");
      expect(yield* fresh.beginAbandonCapturePrune("prune")).toEqual(stopping);

      for (let ordinal = 2; ordinal <= 70; ordinal++)
        yield* fresh.acknowledgeCapturePruneStopped("prune", {
          authorization: yield* fresh.authorizeCapturePruneStop("prune", ordinal),
        });
      yield* f.failCommit;
      expect(yield* Effect.flip(fresh.completeAbandonCapturePrune("prune"))).toEqual(
        new LibraryRecoveryError({ reason: "storage" }),
      );
      expect(yield* fresh.capturePrune("prune")).toMatchObject({ phase: "stopping" });
      expect(
        f.port.query("SELECT id FROM library_journal WHERE kind='capture-prune-abandoned'"),
      ).toEqual([]);
      const proof = yield* fresh.completeAbandonCapturePrune("prune");
      expect(proof).toEqual({
        request: f.request,
        objectCount: 70,
        abandonedAt: 90 * 86400000 + 60000,
      });
      expect(yield* fresh.capturePruneStopInventory("prune")).toEqual([]);
      expect(
        f.port.query("SELECT id FROM library_journal WHERE kind='capture-prune-complete'"),
      ).toEqual([]);
      expect(yield* fresh.status).toEqual(library);
      expect(f.port.query("SELECT * FROM recovery_control")).toEqual(global);
      expect(f.port.query("SELECT * FROM recovery_runs")).toEqual(permits);
      expect(yield* fresh.image("backup", 1)).toEqual(IMAGE);
      expect(yield* fresh.recoverySet("backup")).toEqual(f.set);
      expect(yield* Effect.flip(fresh.grantExport("later-export", "backup"))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(
        yield* Effect.flip(
          fresh.beginRestore("later-native", {
            setId: "backup",
            codeDigest: CODE,
            source: RestoreSources.Native(),
          }),
        ),
      ).toEqual(new LibraryRecoveryError({ reason: "fenced" }));
      expect(yield* Effect.flip(f.beginGlobal("prune"))).toEqual(
        new LibraryRecoveryError({ reason: "conflict" }),
      );
      yield* f.beginGlobal("new-maintenance");
      yield* TestClock.adjust("1 day");
      expect(yield* fresh.beginAbandonCapturePrune("prune")).toEqual({
        ...stopping,
        phase: "abandoned",
      });
      expect(yield* fresh.completeAbandonCapturePrune("prune")).toEqual(proof);
      expect(yield* fresh.acknowledgeCapturePruneStopped("prune", receipt)).toEqual(receipt);
    }),
);

it.effect(
  "an expired unverified reservation can stop without claiming successful deletion or verification",
  () =>
    Effect.gen(function* () {
      const f = yield* pruneFixture(1);
      yield* TestClock.adjust("30 days");
      yield* f.reserve();
      expect(yield* Effect.flip(f.store.authorizeCapturePruneStop("prune", 1))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      yield* TestClock.adjust("60 days");
      yield* f.store.beginAbandonCapturePrune("prune");
      const receipt = { authorization: yield* f.store.authorizeCapturePruneStop("prune", 1) };
      yield* f.store.acknowledgeCapturePruneStopped("prune", receipt);
      expect(yield* f.store.completeAbandonCapturePrune("prune")).toEqual({
        request: f.request,
        objectCount: 1,
        abandonedAt: 90 * 86400000,
      });
      expect(f.port.query("SELECT body FROM library_capture_prune_acks")).toEqual([]);
      expect(
        f.port.query(
          "SELECT json_extract(body,'$.phase') AS phase,json_extract(body,'$.verifiedAt') AS verifiedAt FROM library_retained_prunes",
        ),
      ).toEqual([{ phase: "verifying", verifiedAt: null }]);
      expect(yield* f.store.beginCapture("next-capture", CODE)).toMatchObject({
        phase: "frozen",
        operationId: "next-capture",
        epoch: 1,
      });
    }),
);

it.effect("successful cleanup cannot be relabelled abandoned after expiry", () =>
  Effect.gen(function* () {
    const f = yield* pruneFixture(1);
    yield* TestClock.adjust("30 days");
    yield* f.reserve();
    yield* f.markVerified();
    yield* f.store.beginCapturePrune("prune");
    yield* f.store.acknowledgeCapturePrune("prune", {
      authorization: yield* f.store.authorizeCapturePrune("prune", 1),
      removedRows: 3,
    });
    const completed = yield* f.store.completeCapturePrune("prune");
    yield* TestClock.adjust("60 days");
    expect(yield* Effect.flip(f.store.beginAbandonCapturePrune("prune"))).toEqual(
      new LibraryRecoveryError({ reason: "conflict" }),
    );
    expect(yield* f.store.completeCapturePrune("prune")).toEqual(completed);
    expect(
      f.port.query("SELECT id FROM library_journal WHERE kind='capture-prune-abandoned'"),
    ).toEqual([]);
  }),
);

it.effect("capture-only resumes every sealed member before reopening the same lineage", () =>
  Effect.gen(function* () {
    const { store, restart, failCommit } = yield* databaseFixture;
    const first = yield* ready(store);
    const second = yield* store.register(objectRef("library-1", 2, "other"));
    yield* store.beginCapture("backup", CODE);
    expect(yield* store.beginCapture("backup", CODE)).toMatchObject({
      phase: "frozen",
      operationKind: "capture",
      epoch: 1,
    });
    expect(yield* Effect.flip(store.beginCaptureResume("backup"))).toEqual(
      new LibraryRecoveryError({ reason: "incomplete" }),
    );

    for (const ordinal of [first, second]) {
      yield* store.acknowledgeFreeze("backup", ordinal, "running", null);
      yield* store.acknowledgeFreeze("backup", ordinal, "running", "held");
      yield* store.recordImage("backup", ordinal, IMAGE);
    }

    yield* store.seal("backup", 9, CODE);
    const resumed = yield* restart;
    expect(yield* resumed.beginCaptureResume("backup")).toMatchObject({ phase: "resuming" });
    expect(yield* resumed.register(objectRef(), "backup")).toBe(first);
    expect(
      yield* Effect.flip(resumed.register(objectRef("library-1", 3, "new-key"), "backup")),
    ).toEqual(new LibraryRecoveryError({ reason: "fenced" }));
    expect(yield* Effect.flip(resumed.admit(1))).toEqual(
      new LibraryRecoveryError({ reason: "fenced" }),
    );
    expect(
      yield* Effect.flip(resumed.acknowledgeResumed("backup", first, "release", "fresh")),
    ).toEqual(new LibraryRecoveryError({ reason: "incomplete" }));
    yield* resumed.acknowledgeResumed("backup", first, "release", null);
    expect(
      yield* Effect.flip(resumed.acknowledgeResumed("backup", first, "release", "release")),
    ).toEqual(new LibraryRecoveryError({ reason: "invalid" }));
    yield* resumed.acknowledgeResumed("backup", first, "release", "fresh");
    yield* resumed.acknowledgeResumed("backup", first, "release", null);
    expect(yield* resumed.resumeProgress("backup", first)).toEqual({
      before: "release",
      after: "fresh",
    });
    expect(yield* Effect.flip(resumed.completeCapture("backup"))).toEqual(
      new LibraryRecoveryError({ reason: "incomplete" }),
    );
    yield* resumed.acknowledgeResumed("backup", second, "release-2", null);
    yield* resumed.acknowledgeResumed("backup", second, "release-2", "fresh-2");
    yield* failCommit;
    expect(yield* Effect.flip(resumed.completeCapture("backup"))).toEqual(
      new LibraryRecoveryError({ reason: "storage" }),
    );
    const fresh = yield* restart;
    expect(yield* fresh.captureCompletion("backup")).toBeNull();
    expect(yield* fresh.status).toMatchObject({ phase: "resuming", epoch: 1 });
    const completed = yield* fresh.completeCapture("backup");
    expect(completed).toEqual({
      libraryId: "owner",
      epoch: 1,
      lineage: "library-1",
      nextLineage: 2,
      phase: "ready",
      inventoryId: "legacy-inventory",
      operationId: null,
      stagingLineage: null,
      allocatorFloor: 9,
    });
    expect(yield* fresh.admit(1)).toEqual({ libraryId: "owner", epoch: 1, lineage: "library-1" });
    yield* fresh.beginCapture("next-backup", CODE);
    expect(yield* fresh.completeCapture("backup")).toEqual(completed);
    expect(yield* fresh.status).toMatchObject({ phase: "frozen", operationId: "next-backup" });
  }),
);

it.effect("seal persists its server timestamp once and rejects changed capture inputs", () =>
  Effect.gen(function* () {
    const { store } = yield* databaseFixture;
    const ordinal = yield* ready(store);
    yield* store.beginCapture("backup", CODE);
    yield* store.acknowledgeFreeze("backup", ordinal, "running", null);
    yield* store.acknowledgeFreeze("backup", ordinal, "running", "held");
    yield* store.recordImage("backup", ordinal, IMAGE);
    yield* TestClock.adjust("2 seconds");
    const sealed = yield* store.seal("backup", 4, CODE);
    expect(sealed.capturedAt).toBe(2000);
    yield* TestClock.adjust("5 seconds");
    expect(yield* store.seal("backup", 4, CODE)).toEqual(sealed);
    expect(yield* Effect.flip(store.seal("backup", 5, CODE))).toEqual(
      new LibraryRecoveryError({ reason: "conflict" }),
    );
    expect(yield* Effect.flip(store.seal("backup", 4, "c".repeat(64)))).toEqual(
      new LibraryRecoveryError({ reason: "conflict" }),
    );
    expect(yield* store.recoverySet("backup")).toEqual(sealed);
    expect(yield* store.status).toMatchObject({ allocatorFloor: 4 });
  }),
);

it.effect("partial capture binds its original digest before seal and survives failed commits", () =>
  Effect.gen(function* () {
    const { store, restart, port, failCommit } = yield* databaseFixture;
    const first = yield* ready(store);
    const second = yield* store.register(objectRef("library-1", 2, "other"));
    expect(yield* Effect.flip(store.beginCapture("backup", ""))).toEqual(
      new LibraryRecoveryError({ reason: "invalid" }),
    );
    yield* failCommit;
    expect(yield* Effect.flip(store.beginCapture("backup", CODE))).toEqual(
      new LibraryRecoveryError({ reason: "storage" }),
    );
    expect(yield* store.status).toMatchObject({ phase: "ready", operationId: null });
    expect(
      port.query("SELECT body FROM library_journal WHERE kind='operation' AND id='backup'"),
    ).toEqual([]);
    yield* store.beginCapture("backup", CODE);

    for (const ordinal of [first, second]) {
      yield* store.acknowledgeFreeze("backup", ordinal, "running", null);
      yield* store.acknowledgeFreeze("backup", ordinal, "running", "held");
    }

    yield* store.recordImage("backup", first, IMAGE);
    const fresh = yield* restart;
    expect(yield* fresh.recoverySet("backup")).toBeNull();
    expect(yield* Effect.flip(fresh.beginCapture("backup", "c".repeat(64)))).toEqual(
      new LibraryRecoveryError({ reason: "conflict" }),
    );
    expect(yield* fresh.image("backup", first)).toEqual(IMAGE);
    expect(yield* fresh.image("backup", second)).toBeNull();
    expect(yield* fresh.beginCapture("backup", CODE)).toMatchObject({
      phase: "frozen",
      operationId: "backup",
    });
    yield* fresh.recordImage("backup", second, IMAGE);
    expect(yield* Effect.flip(fresh.seal("backup", 7, "c".repeat(64)))).toEqual(
      new LibraryRecoveryError({ reason: "conflict" }),
    );
    expect(yield* fresh.recoverySet("backup")).toBeNull();
    expect(yield* fresh.status).toMatchObject({ allocatorFloor: 2 });
    expect(yield* fresh.seal("backup", 7, CODE)).toMatchObject({
      codeDigest: CODE,
      objectCount: 2,
    });

    const intent = Schema.decodeUnknownSync(
      Schema.Struct({ body: Schema.fromJsonString(Schema.JsonObject) }),
    )(port.query("SELECT body FROM library_journal WHERE kind='operation' AND id='backup'")[0]);

    expect(intent.body).toEqual({ kind: "capture", setId: null, codeDigest: CODE });
  }),
);

it.effect(
  "restore acquisition binds target, digest and source before partial work survives restart",
  () =>
    Effect.gen(function* () {
      const { store, restart, failCommit } = yield* databaseFixture;
      const first = yield* ready(store);
      yield* store.register(objectRef("library-1", 2, "other"));
      expect(yield* store.restoreIntent("restore")).toBeNull();
      const confusedSource = { ...RestoreSources.Native(), archiveId: "archive" };
      expect(
        yield* Effect.flip(
          store.beginRestore("restore", { ...retainedIntent, source: confusedSource }),
        ),
      ).toEqual(new LibraryRecoveryError({ reason: "invalid" }));
      yield* failCommit;
      expect(yield* Effect.flip(store.beginRestore("restore", retainedIntent))).toEqual(
        new LibraryRecoveryError({ reason: "storage" }),
      );
      expect(yield* store.restoreIntent("restore")).toBeNull();
      expect(yield* store.status).toMatchObject({ phase: "ready", operationId: null });
      yield* store.beginRestore("restore", retainedIntent);
      yield* store.acknowledgeFreeze("restore", first, "running", null);
      yield* store.acknowledgeFreeze("restore", first, "running", "held");
      yield* store.recordImage("restore", first, IMAGE);
      const fresh = yield* restart;
      expect(yield* fresh.restoreIntent("restore")).toEqual({
        setId: "restore",
        codeDigest: "a".repeat(64),
        source: RestoreSources.Retained({ archiveId: "archive", manifestDigest: "c".repeat(64) }),
      });

      const changed = [
        { ...retainedIntent, setId: "other-set" },
        { ...retainedIntent, codeDigest: "d".repeat(64) },
        { ...retainedIntent, source: RestoreSources.Native() },
        {
          ...retainedIntent,
          source: RestoreSources.Retained({
            archiveId: "other-archive",
            manifestDigest: "c".repeat(64),
          }),
        },
        {
          ...retainedIntent,
          source: RestoreSources.Retained({ archiveId: "archive", manifestDigest: "d".repeat(64) }),
        },
      ];

      for (const intent of changed)
        expect(yield* Effect.flip(fresh.beginRestore("restore", intent))).toEqual(
          new LibraryRecoveryError({ reason: "conflict" }),
        );
      expect(yield* fresh.image("restore", first)).toEqual(IMAGE);
      expect(yield* fresh.recoverySet("restore")).toBeNull();
      expect(yield* fresh.beginRestore("restore", retainedIntent)).toMatchObject({
        phase: "frozen",
        operationKind: "restore",
      });
    }),
);

it.effect(
  "restore intent persists through staging and publication without acquiring a replay lease",
  () =>
    Effect.gen(function* () {
      const { store, restart } = yield* databaseFixture;
      const ordinal = yield* ready(store);
      yield* store.beginRestore("restore", retainedIntent);
      yield* store.acknowledgeFreeze("restore", ordinal, "before", null);
      yield* store.acknowledgeFreeze("restore", ordinal, "before", "after");
      yield* store.recordImage("restore", ordinal, IMAGE);
      expect(yield* Effect.flip(store.seal("restore", 7, "d".repeat(64)))).toEqual(
        new LibraryRecoveryError({ reason: "conflict" }),
      );
      expect(yield* store.recoverySet("restore")).toBeNull();
      yield* store.seal("restore", 7, CODE);
      expect(yield* Effect.flip(store.prepareRestore("restore", "other-set"))).toEqual(
        new LibraryRecoveryError({ reason: "conflict" }),
      );
      yield* stage(store, "restore", "restore");
      const fresh = yield* restart;
      expect(yield* fresh.restoreIntent("restore")).toEqual(retainedIntent);
      const published = yield* fresh.publish("restore", 7);
      yield* fresh.beginCapture("later", CODE);
      expect(yield* fresh.restoreIntent("restore")).toEqual(retainedIntent);
      expect(yield* fresh.publication("restore", "restore", CODE)).toEqual(published);
      expect(yield* Effect.flip(fresh.beginRestore("restore", retainedIntent))).toEqual(
        new LibraryRecoveryError({ reason: "conflict" }),
      );
      expect(yield* fresh.status).toMatchObject({
        operationId: "later",
        phase: "frozen",
        epoch: 2,
      });
    }),
);

it.effect("new restore requests cannot adopt unbound legacy or capture operations", () =>
  Effect.gen(function* () {
    const { store } = yield* databaseFixture;
    yield* ready(store);
    yield* capture(store, "restore", 7);
    expect(yield* store.restoreIntent("restore")).toBeNull();
    expect(yield* Effect.flip(store.beginRestore("restore", retainedIntent))).toEqual(
      new LibraryRecoveryError({ reason: "conflict" }),
    );
    yield* stage(store, "restore", "restore");
    yield* store.publish("restore", 7);
    expect(yield* store.restoreIntent("restore")).toBeNull();
    expect(yield* Effect.flip(store.beginRestore("restore", retainedIntent))).toEqual(
      new LibraryRecoveryError({ reason: "conflict" }),
    );
    yield* store.beginCapture("backup", CODE);
    expect(yield* Effect.flip(store.beginRestore("backup", retainedIntent))).toEqual(
      new LibraryRecoveryError({ reason: "conflict" }),
    );
    expect(yield* Effect.flip(store.restoreIntent("backup"))).toEqual(
      new LibraryRecoveryError({ reason: "conflict" }),
    );
    expect(yield* store.status).toMatchObject({ operationId: "backup", operationKind: "capture" });
  }),
);

it.effect("historical restore operation records retain absent kind and capture timestamp", () =>
  Effect.gen(function* () {
    const { store, port, restart } = yield* databaseFixture;
    const ordinal = yield* ready(store);
    yield* store.beginFreeze("restore");
    port.query("UPDATE library_control SET body=json_remove(body,'$.operationKind') WHERE id=1");
    port.query(
      "UPDATE library_journal SET body=json_remove(body,'$.kind') WHERE kind='operation' AND id='restore'",
    );
    yield* store.acknowledgeFreeze("restore", ordinal, "running", null);
    yield* store.acknowledgeFreeze("restore", ordinal, "running", "held");
    yield* store.recordImage("restore", ordinal, IMAGE);
    yield* store.seal("restore", 4, CODE);
    port.query(
      "UPDATE library_journal SET body=json_remove(body,'$.capturedAt') WHERE kind='set' AND id='restore'",
    );
    const fresh = yield* restart;
    yield* TestClock.adjust("5 seconds");
    const historical = yield* fresh.seal("restore", 4, CODE);
    expect(historical).toEqual({
      id: "restore",
      sourceLineage: "library-1",
      inventoryId: "legacy-inventory",
      allocatorFloor: 4,
      objectCount: 1,
      codeDigest: CODE,
    });
    expect(yield* Effect.flip(fresh.beginCaptureResume("restore"))).toEqual(
      new LibraryRecoveryError({ reason: "fenced" }),
    );
    expect(yield* fresh.prepareRestore("restore", "restore")).toMatchObject({ phase: "staging" });
  }),
);

it.effect("sealed inventory pages sixty-four members without following later registrations", () =>
  Effect.gen(function* () {
    const { store } = yield* databaseFixture;
    yield* ready(store);

    for (let ordinal = 2; ordinal <= 70; ordinal++)
      yield* store.register(objectRef("library-1", ordinal, `key-${ordinal}`));

    yield* store.beginCapture("large", CODE);

    for (let ordinal = 1; ordinal <= 70; ordinal++) {
      yield* store.acknowledgeFreeze("large", ordinal, "running", null);
      yield* store.acknowledgeFreeze("large", ordinal, "running", "held");
      yield* store.recordImage("large", ordinal, IMAGE);
    }

    yield* store.seal("large", 2, CODE);
    yield* store.beginCaptureResume("large");

    for (let ordinal = 1; ordinal <= 70; ordinal++) {
      yield* store.acknowledgeResumed("large", ordinal, "release", null);
      yield* store.acknowledgeResumed("large", ordinal, "release", "fresh");
    }

    yield* store.completeCapture("large");
    yield* store.register(objectRef("library-1", 71, "later"));
    const first = yield* store.captureInventory("large");
    const second = yield* store.captureInventory("large", 64);
    expect(first).toHaveLength(64);
    expect(first[0]?.ordinal).toBe(1);
    expect(first.at(-1)?.ordinal).toBe(64);
    expect(second.map((entry) => entry.ordinal)).toEqual([65, 66, 67, 68, 69, 70]);
    expect(yield* store.captureInventory("large", 70)).toEqual([]);
    expect(yield* Effect.flip(store.captureInventory("unsealed"))).toEqual(
      new LibraryRecoveryError({ reason: "incomplete" }),
    );
  }),
);

it.effect("capture and restore identities cannot acquire each other's mutation authority", () =>
  Effect.gen(function* () {
    const { store } = yield* databaseFixture;
    yield* ready(store);
    yield* store.beginCapture("backup", CODE);
    expect(yield* Effect.flip(store.beginFreeze("backup"))).toEqual(
      new LibraryRecoveryError({ reason: "fenced" }),
    );
    expect(yield* Effect.flip(store.prepareRestore("backup", "backup"))).toEqual(
      new LibraryRecoveryError({ reason: "fenced" }),
    );
    expect(yield* Effect.flip(store.beginActivation("backup"))).toEqual(
      new LibraryRecoveryError({ reason: "fenced" }),
    );
    expect(yield* Effect.flip(store.publish("backup", 2))).toEqual(
      new LibraryRecoveryError({ reason: "fenced" }),
    );
    expect(yield* store.captureCompletion("backup")).toBeNull();
  }),
);

it.effect(
  "export grants bind completed immutable sets and exact source identity after reopening",
  () =>
    Effect.gen(function* () {
      const { store, restart } = yield* databaseFixture;
      const ordinal = yield* ready(store);
      yield* store.beginCapture("backup", CODE);
      yield* store.acknowledgeFreeze("backup", ordinal, "running", null);
      yield* store.acknowledgeFreeze("backup", ordinal, "running", "held");
      yield* store.recordImage("backup", ordinal, IMAGE);
      const set = yield* store.seal("backup", 4, CODE);
      expect(yield* Effect.flip(store.grantExport("upload", "backup"))).toEqual(
        new LibraryRecoveryError({ reason: "incomplete" }),
      );
      yield* store.beginCaptureResume("backup");
      yield* store.acknowledgeResumed("backup", ordinal, "release", null);
      yield* store.acknowledgeResumed("backup", ordinal, "release", "fresh");
      yield* store.completeCapture("backup");
      expect(yield* store.grantExport("upload", "backup")).toEqual(set);
      expect(yield* store.grantExport("upload", "backup")).toEqual(set);
      const later = yield* store.register(objectRef("library-1", 2, "later"));
      const fresh = yield* restart;
      expect(yield* fresh.captureInventory("backup")).toEqual([
        { ...objectRef(), ordinal, phase: "active" },
      ]);
      expect(yield* fresh.captureInventory("backup", ordinal)).toEqual([]);
      expect(yield* fresh.inventory("library-1")).toHaveLength(2);
      expect(yield* fresh.authorizeExport("upload", "backup", ordinal)).toEqual({
        captureId: "backup",
        ordinal,
        source: objectRef(),
        image: IMAGE,
      });
      expect(yield* Effect.flip(fresh.authorizeExport("missing", "backup", ordinal))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(yield* Effect.flip(fresh.authorizeExport("upload", "other", ordinal))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(yield* Effect.flip(fresh.authorizeExport("upload", "backup", later))).toEqual(
        new LibraryRecoveryError({ reason: "incomplete" }),
      );
      yield* fresh.beginCapture("other", CODE);

      for (const item of [ordinal, later]) {
        yield* fresh.acknowledgeFreeze("other", item, "running", null);
        yield* fresh.acknowledgeFreeze("other", item, "running", "held");
        yield* fresh.recordImage("other", item, IMAGE);
      }

      yield* fresh.seal("other", 8, CODE);
      yield* fresh.beginCaptureResume("other");

      for (const item of [ordinal, later]) {
        yield* fresh.acknowledgeResumed("other", item, "release", null);
        yield* fresh.acknowledgeResumed("other", item, "release", "fresh");
      }

      yield* fresh.completeCapture("other");
      expect(yield* Effect.flip(fresh.grantExport("upload", "other"))).toEqual(
        new LibraryRecoveryError({ reason: "conflict" }),
      );
      expect(yield* Effect.flip(fresh.beginFreeze("backup"))).toEqual(
        new LibraryRecoveryError({ reason: "conflict" }),
      );
      expect(yield* fresh.authorizeExport("upload", "backup", ordinal)).toMatchObject({
        image: IMAGE,
      });
    }),
);

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
