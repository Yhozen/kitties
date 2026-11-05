import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import * as Data from "effect/Data";
import {
  LibraryObjectAdmin,
  LibrarySqlRow,
  type LibraryAdminRequest,
  type LibraryAdminReply,
  type LibraryObjectInspection,
  type LibraryObjectStorage,
} from "./library-object-admin.ts";
import {
  LibraryExportAuthorization,
  LibraryObjectImage,
  LibraryRecoveryState,
  RegisteredLibraryObject,
} from "./library-recovery-records.ts";
import { LibraryImageError, type LibraryNativeValue } from "./library-image.ts";
import {
  LibraryCapturePruneAuthorization,
  LibraryCapturePruneStopAuthorization,
} from "./library-capture-prune-records.ts";

const scheduler = `
CREATE TABLE IF NOT EXISTS alchemy_alarm_schema(id INTEGER PRIMARY KEY,version INTEGER NOT NULL);
INSERT OR IGNORE INTO alchemy_alarm_schema VALUES(1,2);
CREATE TABLE IF NOT EXISTS alchemy_alarm_callbacks(callback TEXT,id TEXT,version TEXT,run_at INTEGER,payload TEXT,scheduled_at INTEGER,retry_at INTEGER,attempts INTEGER,parked INTEGER,progress INTEGER,PRIMARY KEY(callback,id));
CREATE TABLE IF NOT EXISTS alchemy_scheduled_events(id TEXT PRIMARY KEY,run_at INTEGER,repeat_ms INTEGER,payload TEXT);
`;

const fixture = (lineage: string, phase: "frozen" | "staging") => {
  const database = new DatabaseSync(":memory:");
  const values = new Map<string, LibraryNativeValue>();
  let alarm: number | null = 10000;
  let selected: LibraryObjectImage | null = null;
  let exported: LibraryExportAuthorization | null = null;
  let prune: LibraryCapturePruneAuthorization | null = null;
  let pruneGate: Effect.Effect<void> = Effect.void;
  let pruneStop: LibraryCapturePruneStopAuthorization | null = null;
  let stopAuthorizationCalls = 0;

  let inspection: LibraryObjectInspection = {
    identity: RegisteredLibraryObject.make({
      modelName: "LibraryModel",
      layout: 0,
      className: "LibraryModel.LibraryAggregate",
      lineage,
      logicalName: "owner",
      physicalName: `r:${lineage}:owner`,
      nativeId: "a".repeat(64),
      ordinal: 1,
      phase,
    }),
    recovery: LibraryRecoveryState.make({
      libraryId: "owner",
      epoch: 1,
      lineage: "library-1",
      nextLineage: 3,
      phase,
      inventoryId: "inventory",
      operationId: "capture",
      stagingLineage: phase === "staging" ? lineage : null,
      allocatorFloor: 2,
    }),
  };

  const storage: LibraryObjectStorage = {
    sql: {
      exec: (statement, ...bindings) => {
        const rows = Schema.decodeUnknownSync(Schema.Array(LibrarySqlRow))(
          database.prepare(statement).all(...bindings),
        );

        return { toArray: () => rows };
      },
    },
    kv: {
      get: (key) => values.get(key),
      put: (key, value) => {
        values.set(key, value);
      },
      delete: (key) => values.delete(key),
      list: (options) =>
        [...values]
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .filter(
            ([key]) =>
              (options.prefix === undefined || key.startsWith(options.prefix)) &&
              (options.startAfter === undefined || key > options.startAfter),
          )
          .slice(0, options.limit),
    },
    transaction: (body) => {
      const before = new Map(values);
      database.exec("BEGIN");

      try {
        const result = body();
        database.exec("COMMIT");

        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        values.clear();

        for (const [key, value] of before) values.set(key, value);
        throw error;
      }
    },
    prepareScheduler: Effect.sync(() => {
      database.exec(scheduler);
    }),
    alarm: Effect.sync(() => alarm),
    clearAlarm: Effect.sync(() => {
      alarm = null;
    }),
    setAlarm: (at) =>
      Effect.sync(() => {
        alarm = at;
      }),
  };

  const acquire = Effect.suspend(() =>
    LibraryObjectAdmin.pipe(
      Effect.provide(
        LibraryObjectAdmin.layer({
          ...inspection,
          storage,
          refresh: Effect.sync(() => inspection),
          authorizeCapture: (operationId, captureId) =>
            selected !== null && operationId === "rollback" && captureId === "capture"
              ? Effect.succeed(selected)
              : Effect.fail(new LibraryImageError({ reason: "conflict" })),
          authorizeExport: (grantId, captureId) =>
            exported !== null && grantId === "upload" && captureId === "capture"
              ? Effect.succeed(exported)
              : Effect.fail(new LibraryImageError({ reason: "conflict" })),
          authorizePrune: (pruneId, captureId) =>
            prune !== null &&
            prune.request.pruneId === pruneId &&
            prune.request.captureId === captureId
              ? Effect.succeed(prune).pipe(Effect.tap(() => pruneGate))
              : Effect.fail(new LibraryImageError({ reason: "conflict" })),
          authorizePruneStop: (pruneId, captureId) => {
            const selected = pruneStop;

            return selected !== null &&
              selected.request.pruneId === pruneId &&
              selected.request.captureId === captureId
              ? Effect.sync(() => {
                  stopAuthorizationCalls++;

                  return selected;
                })
              : Effect.fail(new LibraryImageError({ reason: "conflict" }));
          },
          closeSockets: () => {},
          evict: () => {},
        }),
      ),
    ),
  );

  return {
    database,
    values,
    storage,
    acquire,
    inspection: () => inspection,
    grantExport: (value: LibraryExportAuthorization) => {
      exported = value;
    },
    grantPrune: (value: LibraryCapturePruneAuthorization | null) => {
      prune = value;
    },
    grantPruneStop: (value: LibraryCapturePruneStopAuthorization | null) => {
      pruneStop = value;
    },
    pausePruneAuthorization: (gate: Effect.Effect<void>) => {
      pruneGate = gate;
    },
    stopAuthorizationCalls: () => stopAuthorizationCalls,
    captureOnly: () => {
      if (inspection.recovery === null) throw Error("fixture recovery");
      inspection = {
        ...inspection,
        recovery: { ...inspection.recovery, operationKind: "capture" },
      };
    },
    resumeCapture: () => {
      if (inspection.identity === null || inspection.recovery === null)
        throw Error("fixture identity");
      inspection = {
        identity: { ...inspection.identity, phase: "resuming" },
        recovery: { ...inspection.recovery, phase: "resuming", operationKind: "capture" },
      };
    },
    completeCapture: () => {
      if (inspection.identity === null || inspection.recovery === null)
        throw Error("fixture identity");
      inspection = {
        identity: { ...inspection.identity, phase: "active" },
        recovery: { ...inspection.recovery, phase: "ready", operationId: null },
      };
    },
    beginRecovery: (operationId: string) => {
      if (inspection.identity === null || inspection.recovery === null)
        throw Error("fixture identity");
      inspection = {
        identity: { ...inspection.identity, phase: "frozen" },
        recovery: {
          ...inspection.recovery,
          phase: "frozen",
          operationId,
          operationKind: "restore",
        },
      };
    },
    selectRetained: (image: LibraryObjectImage) => {
      if (inspection.identity === null || inspection.recovery === null)
        throw Error("fixture identity");
      selected = image;
      inspection = {
        identity: { ...inspection.identity, phase: "retired" },
        recovery: {
          ...inspection.recovery,
          lineage: "library-2",
          stagingLineage: "library-3",
          phase: "staging",
          operationId: "rollback",
        },
      };
    },
    activate: () => {
      if (inspection.identity === null || inspection.recovery === null)
        throw Error("fixture identity");
      inspection = {
        identity: { ...inspection.identity, phase: "activating" },
        recovery: { ...inspection.recovery, phase: "activating" },
      };
    },
  };
};

