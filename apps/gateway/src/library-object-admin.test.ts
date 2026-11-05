import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
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
  LibraryObjectImage,
  LibraryRecoveryState,
  RegisteredLibraryObject,
} from "./library-recovery-records.ts";
import { LibraryImageError, type LibraryNativeValue } from "./library-image.ts";

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