const capture = (admin: LibraryObjectAdmin["Service"]) =>
  Effect.gen(function* () {
    for (let step = 0; step < 8; step++) {
      const reply = yield* admin.libraryAdmin(Request.CaptureStep({ operationId: "capture" }));

      if (!Predicate.isTagged(reply, "Progress")) return yield* Effect.die(reply);

      if (reply.value.image !== null) return reply.value.image;
    }

    return yield* Effect.die("bounded capture did not complete");
  });

const Request = Data.taggedEnum<LibraryAdminRequest>();
const Reply = Data.taggedEnum<LibraryAdminReply>();

const pruneGrant = (image: LibraryObjectImage) =>
  LibraryCapturePruneAuthorization.make({
    request: {
      pruneId: "prune",
      captureId: "capture",
      archiveId: "archive",
      codeDigest: "a".repeat(64),
      manifestDigest: "b".repeat(64),
    },
    ordinal: 1,
    source: {
      modelName: "LibraryModel",
      layout: 0,
      className: "LibraryModel.LibraryAggregate",
      lineage: "library-1",
      logicalName: "owner",
      physicalName: "r:library-1:owner",
      nativeId: "a".repeat(64),
    },
    image,
  });

it.effect(
  "capture pruning deletes at most64 image rows and resumes after lost acknowledgement without touching live state",
  () =>
    Effect.gen(function* () {
      const source = fixture("library-1", "frozen");
      yield* Effect.addFinalizer(() => Effect.sync(() => source.database.close()));
      source.captureOnly();

      for (let index = 0; index < 70; index++)
        source.values.set(`receipt:${index}`, { reply: index });
      const initial = yield* source.acquire;
      yield* initial.libraryAdmin(Request.Freeze({ operationId: "capture" }));
      const frozen = yield* source.acquire;
      const image = yield* capture(frozen);

      for (let row = 1; row <= 3; row++) {
        const part = yield* frozen.libraryAdmin(
          Request.ReadPart({ operationId: "capture", captureId: "capture", row, part: 0 }),
        );

        if (!Predicate.isTagged(part, "Part")) return yield* Effect.die(part);
        source.database
          .prepare("INSERT INTO library_admin_parts VALUES ('capture',?,0,?)")
          .run(row, JSON.stringify(part.value));
      }

      source.database.exec(
        "INSERT INTO library_admin_images SELECT 'other',body FROM library_admin_images WHERE id='capture'",
      );
      source.database.exec(
        "INSERT INTO library_admin_rows SELECT 'other',row_number,kind,key,digest,body FROM library_admin_rows WHERE id='capture'",
      );
      source.database.exec(
        "INSERT INTO library_admin_parts SELECT 'other',row_number,part,body FROM library_admin_parts WHERE id='capture'",
      );
      source.resumeCapture();
      yield* frozen.libraryAdmin(Request.ResumeCapture({ operationId: "capture" }));
      const resumed = yield* source.acquire;
      yield* resumed.afterInitialize(new Set());
      source.completeCapture();
      const active = yield* source.acquire;
      source.values.set("receipt:after-capture", { reply: "new live receipt" });
      source.database.exec(
        "INSERT INTO alchemy_scheduled_events VALUES ('new-event',12345,NULL,'live')",
      );
      const live = [...source.values];
      const guard = source.database.prepare("SELECT * FROM library_admin_guard").all();
      const callbacks = source.database.prepare("SELECT * FROM alchemy_alarm_callbacks").all();
      const schedules = source.database.prepare("SELECT * FROM alchemy_scheduled_events").all();

      const holds = source.database
        .prepare("SELECT * FROM library_admin_hold_alchemy_alarm_schema")
        .all();

      const otherRows = source.database
        .prepare("SELECT * FROM library_admin_rows WHERE id='other'")
        .all();

      const otherParts = source.database
        .prepare("SELECT * FROM library_admin_parts WHERE id='other'")
        .all();

      const otherImages = source.database
        .prepare("SELECT * FROM library_admin_images WHERE id='other'")
        .all();

      const authorization = pruneGrant(image);
      source.grantPrune(authorization);
      const request = Request.PruneCaptureStep({ pruneId: "prune", captureId: "capture" });
      expect(yield* active.libraryAdmin(request)).toEqual(
        Reply.PruneProgress({ value: { done: false, removedRows: 64, receipt: null } }),
      );
      expect(
        source.database
          .prepare("SELECT COUNT(*) AS count FROM library_admin_parts WHERE id='capture'")
          .all(),
      ).toEqual([{ count: 0 }]);
      expect(
        source.database
          .prepare("SELECT COUNT(*) AS count FROM library_admin_rows WHERE id='capture'")
          .all(),
      ).toEqual([{ count: 11 }]);
      const fresh = yield* source.acquire;
      expect(fresh.allowed).toBe(true);

      const terminal = Reply.PruneProgress({
        value: { done: true, removedRows: 76, receipt: { authorization, removedRows: 76 } },
      });

      expect(yield* fresh.libraryAdmin(request)).toEqual(terminal);
      const afterLostAck = yield* source.acquire;
      expect(yield* afterLostAck.libraryAdmin(request)).toEqual(terminal);

      for (const table of ["library_admin_images", "library_admin_rows", "library_admin_parts"])
        expect(
          source.database
            .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE id='capture'`)
            .all(),
        ).toEqual([{ count: 0 }]);
      expect([...source.values]).toEqual(live);
      expect(source.database.prepare("SELECT * FROM library_admin_guard").all()).toEqual(guard);
      expect(source.database.prepare("SELECT * FROM alchemy_alarm_callbacks").all()).toEqual(
        callbacks,
      );
      expect(source.database.prepare("SELECT * FROM alchemy_scheduled_events").all()).toEqual(
        schedules,
      );
      expect(
        source.database.prepare("SELECT * FROM library_admin_hold_alchemy_alarm_schema").all(),
      ).toEqual(holds);
      expect(
        source.database.prepare("SELECT * FROM library_admin_rows WHERE id='other'").all(),
      ).toEqual(otherRows);
      expect(
        source.database.prepare("SELECT * FROM library_admin_parts WHERE id='other'").all(),
      ).toEqual(otherParts);
      expect(
        source.database.prepare("SELECT * FROM library_admin_images WHERE id='other'").all(),
      ).toEqual(otherImages);
    }),
);

it.effect(
  "capture pruning refuses missing or changed exact grants before deleting any buffer",
  () =>
    Effect.gen(function* () {
      const source = fixture("library-1", "frozen");
      yield* Effect.addFinalizer(() => Effect.sync(() => source.database.close()));
      source.values.set("receipt:owner", { reply: "stable" });
      const admin = yield* source.acquire;
      const image = yield* capture(admin);
      const before = source.database.prepare("SELECT * FROM library_admin_rows").all();
      const authorization = pruneGrant(image);
      const request = Request.PruneCaptureStep({ pruneId: "prune", captureId: "capture" });
      expect(yield* admin.libraryAdmin(request)).toEqual(Reply.Rejected({ reason: "conflict" }));
      source.grantPrune({ ...authorization, ordinal: 2 });
      expect(yield* admin.libraryAdmin(request)).toEqual(Reply.Rejected({ reason: "fenced" }));
      source.grantPrune({
        ...authorization,
        source: { ...authorization.source, className: "LibraryModel.DomainDirectory" },
      });
      expect(yield* admin.libraryAdmin(request)).toEqual(Reply.Rejected({ reason: "fenced" }));
      source.grantPrune({ ...authorization, image: { ...image, digest: "f".repeat(64) } });
      expect(yield* admin.libraryAdmin(request)).toEqual(Reply.Rejected({ reason: "conflict" }));
      expect(source.database.prepare("SELECT * FROM library_admin_rows").all()).toEqual(before);
      expect(source.database.prepare("SELECT * FROM library_admin_prunes").all()).toEqual([]);
      source.grantPrune(authorization);
      const done = yield* admin.libraryAdmin(request);
      expect(done._tag).toBe("PruneProgress");
      source.grantPrune({
        ...authorization,
        request: { ...authorization.request, manifestDigest: "c".repeat(64) },
      });
      expect(yield* admin.libraryAdmin(request)).toEqual(Reply.Rejected({ reason: "conflict" }));
      source.grantPrune(null);
      expect(yield* admin.libraryAdmin(request)).toEqual(Reply.Rejected({ reason: "conflict" }));
    }),
);

it.effect(
  "stop acknowledgement drains an already authorized delete under the same object semaphore and survives lost reply",
  () =>
    Effect.gen(function* () {
      const source = fixture("library-1", "frozen");
      yield* Effect.addFinalizer(() => Effect.sync(() => source.database.close()));

      for (let index = 0; index < 70; index++)
        source.values.set(`receipt:${index}`, { reply: index });
      const admin = yield* source.acquire;
      const image = yield* capture(admin);
      const authorization = pruneGrant(image);

      const stopping = LibraryCapturePruneStopAuthorization.make({
        ...authorization,
        stoppingAt: 90 * 86400000,
      });

      source.grantPrune(authorization);
      source.grantPruneStop(stopping);
      const authorized = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      source.pausePruneAuthorization(
        Deferred.succeed(authorized, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const step = Request.PruneCaptureStep({ pruneId: "prune", captureId: "capture" });

      const deleting = yield* admin
        .libraryAdmin(step)
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(authorized);
      source.grantPrune(null);
      const stop = Request.StopPrune({ pruneId: "prune", captureId: "capture" });

      const stoppingFiber = yield* admin
        .libraryAdmin(stop)
        .pipe(Effect.forkChild({ startImmediately: true }));

      // Immediate child start runs until suspension. The stop cannot even request
      // its grant while the old request holds the semaphore across authorization.
      expect(source.stopAuthorizationCalls()).toBe(0);
      expect(source.database.prepare("SELECT * FROM library_admin_prune_stops").all()).toEqual([]);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(deleting)).toEqual(
        Reply.PruneProgress({ value: { done: false, removedRows: 64, receipt: null } }),
      );
      const expected = Reply.PruneStopped({ value: { authorization: stopping } });
      expect(yield* Fiber.join(stoppingFiber)).toEqual(expected);
      expect(source.stopAuthorizationCalls()).toBe(1);

      const remaining = source.database
        .prepare("SELECT * FROM library_admin_rows WHERE id='capture'")
        .all();

      expect(remaining).toHaveLength(8);
      const guard = source.database.prepare("SELECT * FROM library_admin_guard").all();
      const live = [...source.values];
      const fresh = yield* source.acquire;
      expect(yield* fresh.libraryAdmin(stop)).toEqual(expected);
      source.grantPrune(authorization);
      source.pausePruneAuthorization(Effect.void);
      expect(yield* fresh.libraryAdmin(step)).toEqual(Reply.Rejected({ reason: "fenced" }));
      expect(
        source.database.prepare("SELECT * FROM library_admin_rows WHERE id='capture'").all(),
      ).toEqual(remaining);
      expect(source.database.prepare("SELECT * FROM library_admin_guard").all()).toEqual(guard);
      expect([...source.values]).toEqual(live);
    }),
);

it.effect(
  "stop-only authority binds exact source and first stopping time without creating a deletion receipt",
  () =>
    Effect.gen(function* () {
      const source = fixture("library-1", "frozen");
      yield* Effect.addFinalizer(() => Effect.sync(() => source.database.close()));
      source.values.set("receipt:stable", { reply: "preserved" });
      const admin = yield* source.acquire;

      const authorization = LibraryCapturePruneStopAuthorization.make({
        ...pruneGrant({ digest: "c".repeat(64), kvCount: 1, sqlCount: 1 }),
        stoppingAt: 90 * 86400000,
      });

      const stop = Request.StopPrune({ pruneId: "prune", captureId: "capture" });
      expect(yield* admin.libraryAdmin(stop)).toEqual(Reply.Rejected({ reason: "conflict" }));
      source.grantPruneStop({ ...authorization, ordinal: 2 });
      expect(yield* admin.libraryAdmin(stop)).toEqual(Reply.Rejected({ reason: "fenced" }));
      source.grantPruneStop({
        ...authorization,
        source: { ...authorization.source, layout: 0, nativeId: "f".repeat(64) },
      });
      expect(yield* admin.libraryAdmin(stop)).toEqual(Reply.Rejected({ reason: "fenced" }));
      expect(source.database.prepare("SELECT * FROM library_admin_prune_stops").all()).toEqual([]);
      source.grantPruneStop(authorization);
      const stopped = Reply.PruneStopped({ value: { authorization } });
      expect(yield* admin.libraryAdmin(stop)).toEqual(stopped);
      source.grantPruneStop({ ...authorization, stoppingAt: authorization.stoppingAt + 1 });
      expect(yield* admin.libraryAdmin(stop)).toEqual(Reply.Rejected({ reason: "conflict" }));
      expect(source.database.prepare("SELECT * FROM library_admin_prunes").all()).toEqual([]);
      expect(source.database.prepare("SELECT * FROM library_admin_images").all()).toEqual([]);
      expect(source.values.get("receipt:stable")).toEqual({ reply: "preserved" });
    }),
);

it.effect(
  "completed capture followed by restart establishes a fresh freeze for the next operation",
  () =>
    Effect.gen(function* () {
      const source = fixture("library-1", "frozen");
      yield* Effect.addFinalizer(() => Effect.sync(() => source.database.close()));
      source.captureOnly();
      const first = yield* source.acquire;
      const frozen = yield* first.libraryAdmin(Request.Freeze({ operationId: "capture" }));

      if (!Predicate.isTagged(frozen, "Status") || frozen.value.before === null)
        return yield* Effect.die("missing first freeze proof");

      const originalBefore = frozen.value.before;
      const frozenConstructor = yield* source.acquire;
      yield* capture(frozenConstructor);
      source.resumeCapture();

      const resumed = yield* frozenConstructor.libraryAdmin(
        Request.ResumeCapture({ operationId: "capture" }),
      );

      if (!Predicate.isTagged(resumed, "Status") || resumed.value.resuming === null)
        return yield* Effect.die("missing resume proof");

      const resumedConstructor = yield* source.acquire;
      yield* resumedConstructor.afterInitialize(new Set());

      const verifiedResumed = yield* resumedConstructor.libraryAdmin(
        Request.VerifyResumed({ operationId: "capture", before: resumed.value.resuming }),
      );

      expect(verifiedResumed._tag).toBe("Status");
      source.completeCapture();
      const completed = yield* source.acquire;
      expect(completed.allowed).toBe(true);
      expect(yield* completed.libraryAdmin(Request.Status())).toMatchObject({
        value: { mode: "active", held: false, before: originalBefore },
      });
      source.beginRecovery("restore-next");
      const next = yield* source.acquire;
      expect(next.allowed).toBe(false);
      const nextFreeze = yield* next.libraryAdmin(Request.Freeze({ operationId: "restore-next" }));
      expect(nextFreeze._tag).toBe("Status");

      if (!Predicate.isTagged(nextFreeze, "Status") || nextFreeze.value.before === null)
        return yield* Effect.die("missing new freeze proof");

      expect(nextFreeze.value).toMatchObject({
        mode: "frozen",
        held: true,
        initialized: false,
        resuming: null,
        before: nextFreeze.value.nonce,
      });
      expect(nextFreeze.value.before).not.toBe(originalBefore);
      const fresh = yield* source.acquire;
      expect(
        yield* fresh.libraryAdmin(
          Request.VerifyFrozen({ operationId: "restore-next", before: nextFreeze.value.before }),
        ),
      ).toMatchObject({ value: { before: nextFreeze.value.before, held: true } });
    }),
);

it.effect(
  "constructor hold preserves a genuine freeze proof and refuses a different operation",
  () =>
    Effect.gen(function* () {
      const source = fixture("library-1", "frozen");
      yield* Effect.addFinalizer(() => Effect.sync(() => source.database.close()));
      source.completeCapture();
      yield* source.storage.prepareScheduler;
      const live = yield* source.acquire;
      expect(live.allowed).toBe(true);
      source.beginRecovery("capture");
      const frozen = yield* live.libraryAdmin(Request.Freeze({ operationId: "capture" }));

      if (!Predicate.isTagged(frozen, "Status") || frozen.value.before === null)
        return yield* Effect.die("missing live freeze proof");

      expect(frozen.value).toMatchObject({ mode: "frozen", held: false });
      const before = frozen.value.before;
      const held = yield* source.acquire;
      expect(
        yield* held.libraryAdmin(Request.VerifyFrozen({ operationId: "capture", before })),
      ).toMatchObject({ value: { before, mode: "frozen", held: true } });
      source.beginRecovery("different");
      expect(yield* held.libraryAdmin(Request.Freeze({ operationId: "different" }))).toEqual(
        Reply.Rejected({ reason: "conflict" }),
      );
      const again = yield* source.acquire;
      expect(yield* again.libraryAdmin(Request.Freeze({ operationId: "different" }))).toEqual(
        Reply.Rejected({ reason: "conflict" }),
      );
      expect(yield* again.libraryAdmin(Request.Status())).toMatchObject({
        value: { before, mode: "frozen", held: true },
      });
    }),
);

it.effect(
  "capture resume restores scheduler work and requires a fresh initialized constructor",
  () =>
    Effect.gen(function* () {
      const source = fixture("library-1", "frozen");
      yield* Effect.addFinalizer(() => Effect.sync(() => source.database.close()));
      source.captureOnly();
      source.values.set("receipt:command", { result: "retained" });
      source.values.set("outbox:0001", { body: "pending" });
      source.values.set("outbox-lease", { until: 9999999999999 });
      source.values.set("bf:q-lease", { until: 9999999999999 });
      yield* source.storage.prepareScheduler;
      source.database.exec(
        "INSERT INTO alchemy_alarm_callbacks VALUES('domain:outbox','drain','saved',12000,'{}',10000,13000,3,1,7)",
      );
      source.database.exec(
        "INSERT INTO alchemy_scheduled_events VALUES('later',14000,1000,'{\"owned\":true}')",
      );
      const frozen = yield* source.acquire;
      yield* capture(frozen);
      expect(yield* frozen.libraryAdmin(Request.ResumeCapture({ operationId: "capture" }))).toEqual(
        Reply.Rejected({ reason: "fenced" }),
      );
      source.resumeCapture();
      const resumed = yield* frozen.libraryAdmin(Request.ResumeCapture({ operationId: "capture" }));
      expect(resumed._tag).toBe("Status");

      if (!Predicate.isTagged(resumed, "Status") || resumed.value.resuming === null)
        return yield* Effect.die("missing resume token");

      const before = resumed.value.resuming;
      expect(resumed.value).toMatchObject({
        initialized: false,
        held: false,
        mode: "active",
        nonce: before,
      });
      expect(
        yield* frozen.libraryAdmin(Request.VerifyResumed({ operationId: "capture", before })),
      ).toEqual(Reply.Rejected({ reason: "fenced" }));
      expect(yield* frozen.libraryAdmin(Request.Activate({ operationId: "capture" }))).toEqual(
        Reply.Rejected({ reason: "fenced" }),
      );
      expect(yield* frozen.libraryAdmin(Request.Evict({ operationId: "capture" }))).toEqual(
        Reply.Acknowledged(),
      );
      const fresh = yield* source.acquire;
      expect(fresh.allowed).toBe(true);
      expect(
        yield* fresh.libraryAdmin(Request.VerifyResumed({ operationId: "capture", before })),
      ).toEqual(Reply.Rejected({ reason: "fenced" }));
      yield* fresh.afterInitialize(new Set(["domain:outbox"]));
      const retry = yield* fresh.libraryAdmin(Request.ResumeCapture({ operationId: "capture" }));
      expect(retry._tag).toBe("Status");

      if (!Predicate.isTagged(retry, "Status")) return yield* Effect.die(retry);

      expect(retry.value).toMatchObject({ resuming: before, initialized: true });

      const verified = yield* fresh.libraryAdmin(
        Request.VerifyResumed({ operationId: "capture", before }),
      );

      expect(verified._tag).toBe("Status");

      if (!Predicate.isTagged(verified, "Status")) return yield* Effect.die(verified);
      expect(verified.value).toMatchObject({ initialized: true, resuming: before });
      expect(verified.value.nonce).not.toBe(before);
      expect(yield* source.storage.alarm).toBe(10000);
      expect(source.values.get("receipt:command")).toEqual({ result: "retained" });
      expect(source.values.has("outbox-lease")).toBe(false);
      expect(source.values.has("bf:q-lease")).toBe(false);
      expect(source.database.prepare("SELECT * FROM alchemy_alarm_callbacks").all()).toEqual([
        {
          callback: "domain:outbox",
          id: "drain",
          version: "saved",
          run_at: 12000,
          payload: "{}",
          scheduled_at: 10000,
          retry_at: 13000,
          attempts: 3,
          parked: 1,
          progress: 7,
        },
      ]);
      expect(source.database.prepare("SELECT * FROM alchemy_scheduled_events").all()).toEqual([
        {
          id: "later",
          run_at: 14000,
          repeat_ms: 1000,
          payload: '{"owned":true}',
        },
      ]);
      expect(
        source.database
          .prepare("SELECT COUNT(*) AS count FROM library_admin_hold_alchemy_alarm_callbacks")
          .get(),
      ).toEqual({ count: 0 });
    }),
);

it.effect("only exact export grants read immutable captured rows after live service resumes", () =>
  Effect.gen(function* () {
    const source = fixture("library-1", "frozen");
    yield* Effect.addFinalizer(() => Effect.sync(() => source.database.close()));
    source.captureOnly();
    source.values.set("receipt:command", { result: "original" });
    const frozen = yield* source.acquire;
    const image = yield* capture(frozen);

    const read = Request.ReadPart({
      operationId: "capture",
      captureId: "capture",
      row: 2,
      part: 0,
    });

    const original = yield* frozen.libraryAdmin(read);
    expect(original._tag).toBe("Part");
    source.resumeCapture();
    const resumed = yield* frozen.libraryAdmin(Request.ResumeCapture({ operationId: "capture" }));
    expect(resumed._tag).toBe("Status");
    const fresh = yield* source.acquire;
    yield* fresh.afterInitialize(new Set());
    source.completeCapture();
    source.values.set("receipt:command", { result: "changed live value" });

    const request = Request.ExportPart({
      grantId: "upload",
      captureId: "capture",
      row: 2,
      part: 0,
    });

    expect(yield* fresh.libraryAdmin(request)).toEqual(Reply.Rejected({ reason: "conflict" }));
    expect(yield* fresh.libraryAdmin(read)).toEqual(Reply.Rejected({ reason: "fenced" }));
    const identity = source.inspection().identity;

    if (identity === null) return yield* Effect.die("fixture identity");

    const authorization = LibraryExportAuthorization.make({
      captureId: "capture",
      ordinal: identity.ordinal,
      source: identity,
      image,
    });

    source.grantExport(authorization);
    expect(yield* fresh.libraryAdmin(request)).toEqual(original);
    source.grantExport({ ...authorization, ordinal: 2 });
    expect(yield* fresh.libraryAdmin(request)).toEqual(Reply.Rejected({ reason: "fenced" }));
    source.grantExport({
      ...authorization,
      source: { ...identity, className: "LibraryModel.DomainDirectory" },
    });
    expect(yield* fresh.libraryAdmin(request)).toEqual(Reply.Rejected({ reason: "fenced" }));
    source.grantExport({ ...authorization, source: { ...identity, nativeId: "b".repeat(64) } });
    expect(yield* fresh.libraryAdmin(request)).toEqual(Reply.Rejected({ reason: "fenced" }));
    source.grantExport({ ...authorization, captureId: "unselected" });
    expect(yield* fresh.libraryAdmin(request)).toEqual(Reply.Rejected({ reason: "fenced" }));
    source.grantExport({ ...authorization, image: { ...image, digest: "0".repeat(64) } });
    expect(yield* fresh.libraryAdmin(request)).toEqual(Reply.Rejected({ reason: "conflict" }));
    source.grantExport(authorization);
    expect(yield* fresh.libraryAdmin({ ...request, row: 99 })).toEqual(
      Reply.Rejected({ reason: "invalid" }),
    );
    const restarted = yield* source.acquire;
    yield* restarted.afterInitialize(new Set());
    expect(yield* restarted.libraryAdmin(request)).toEqual(original);
    expect(source.values.get("receipt:command")).toEqual({ result: "changed live value" });
  }),
);

it.effect("initialization alone cannot replace a distinct resume constructor", () =>
  Effect.gen(function* () {
    const source = fixture("library-1", "frozen");
    yield* Effect.addFinalizer(() => Effect.sync(() => source.database.close()));
    source.captureOnly();
    const admin = yield* source.acquire;
    yield* capture(admin);
    source.resumeCapture();
    const resumed = yield* admin.libraryAdmin(Request.ResumeCapture({ operationId: "capture" }));

    if (!Predicate.isTagged(resumed, "Status") || resumed.value.resuming === null)
      return yield* Effect.die("missing resume token");

    const before = resumed.value.resuming;
    // Exercise the admin boundary even if a host incorrectly initializes the same constructor.
    yield* admin.afterInitialize(new Set());
    expect(
      yield* admin.libraryAdmin(Request.VerifyResumed({ operationId: "capture", before })),
    ).toEqual(Reply.Rejected({ reason: "fenced" }));
    const fresh = yield* source.acquire;
    yield* fresh.afterInitialize(new Set());

    const verified = yield* fresh.libraryAdmin(
      Request.VerifyResumed({ operationId: "capture", before }),
    );

    expect(verified._tag).toBe("Status");

    if (!Predicate.isTagged(verified, "Status")) return yield* Effect.die(verified);

    expect(verified.value.nonce).not.toBe(before);
    expect(verified.value.initialized).toBe(true);
  }),
);

it.effect(
  "frozen native rows clone losslessly; exact retries survive and activation rearms pending work",
  () =>
    Effect.gen(function* () {
      const source = fixture("library-1", "frozen");
      const target = fixture("library-2", "staging");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          source.database.close();
          target.database.close();
        }),
      );
      source.values.set("receipt:operation", { receipt: "stable", reply: { skillId: "skill-2" } });
      source.values.set("meta", { state: { highWater: 2 }, version: 3 });
      source.values.set("outbox:0001", { body: "pending 🧶" });
      source.values.set("outbox-lease", { until: 9999999999999 });
      source.values.set("outbox-seq", 1);
      const frozen = yield* source.acquire;
      expect(frozen.allowed).toBe(false);
      const image = yield* capture(frozen);
      expect(image.kvCount).toBe(5);
      expect(image.sqlCount).toBe(1);
      const destination = yield* target.acquire;
      expect(
        yield* destination.libraryAdmin(Request.BeginLoad({ operationId: "capture", image })),
      ).toEqual(Reply.Acknowledged());

      for (let row = 1; row <= image.kvCount + image.sqlCount + 1; row++) {
        const first = yield* frozen.libraryAdmin(
          Request.ReadPart({ captureId: "capture", operationId: "capture", row, part: 0 }),
        );

        if (!Predicate.isTagged(first, "Part")) return yield* Effect.die(first);

        for (let part = 0; part < first.value.parts; part++) {
          const reply = yield* frozen.libraryAdmin(
            Request.ReadPart({ captureId: "capture", operationId: "capture", row, part }),
          );

          if (!Predicate.isTagged(reply, "Part")) return yield* Effect.die(reply);
          const load = Request.LoadPart({ operationId: "capture", value: reply.value });
          expect(yield* destination.libraryAdmin(load)).toEqual(Reply.Acknowledged());
          expect(yield* destination.libraryAdmin(load)).toEqual(Reply.Acknowledged());
        }
      }

      const verified = yield* destination.libraryAdmin(
        Request.VerifyImage({ operationId: "capture", image }),
      );

      expect(verified).toEqual(Reply.Progress({ value: { done: true, image } }));
      expect(target.values).toEqual(source.values);
      target.activate();
      const active = yield* destination.libraryAdmin(Request.Activate({ operationId: "capture" }));
      expect(active._tag).toBe("Status");

      if (!Predicate.isTagged(active, "Status")) return yield* Effect.die(active);
      const activationNonce = active.value.activating;
      expect(activationNonce).toBe(active.value.nonce);

      if (activationNonce === null) return yield* Effect.die("missing activation nonce");
      expect(
        (yield* destination.libraryAdmin(Request.Activate({ operationId: "capture" })))._tag,
      ).toBe("Status");
      expect(target.values.has("outbox-lease")).toBe(false);
      const restarted = yield* target.acquire;
      expect(restarted.allowed).toBe(true);
      yield* restarted.afterInitialize(new Set(["domain:outbox"]));
      const retry = yield* restarted.libraryAdmin(Request.Activate({ operationId: "capture" }));

      if (!Predicate.isTagged(retry, "Status")) return yield* Effect.die(retry);
      expect(retry.value.activating).toBe(activationNonce);
      expect(retry.value.nonce).not.toBe(activationNonce);
      expect(
        yield* restarted.libraryAdmin(
          Request.VerifyActive({ operationId: "capture", before: retry.value.nonce }),
        ),
      ).toEqual(Reply.Rejected({ reason: "fenced" }));

      const verifiedActivation = yield* restarted.libraryAdmin(
        Request.VerifyActive({ operationId: "capture", before: activationNonce }),
      );

      expect(verifiedActivation._tag).toBe("Status");

      if (!Predicate.isTagged(verifiedActivation, "Status"))
        return yield* Effect.die(verifiedActivation);
      expect(verifiedActivation.value.initialized).toBe(true);
      expect(verifiedActivation.value.activating).toBe(activationNonce);
      expect(
        target.database.prepare("SELECT callback,id,progress FROM alchemy_alarm_callbacks").all(),
      ).toEqual([{ callback: "domain:outbox", id: "drain", progress: 1 }]);
      expect(target.values.get("receipt:operation")).toEqual({
        receipt: "stable",
        reply: { skillId: "skill-2" },
      });
    }),
);

it.effect("wrong image and oversized parts fail explicitly without advancing a staging image", () =>
  Effect.gen(function* () {
    const target = fixture("library-2", "staging");
    yield* Effect.addFinalizer(() => Effect.sync(() => target.database.close()));
    const admin = yield* target.acquire;
    const image = LibraryObjectImage.make({ digest: "b".repeat(64), kvCount: 0, sqlCount: 1 });
    expect(yield* admin.libraryAdmin(Request.BeginLoad({ operationId: "capture", image }))).toEqual(
      Reply.Acknowledged(),
    );
    expect(
      yield* admin.libraryAdmin(Request.VerifyImage({ operationId: "capture", image })),
    ).toEqual(Reply.Rejected({ reason: "conflict" }));

    const oversized = Request.LoadPart({
      operationId: "capture",
      value: {
        row: 1,
        kind: "alarm",
        key: "alarm",
        digest: "a".repeat(64),
        part: 0,
        parts: 1,
        chars: 9000,
        chunk: "x".repeat(9000),
      },
    });

    expect(yield* admin.libraryAdmin(oversized)).toEqual(Reply.Rejected({ reason: "invalid" }));
    expect([...target.values]).toEqual([]);
  }),
);

it.effect(
  "a selected retained capture is readable under a new operation without allowing old-source mutations",
  () =>
    Effect.gen(function* () {
      const source = fixture("library-1", "frozen");
      yield* Effect.addFinalizer(() => Effect.sync(() => source.database.close()));
      source.values.set("receipt:preserved", { reply: "original receipt" });
      const admin = yield* source.acquire;
      const image = yield* capture(admin);

      const request = Request.ReadPart({
        operationId: "capture",
        captureId: "capture",
        row: 2,
        part: 0,
      });

      const original = yield* admin.libraryAdmin(request);
      expect(original._tag).toBe("Part");
      source.selectRetained(image);
      expect(yield* admin.libraryAdmin({ ...request, operationId: "rollback" })).toEqual(original);
      expect(yield* admin.libraryAdmin({ ...request, operationId: "unselected" })).toEqual(
        Reply.Rejected({ reason: "conflict" }),
      );
      expect(
        yield* admin.libraryAdmin({ ...request, operationId: "rollback", captureId: "other" }),
      ).toEqual(Reply.Rejected({ reason: "conflict" }));
      expect(yield* admin.libraryAdmin(Request.CaptureStep({ operationId: "rollback" }))).toEqual(
        Reply.Rejected({ reason: "fenced" }),
      );
      expect(
        yield* admin.libraryAdmin(Request.BeginLoad({ operationId: "rollback", image })),
      ).toEqual(Reply.Rejected({ reason: "fenced" }));
      source.selectRetained({ ...image, digest: "0".repeat(64) });
      expect(yield* admin.libraryAdmin({ ...request, operationId: "rollback" })).toEqual(
        Reply.Rejected({ reason: "conflict" }),
      );
      expect(source.values.get("receipt:preserved")).toEqual({ reply: "original receipt" });
    }),
);
