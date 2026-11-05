import * as Data from "effect/Data";
import { LibraryState } from "@kitties/domain/Library/Library.state";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Struct from "effect/Struct";
import {
  LIBRARY_CAPTURE_PRUNE_BATCH_SIZE,
  LibraryCapturePruneAuthorization,
  LibraryCapturePruneProgress,
  LibraryCapturePruneReceipt,
  LibraryCapturePruneStopAuthorization,
  LibraryCapturePruneStopReceipt,
} from "./library-capture-prune-records.ts";
import {
  LibraryExportAuthorization,
  LibraryObjectRef,
  LibraryObjectImage,
  LibraryRecoveryState,
  RecoveryDigest,
  RecoveryOperationId,
  RecoveryOrdinal,
  RegisteredLibraryObject,
} from "./library-recovery-records.ts";
import {
  decodeLibraryValue,
  type LibraryNativeValue,
  encodeLibraryValue,
  LIBRARY_IMAGE_PART_CHARS,
  LIBRARY_IMAGE_RESPONSE_BYTES,
  LibraryImageError,
  libraryImageBytes,
  libraryImageDigest,
} from "./library-image.ts";

const Table = Schema.Literals([
  "alchemy_alarm_callbacks",
  "alchemy_alarm_schema",
  "alchemy_scheduled_events",
]);

const Kind = Schema.Union([Schema.Literals(["alarm", "kv"]), Table]);
const Nonce = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));
const Positive = RecoveryOrdinal.check(Schema.isGreaterThan(0));
const Key = Schema.String.check(Schema.isMaxLength(2048));

export const LibraryImagePart = Schema.Struct({
  row: Positive,
  kind: Kind,
  key: Key,
  digest: RecoveryDigest,
  part: RecoveryOrdinal.check(Schema.isLessThan(512)),
  parts: Positive.check(Schema.isLessThanOrEqualTo(512)),
  chars: Positive.check(Schema.isLessThanOrEqualTo(2 * 1024 * 1024)),
  chunk: Schema.String.check(Schema.isMaxLength(LIBRARY_IMAGE_PART_CHARS)),
});

export type LibraryImagePart = typeof LibraryImagePart.Type;

export const LibraryAdminRequest = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Status") }),
  Schema.TaggedStruct("PruneCaptureStep", {
    pruneId: RecoveryOperationId,
    captureId: RecoveryOperationId,
  }),
  Schema.TaggedStruct("StopPrune", {
    pruneId: RecoveryOperationId,
    captureId: RecoveryOperationId,
  }),
  Schema.Struct({ _tag: Schema.Literal("ReadAllocatorFloor"), operationId: RecoveryOperationId }),
  Schema.Struct({ _tag: Schema.Literal("Freeze"), operationId: RecoveryOperationId }),
  Schema.Struct({ _tag: Schema.Literal("Evict"), operationId: RecoveryOperationId }),
  Schema.Struct({
    _tag: Schema.Literal("CaptureStep"),
    operationId: RecoveryOperationId,
  }),
  Schema.Struct({ _tag: Schema.Literal("Activate"), operationId: RecoveryOperationId }),
  Schema.Struct({ _tag: Schema.Literal("ResumeCapture"), operationId: RecoveryOperationId }),
  Schema.Struct({
    _tag: Schema.Literal("VerifyResumed"),
    operationId: RecoveryOperationId,
    before: Nonce,
  }),
  Schema.Struct({
    _tag: Schema.Literal("VerifyFrozen"),
    operationId: RecoveryOperationId,
    before: Nonce,
  }),
  Schema.Struct({
    _tag: Schema.Literal("VerifyActive"),
    operationId: RecoveryOperationId,
    before: Nonce,
  }),
  Schema.Struct({
    _tag: Schema.Literal("ReadPart"),
    captureId: RecoveryOperationId,
    operationId: RecoveryOperationId,
    row: Positive,
    part: RecoveryOrdinal.check(Schema.isLessThan(512)),
  }),
  Schema.Struct({
    _tag: Schema.Literal("ExportPart"),
    grantId: RecoveryOperationId,
    captureId: RecoveryOperationId,
    row: Positive,
    part: RecoveryOrdinal.check(Schema.isLessThan(512)),
  }),
  Schema.Struct({
    _tag: Schema.Literal("BeginLoad"),
    operationId: RecoveryOperationId,
    image: LibraryObjectImage,
  }),
  Schema.Struct({
    _tag: Schema.Literal("VerifyImage"),
    operationId: RecoveryOperationId,
    image: LibraryObjectImage,
  }),
  Schema.Struct({
    _tag: Schema.Literal("LoadPart"),
    operationId: RecoveryOperationId,
    value: LibraryImagePart,
  }),
]);

export type LibraryAdminRequest = typeof LibraryAdminRequest.Type;

const Guard = Schema.Struct({
  mode: Schema.Literals(["active", "frozen"]),
  operationId: Schema.NullOr(RecoveryOperationId),
  before: Schema.NullOr(Nonce),
  held: Schema.Boolean,
  alarm: Schema.NullOr(RecoveryOrdinal),
  verified: Schema.NullOr(RecoveryDigest),
  activating: Schema.NullOr(Nonce),
  resuming: Schema.optionalKey(Schema.NullOr(Nonce)),
});

type Guard = typeof Guard.Type;

const Journal = Schema.Struct({
  mode: Schema.Literals(["capture", "load"]),
  stage: RecoveryOrdinal.check(Schema.isLessThanOrEqualTo(5)),
  after: Schema.NullOr(Schema.String),
  row: RecoveryOrdinal,
  kvCount: RecoveryOrdinal,
  sqlCount: RecoveryOrdinal,
  digest: RecoveryDigest,
  expected: Schema.NullOr(LibraryObjectImage),
  verified: Schema.Boolean,
});

type Journal = typeof Journal.Type;

export type LibrarySqlRow = typeof LibrarySqlRow.Type;

const StoredRow = Schema.Struct({
  kind: Kind,
  key: Key,
  digest: RecoveryDigest,
  body: Schema.String,
});

const TextRow = Schema.Struct({ body: Schema.String });

export const LibrarySqlRow = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Number, Schema.Null]),
);

const CallbackRow = Schema.Struct({
  callback: Schema.String,
  id: Schema.String,
  version: Schema.String,
  run_at: Schema.Number,
  payload: Schema.String,
  scheduled_at: Schema.Number,
  retry_at: Schema.NullOr(Schema.Number),
  attempts: RecoveryOrdinal,
  parked: Schema.Literals([0, 1]),
  progress: Schema.Int,
});

const AlarmSchemaRow = Schema.Struct({ id: Schema.Literal(1), version: Schema.Literal(2) });

const ScheduledRow = Schema.Struct({
  id: Schema.String,
  run_at: Schema.Number,
  repeat_ms: Schema.NullOr(Schema.Number),
  payload: Schema.String,
});

export const LibraryAdminStatus = Schema.Struct({
  nonce: Nonce,
  activating: Schema.NullOr(Nonce),
  resuming: Schema.NullOr(Nonce),
  before: Schema.NullOr(Nonce),
  initialized: Schema.Boolean,
  outboxPending: Schema.Boolean,
  outboxWake: Schema.Boolean,
  backfillPending: Schema.Boolean,
  backfillWake: Schema.Boolean,
  held: Schema.Boolean,
  mode: Guard.fields.mode,
  ordinal: Schema.NullOr(RecoveryOrdinal),
});

export const LibraryAdminProgress = Schema.Struct({
  done: Schema.Boolean,
  image: Schema.NullOr(LibraryObjectImage),
});

export const LibraryAdminReply = Schema.Union([
  Schema.TaggedStruct("PruneStopped", { value: LibraryCapturePruneStopReceipt }),
  Schema.TaggedStruct("PruneProgress", { value: LibraryCapturePruneProgress }),
  Schema.Struct({ _tag: Schema.Literal("AllocatorFloor"), value: RecoveryOrdinal }),
  Schema.Struct({ _tag: Schema.Literal("Status"), value: LibraryAdminStatus }),
  Schema.Struct({ _tag: Schema.Literal("Progress"), value: LibraryAdminProgress }),
  Schema.Struct({ _tag: Schema.Literal("Part"), value: LibraryImagePart }),
  Schema.Struct({ _tag: Schema.Literal("Acknowledged") }),
  Schema.Struct({
    _tag: Schema.Literal("Rejected"),
    reason: Schema.Literals([
      "invalid",
      "unsupported",
      "limit",
      "conflict",
      "incomplete",
      "storage",
      "fenced",
    ]),
  }),
]);

export type LibraryAdminReply = typeof LibraryAdminReply.Type;

const Reply = Data.taggedEnum<LibraryAdminReply>();

/** Native storage port; the adapter supplies first-party scheduler schema preparation. */
export interface LibraryObjectStorage {
  readonly sql: {
    readonly exec: (
      statement: string,
      ...bindings: ReadonlyArray<string | number | null>
    ) => { readonly toArray: () => ReadonlyArray<LibrarySqlRow> };
  };
  readonly kv: {
    readonly get: (key: string) => LibraryNativeValue;
    readonly put: (key: string, value: LibraryNativeValue) => void;
    readonly delete: (key: string) => boolean;
    readonly list: (options: {
      readonly limit: number;
      readonly prefix?: string;
      readonly startAfter?: string;
    }) => Iterable<[string, LibraryNativeValue]>;
  };
  readonly transaction: <A>(body: () => A) => A;
  readonly prepareScheduler: Effect.Effect<void>;
  readonly alarm: Effect.Effect<number | null, LibraryImageError>;
  readonly clearAlarm: Effect.Effect<void, LibraryImageError>;
  readonly setAlarm: (at: number) => Effect.Effect<void, LibraryImageError>;
}

export interface LibraryObjectEnvironment {
  readonly storage: LibraryObjectStorage;
  readonly identity: RegisteredLibraryObject | null;
  readonly recovery: LibraryRecoveryState | null;
  readonly refresh: Effect.Effect<LibraryObjectInspection>;
  readonly authorizeCapture: (
    operationId: string,
    captureId: string,
  ) => Effect.Effect<LibraryObjectImage, LibraryImageError>;
  /** Absent until the host wires the control journal's immutable-set grant. */
  readonly authorizeExport?: (
    grantId: string,
    captureId: string,
  ) => Effect.Effect<LibraryExportAuthorization, LibraryImageError>;
  readonly authorizePrune?: (
    pruneId: string,
    captureId: string,
  ) => Effect.Effect<LibraryCapturePruneAuthorization, LibraryImageError>;
  readonly authorizePruneStop?: (
    pruneId: string,
    captureId: string,
  ) => Effect.Effect<LibraryCapturePruneStopAuthorization, LibraryImageError>;
  readonly closeSockets: () => void;
  readonly evict: () => void;
}

export interface LibraryObjectInspection {
  readonly identity: RegisteredLibraryObject | null;
  readonly recovery: LibraryRecoveryState | null;
}

const tables = Table.literals;
const seed = "kitties-library-image-v1";

const LocalPrune = Schema.Struct({
  authorization: LibraryCapturePruneAuthorization,
  stage: Schema.Literals([0, 1, 2, 3]),
  removedRows: RecoveryOrdinal,
});

const fail = (reason: LibraryImageError["reason"]): never => {
  throw new LibraryImageError({ reason });
};

/** Local administrative state never belongs to the copied first-party authority image. */
const makeLibraryObjectAdmin = (environment: LibraryObjectEnvironment) =>
  Effect.gen(function* () {
    const { storage } = environment;
    let identity = environment.identity;
    let recovery = environment.recovery;
    const sql = storage.sql;
    const lock = yield* Semaphore.make(1);
    const nonce = yield* Effect.sync(() => crypto.randomUUID());
    let initialized = false;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS library_admin_guard (id INTEGER PRIMARY KEY,body TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS library_admin_images (id TEXT PRIMARY KEY,body TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS library_admin_rows (id TEXT NOT NULL,row_number INTEGER NOT NULL,kind TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,row_number))",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS library_admin_parts (id TEXT NOT NULL,row_number INTEGER NOT NULL,part INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,row_number,part))",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS library_admin_prunes (id TEXT PRIMARY KEY,capture_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS library_admin_prune_stops (id TEXT PRIMARY KEY,capture_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL)",
    );

    const read = <S extends Schema.ConstraintDecoder<unknown>>(
      schema: S,
      statement: string,
      ...bindings: ReadonlyArray<string | number | null>
    ): S["Type"] | undefined => {
      const value = sql.exec(statement, ...bindings).toArray()[0];

      return value === undefined ? undefined : Schema.decodeUnknownSync(schema)(value);
    };

    const record = <S extends Schema.ConstraintDecoder<unknown>>(
      schema: S,
      statement: string,
      ...bindings: ReadonlyArray<string | number | null>
    ): S["Type"] | undefined => {
      const value = read(TextRow, statement, ...bindings);

      return value === undefined
        ? undefined
        : Schema.decodeUnknownSync(Schema.fromJsonString(schema))(value.body);
    };

    const guard = (): Guard =>
      record(Guard, "SELECT body FROM library_admin_guard WHERE id=1") ?? fail("storage");

    const saveGuard = (value: Guard) => {
      sql.exec("INSERT OR REPLACE INTO library_admin_guard VALUES (1,?)", JSON.stringify(value));
    };

    const journal = (id: string) =>
      record(Journal, "SELECT body FROM library_admin_images WHERE id=?", id);

    const saveJournal = (id: string, value: Journal) => {
      sql.exec(
        "INSERT OR REPLACE INTO library_admin_images VALUES (?,?)",
        id,
        JSON.stringify(value),
      );
    };

    if (record(Guard, "SELECT body FROM library_admin_guard WHERE id=1") === undefined)
      saveGuard({
        mode: identity?.phase === "active" || identity?.phase === "importing" ? "active" : "frozen",
        operationId: recovery?.operationId ?? null,
        before: null,
        held: false,
        alarm: null,
        verified: null,
        activating: null,
      });

    const allowed =
      identity !== null &&
      (identity.phase === "active" ||
        identity.phase === "importing" ||
        (identity.phase === "activating" &&
          recovery?.operationKind !== "capture" &&
          guard().verified !== null &&
          guard().activating !== null &&
          recovery?.operationId === guard().operationId) ||
        (identity.phase === "resuming" &&
          recovery?.operationKind === "capture" &&
          recovery.phase === "resuming" &&
          recovery.lineage === identity.lineage &&
          recovery.operationId === guard().operationId &&
          guard().verified !== null &&
          guard().resuming != null)) &&
      guard().mode === "active";

    const hold = Effect.gen(function* () {
      if (guard().held) {
        yield* storage.clearAlarm;

        return;
      }

      environment.closeSockets();
      yield* storage.prepareScheduler;
      const alarm = yield* storage.alarm;
      storage.transaction(() => {
        for (const table of tables) {
          sql.exec(
            `CREATE TABLE IF NOT EXISTS library_admin_hold_${table} AS SELECT * FROM ${table} WHERE 0`,
          );
          sql.exec(`DELETE FROM library_admin_hold_${table}`);
          sql.exec(`INSERT INTO library_admin_hold_${table} SELECT * FROM ${table}`);

          if (table !== "alchemy_alarm_schema") sql.exec(`DELETE FROM ${table}`);
        }

        const current = guard();

        saveGuard({
          ...current,
          // Active service has outlived its old freeze proof. An already frozen
          // guard must retain its original proof across constructor holds.
          before: current.mode === "active" ? null : current.before,
          mode: "frozen",
          held: true,
          alarm,
        });
      });
      yield* storage.clearAlarm;
    });

    if (!allowed) yield* hold;

    const status = () => ({
      nonce,
      activating: guard().activating,
      resuming: guard().resuming ?? null,
      before: guard().before,
      initialized,
      outboxPending: [...storage.kv.list({ prefix: "outbox:", limit: 1 })].length > 0,
      outboxWake:
        sql
          .exec(
            `SELECT 1 FROM ${guard().held ? "library_admin_hold_" : ""}alchemy_alarm_callbacks WHERE callback='domain:outbox' AND id='drain' LIMIT 1`,
          )
          .toArray().length > 0,
      backfillPending: [...storage.kv.list({ prefix: "bf:job:", limit: 1 })].length > 0,
      backfillWake:
        sql
          .exec(
            `SELECT 1 FROM ${guard().held ? "library_admin_hold_" : ""}alchemy_alarm_callbacks WHERE callback='domain:backfill' AND id='tick' LIMIT 1`,
          )
          .toArray().length > 0,
      held: guard().held,
      mode: guard().mode,
      ordinal: identity?.ordinal ?? null,
    });

    const own = (operationId: string) => {
      if (
        identity === null ||
        recovery?.operationId !== operationId ||
        recovery.phase === "ready" ||
        recovery.phase === "importing"
      )
        return false;

      return identity.lineage === recovery.lineage || identity.lineage === recovery.stagingLineage;
    };

    const frozen = (operationId: string) =>
      own(operationId) && !initialized && guard().held && guard().mode === "frozen";

    const restoreOwned = (operationId: string) =>
      own(operationId) && recovery?.operationKind !== "capture";

    const captureOwned = (operationId: string) =>
      own(operationId) &&
      recovery?.operationKind === "capture" &&
      identity?.lineage === recovery.lineage;

    const emptyJournal = (
      digest: string,
      mode: Journal["mode"],
      expected: Journal["expected"],
    ): Journal => ({
      mode,
      stage: 0,
      after: null,
      row: 0,
      kvCount: 0,
      sqlCount: 0,
      digest,
      expected,
      verified: false,
    });

    const manifest = (value: Journal) =>
      LibraryObjectImage.make({
        digest: value.digest,
        kvCount: value.kvCount,
        sqlCount: value.sqlCount,
      });

    const sameImage = (left: LibraryObjectImage, right: LibraryObjectImage) =>
      left.digest === right.digest &&
      left.kvCount === right.kvCount &&
      left.sqlCount === right.sqlCount;

    const readCapturedPart = (
      captureId: string,
      rowNumber: number,
      partNumber: number,
      expected: LibraryObjectImage | null,
    ) => {
      const value = journal(captureId);

      if (value?.stage !== 5 || value.mode !== "capture") return fail("incomplete");

      if (expected !== null && !sameImage(manifest(value), expected)) return fail("conflict");

      const row =
        read(
          StoredRow,
          "SELECT kind,key,digest,body FROM library_admin_rows WHERE id=? AND row_number=?",
          captureId,
          rowNumber,
        ) ?? fail("invalid");

      const parts = Math.ceil(row.body.length / LIBRARY_IMAGE_PART_CHARS);

      if (partNumber >= parts) return fail("invalid");

      const result = Reply.Part({
        value: LibraryImagePart.make({
          row: rowNumber,
          kind: row.kind,
          key: row.key,
          digest: row.digest,
          part: partNumber,
          parts,
          chars: row.body.length,
          chunk: row.body.slice(
            partNumber * LIBRARY_IMAGE_PART_CHARS,
            (partNumber + 1) * LIBRARY_IMAGE_PART_CHARS,
          ),
        }),
      });

      if (libraryImageBytes(JSON.stringify(result)) > LIBRARY_IMAGE_RESPONSE_BYTES)
        return fail("limit");

      return result;
    };

    const releaseHeld = () => {
      storage.kv.delete("outbox-lease");
      storage.kv.delete("bf:q-lease");

      for (const table of tables) {
        sql.exec(`DELETE FROM ${table}`);
        sql.exec(`INSERT INTO ${table} SELECT * FROM library_admin_hold_${table}`);
        sql.exec(`DELETE FROM library_admin_hold_${table}`);
      }
    };

    const append = (
      id: string,
      value: Journal,
      kind: typeof Kind.Type,
      key: string,
      body: string,
      cursor: Pick<Journal, "stage" | "after">,
    ) =>
      Effect.gen(function* () {
        const digest = yield* libraryImageDigest(body);
        const chain = yield* libraryImageDigest(`${value.digest}\n${kind}\n${key}\n${digest}`);

        const next: Journal = {
          ...value,
          ...cursor,
          row: value.row + 1,
          kvCount: value.kvCount + (kind === "kv" ? 1 : 0),
          sqlCount: value.sqlCount + (kind !== "kv" && kind !== "alarm" ? 1 : 0),
          digest: chain,
        };

        storage.transaction(() => {
          sql.exec(
            "INSERT INTO library_admin_rows VALUES (?,?,?,?,?,?)",
            id,
            next.row,
            kind,
            key,
            digest,
            body,
          );
          saveJournal(id, next);
        });

        return next;
      });

    const capture = (id: string) =>
      Effect.gen(function* () {
        let value = journal(id);

        if (value === undefined) {
          value = emptyJournal(yield* libraryImageDigest(seed), "capture", null);
          saveJournal(id, value);
        }

        if (value.mode !== "capture") return fail("conflict");

        for (let steps = 0; steps < 16 && value.stage < 5; steps += 1) {
          if (value.stage === 0) {
            value = yield* append(id, value, "alarm", "alarm", encodeLibraryValue(guard().alarm), {
              stage: 1,
              after: null,
            });
          } else if (value.stage === 1) {
            const entries: Iterable<[string, LibraryNativeValue]> =
              value.after === null
                ? storage.kv.list({ limit: 1 })
                : storage.kv.list({ startAfter: value.after, limit: 1 });

            const entry: [string, LibraryNativeValue] | undefined = [...entries][0];

            if (entry === undefined) value = { ...value, stage: 2, after: null };
            else {
              value = yield* append(
                id,
                value,
                "kv",
                Key.make(entry[0]),
                encodeLibraryValue(entry[1]),
                { stage: 1, after: entry[0] },
              );
            }
          } else {
            const table: typeof Table.Type = tables[value.stage - 2]!;

            const row = sql
              .exec(
                `SELECT rowid AS library_rowid,* FROM library_admin_hold_${table} WHERE rowid>? ORDER BY rowid LIMIT 1`,
                Number(value.after || 0),
              )
              .toArray()[0];

            if (row === undefined) value = { ...value, stage: value.stage + 1, after: null };
            else {
              const parsed = Schema.decodeUnknownSync(LibrarySqlRow)(row);
              const { library_rowid, ...body } = parsed;
              const ordinal = Schema.decodeUnknownSync(Positive)(library_rowid);
              value = yield* append(id, value, table, String(ordinal), encodeLibraryValue(body), {
                stage: value.stage,
                after: String(ordinal),
              });
            }
          }

          saveJournal(id, value);
        }

        return { done: value.stage === 5, image: value.stage === 5 ? manifest(value) : null };
      });

    const applyRow = (kind: typeof Kind.Type, key: string, body: string) => {
      const value = decodeLibraryValue(body);

      if (kind === "kv") {
        storage.kv.put(key, value);

        return;
      }

      if (kind === "alarm") {
        if (key !== "alarm") return fail("invalid");
        saveGuard({
          ...guard(),
          alarm: Schema.decodeUnknownSync(Schema.NullOr(RecoveryOrdinal))(value),
        });

        return;
      }

      const schema = Match.value(kind).pipe(
        Match.when("alchemy_alarm_callbacks", () => CallbackRow),
        Match.when("alchemy_alarm_schema", () => AlarmSchemaRow),
        Match.orElse(() => ScheduledRow),
      );

      const row = Schema.decodeUnknownSync(schema)(value);

      if (
        encodeLibraryValue(row) !== body ||
        !/^[1-9][0-9]*$/.test(key) ||
        !Number.isSafeInteger(Number(key))
      )
        return fail("invalid");
      const columns = Object.keys(row);
      sql.exec(
        `INSERT INTO library_admin_hold_${kind} (rowid,${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")},?)`,
        Number(key),
        ...Object.values(row),
      );
    };

    const execute = (
      request: LibraryAdminRequest,
    ): Effect.Effect<LibraryAdminReply, LibraryImageError> =>
      Match.value(request).pipe(
        Match.tag("StopPrune", (input) =>
          Effect.gen(function* () {
            if (identity === null || environment.authorizePruneStop === undefined)
              return Reply.Rejected({ reason: "fenced" });
            const source = identity;

            const authorization = yield* environment.authorizePruneStop(
              input.pruneId,
              input.captureId,
            );

            if (
              authorization.request.pruneId !== input.pruneId ||
              authorization.request.captureId !== input.captureId ||
              authorization.ordinal !== source.ordinal ||
              Struct.keys(LibraryObjectRef.fields).some(
                (key) => authorization.source[key] !== source[key],
              )
            )
              return Reply.Rejected({ reason: "fenced" });

            return storage.transaction(() => {
              const previous = record(
                LibraryCapturePruneStopReceipt,
                "SELECT body FROM library_admin_prune_stops WHERE id=?",
                input.pruneId,
              );

              const receipt = LibraryCapturePruneStopReceipt.make({ authorization });

              if (previous !== undefined) {
                if (!Schema.toEquivalence(LibraryCapturePruneStopReceipt)(previous, receipt))
                  return fail("conflict");

                return Reply.PruneStopped({ value: previous });
              }

              const progress = record(
                LocalPrune,
                "SELECT body FROM library_admin_prunes WHERE id=?",
                input.pruneId,
              );

              if (
                progress !== undefined &&
                !Schema.toEquivalence(LibraryCapturePruneAuthorization)(
                  progress.authorization,
                  authorization,
                )
              )
                return fail("conflict");
              sql.exec(
                "INSERT INTO library_admin_prune_stops VALUES (?,?,?)",
                input.pruneId,
                input.captureId,
                JSON.stringify(receipt),
              );

              return Reply.PruneStopped({ value: receipt });
            });
          }),
        ),
        Match.tag("PruneCaptureStep", (input) =>
          Effect.gen(function* () {
            if (identity === null || environment.authorizePrune === undefined)
              return Reply.Rejected({ reason: "fenced" });
            const source = identity;
            const authorization = yield* environment.authorizePrune(input.pruneId, input.captureId);

            if (
              authorization.request.pruneId !== input.pruneId ||
              authorization.request.captureId !== input.captureId ||
              authorization.ordinal !== source.ordinal ||
              Struct.keys(LibraryObjectRef.fields).some(
                (key) => authorization.source[key] !== source[key],
              )
            )
              return Reply.Rejected({ reason: "fenced" });

            return storage.transaction(() => {
              if (
                record(
                  LibraryCapturePruneStopReceipt,
                  "SELECT body FROM library_admin_prune_stops WHERE capture_id=?",
                  input.captureId,
                ) !== undefined
              )
                return Reply.Rejected({ reason: "fenced" });

              let progress = record(
                LocalPrune,
                "SELECT body FROM library_admin_prunes WHERE id=?",
                input.pruneId,
              );

              if (progress === undefined) {
                const captured = journal(input.captureId);

                if (
                  captured?.mode !== "capture" ||
                  captured.stage !== 5 ||
                  !sameImage(manifest(captured), authorization.image)
                )
                  return fail("conflict");
                progress = { authorization, stage: 0, removedRows: 0 };
                sql.exec(
                  "INSERT INTO library_admin_prunes VALUES (?,?,?)",
                  input.pruneId,
                  input.captureId,
                  JSON.stringify(progress),
                );
              } else if (
                !Schema.toEquivalence(LibraryCapturePruneAuthorization)(
                  progress.authorization,
                  authorization,
                )
              ) {
                return fail("conflict");
              }

              let remaining = LIBRARY_CAPTURE_PRUNE_BATCH_SIZE;

              for (const [stage, table, next] of [
                [0, "library_admin_parts", 1],
                [1, "library_admin_rows", 2],
                [2, "library_admin_images", 3],
              ] as const) {
                if (progress.stage !== stage || remaining === 0) continue;

                const removed = sql
                  .exec(
                    `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE id=? LIMIT ?) RETURNING rowid`,
                    input.captureId,
                    remaining,
                  )
                  .toArray().length;

                remaining -= removed;
                progress = { ...progress, removedRows: progress.removedRows + removed };

                if (
                  sql.exec(`SELECT 1 FROM ${table} WHERE id=? LIMIT 1`, input.captureId).toArray()
                    .length === 0
                )
                  progress = { ...progress, stage: next };
              }

              sql.exec(
                "UPDATE library_admin_prunes SET body=? WHERE id=?",
                JSON.stringify(progress),
                input.pruneId,
              );
              const done = progress.stage === 3;

              const receipt = done
                ? LibraryCapturePruneReceipt.make({
                    authorization: progress.authorization,
                    removedRows: progress.removedRows,
                  })
                : null;

              return Reply.PruneProgress({
                value: { done, removedRows: progress.removedRows, receipt },
              });
            });
          }),
        ),
        Match.tag("ReadAllocatorFloor", (input) =>
          Effect.sync(() => {
            if (
              !frozen(input.operationId) ||
              identity?.className !== "LibraryModel.LibraryAggregate" ||
              identity.logicalName !== "owner" ||
              guard().before === null ||
              guard().before === nonce
            )
              return Reply.Rejected({ reason: "fenced" });
            const raw = storage.kv.get("meta");

            if (raw === undefined) return fail("incomplete");

            const meta = Schema.decodeUnknownSync(
              Schema.Struct({ state: LibraryState, version: RecoveryOrdinal }),
            )(raw);

            return Reply.AllocatorFloor({ value: meta.state.highWater });
          }),
        ),
        Match.tag("Status", () => Effect.succeed(Reply.Status({ value: status() }))),
        Match.tag("Freeze", (input) =>
          Effect.sync(() => {
            if (!own(input.operationId) || identity?.lineage !== recovery?.lineage)
              return Reply.Rejected({ reason: "fenced" });
            environment.closeSockets();
            const current = guard();

            if (
              current.mode === "frozen" &&
              current.before !== null &&
              current.operationId !== input.operationId
            )
              return fail("conflict");
            storage.transaction(() =>
              saveGuard({
                ...current,
                mode: "frozen",
                operationId: input.operationId,
                before:
                  current.operationId === input.operationId ? (current.before ?? nonce) : nonce,
                resuming:
                  current.operationId === input.operationId ? (current.resuming ?? null) : null,
              }),
            );

            return Reply.Status({ value: status() });
          }),
        ),
        Match.tag("Evict", (input) =>
          Effect.sync(() => {
            if (
              !own(input.operationId) ||
              guard().operationId !== input.operationId ||
              (guard().mode !== "frozen" &&
                guard().activating === null &&
                !(captureOwned(input.operationId) && guard().resuming != null))
            )
              return Reply.Rejected({ reason: "fenced" });
            environment.evict();

            return Reply.Acknowledged();
          }),
        ),
        Match.tag("VerifyFrozen", (input) =>
          Effect.suspend<LibraryAdminReply, LibraryImageError, never>(() => {
            if (
              !frozen(input.operationId) ||
              guard().before !== input.before ||
              nonce === input.before
            )
              return Effect.succeed(Reply.Rejected({ reason: "fenced" }));

            return Effect.succeed(Reply.Status({ value: status() }));
          }),
        ),
        Match.tag("CaptureStep", (input) =>
          frozen(input.operationId)
            ? capture(input.operationId).pipe(Effect.map((value) => Reply.Progress({ value })))
            : Effect.succeed(Reply.Rejected({ reason: "fenced" })),
        ),
        Match.tag("ReadPart", (input) =>
          Effect.gen(function* () {
            if (
              initialized ||
              !guard().held ||
              guard().mode !== "frozen" ||
              identity === null ||
              (identity.phase !== "frozen" && identity.phase !== "retired")
            )
              return Reply.Rejected({ reason: "fenced" });

            const authorized =
              frozen(input.operationId) && input.captureId === input.operationId
                ? null
                : yield* environment.authorizeCapture(input.operationId, input.captureId);

            return readCapturedPart(input.captureId, input.row, input.part, authorized);
          }),
        ),
        Match.tag("ExportPart", (input) =>
          Effect.gen(function* () {
            if (identity === null || environment.authorizeExport === undefined)
              return Reply.Rejected({ reason: "fenced" });

            const source = identity;
            const authorized = yield* environment.authorizeExport(input.grantId, input.captureId);

            if (
              authorized.captureId !== input.captureId ||
              authorized.ordinal !== source.ordinal ||
              Struct.keys(LibraryObjectRef.fields).some(
                (key) => authorized.source[key] !== source[key],
              )
            )
              return Reply.Rejected({ reason: "fenced" });

            return readCapturedPart(input.captureId, input.row, input.part, authorized.image);
          }),
        ),
        Match.tag("BeginLoad", (input) =>
          Effect.gen(function* () {
            if (
              !restoreOwned(input.operationId) ||
              !frozen(input.operationId) ||
              identity?.phase !== "staging"
            )
              return Reply.Rejected({ reason: "fenced" });
            const previous = journal(input.operationId);

            if (previous !== undefined) {
              if (
                previous.mode !== "load" ||
                previous.expected === null ||
                !sameImage(previous.expected, input.image)
              )
                return fail("conflict");

              return Reply.Acknowledged();
            }

            if ([...storage.kv.list({ limit: 1 })].length !== 0) return fail("conflict");
            const digest = yield* libraryImageDigest(seed);
            storage.transaction(() => {
              for (const table of tables) sql.exec(`DELETE FROM library_admin_hold_${table}`);
              saveJournal(input.operationId, emptyJournal(digest, "load", input.image));
            });

            return Reply.Acknowledged();
          }),
        ),
        Match.tag("LoadPart", (input) =>
          Effect.gen(function* () {
            if (
              !restoreOwned(input.operationId) ||
              !frozen(input.operationId) ||
              identity?.phase !== "staging"
            )
              return Reply.Rejected({ reason: "fenced" });
            const value = journal(input.operationId) ?? fail("incomplete");

            if (value.mode !== "load" || value.expected === null) return fail("conflict");
            const part = input.value;

            if (
              part.part >= part.parts ||
              part.parts !== Math.ceil(part.chars / LIBRARY_IMAGE_PART_CHARS) ||
              part.chunk.length !==
                Math.min(
                  LIBRARY_IMAGE_PART_CHARS,
                  part.chars - part.part * LIBRARY_IMAGE_PART_CHARS,
                ) ||
              libraryImageBytes(JSON.stringify(part)) > LIBRARY_IMAGE_RESPONSE_BYTES
            )
              return fail("invalid");

            const previous = read(
              TextRow,
              "SELECT body FROM library_admin_parts WHERE id=? AND row_number=? AND part=?",
              input.operationId,
              part.row,
              part.part,
            );

            const serialized = JSON.stringify(part);

            if (previous !== undefined) {
              if (previous.body !== serialized) return fail("conflict");

              return Reply.Acknowledged();
            }

            if (value.verified) return fail("conflict");

            if (
              part.row !== value.row + 1 ||
              part.row > value.expected.kvCount + value.expected.sqlCount + 1
            )
              return fail("incomplete");

            const count =
              read(
                Schema.Struct({ count: RecoveryOrdinal }),
                "SELECT COUNT(*) AS count FROM library_admin_parts WHERE id=? AND row_number=?",
                input.operationId,
                part.row,
              )?.count ?? fail("storage");

            if (part.part !== count) return fail("incomplete");

            const earlier = sql
              .exec(
                "SELECT body FROM library_admin_parts WHERE id=? AND row_number=? ORDER BY part LIMIT 512",
                input.operationId,
                part.row,
              )
              .toArray()
              .map((row) =>
                Schema.decodeUnknownSync(Schema.fromJsonString(LibraryImagePart))(
                  Schema.decodeUnknownSync(TextRow)(row).body,
                ),
              );

            if (
              earlier.some(
                (entry) =>
                  entry.kind !== part.kind ||
                  entry.key !== part.key ||
                  entry.digest !== part.digest ||
                  entry.parts !== part.parts ||
                  entry.chars !== part.chars,
              )
            )
              return fail("conflict");

            if (part.part + 1 !== part.parts) {
              sql.exec(
                "INSERT INTO library_admin_parts VALUES (?,?,?,?)",
                input.operationId,
                part.row,
                part.part,
                serialized,
              );

              return Reply.Acknowledged();
            }

            const body = earlier.map((entry) => entry.chunk).join("") + part.chunk;

            if ((yield* libraryImageDigest(body)) !== part.digest) return fail("conflict");

            const digest = yield* libraryImageDigest(
              `${value.digest}\n${part.kind}\n${part.key}\n${part.digest}`,
            );

            const next: Journal = {
              ...value,
              row: part.row,
              kvCount: value.kvCount + (part.kind === "kv" ? 1 : 0),
              sqlCount: value.sqlCount + (part.kind !== "kv" && part.kind !== "alarm" ? 1 : 0),
              digest,
            };

            storage.transaction(() => {
              applyRow(part.kind, part.key, body);
              sql.exec(
                "INSERT INTO library_admin_parts VALUES (?,?,?,?)",
                input.operationId,
                part.row,
                part.part,
                serialized,
              );
              saveJournal(input.operationId, next);
            });

            return Reply.Acknowledged();
          }),
        ),
        Match.tag("VerifyImage", (input) =>
          Effect.gen(function* () {
            if (
              !restoreOwned(input.operationId) ||
              !frozen(input.operationId) ||
              identity?.phase !== "staging"
            )
              return Reply.Rejected({ reason: "fenced" });
            const loaded = journal(input.operationId) ?? fail("incomplete");

            if (
              loaded.mode !== "load" ||
              loaded.expected === null ||
              !sameImage(loaded.expected, input.image) ||
              !sameImage(manifest(loaded), input.image) ||
              loaded.row !== loaded.kvCount + loaded.sqlCount + 1
            )
              return fail("conflict");
            const check = yield* capture(`${input.operationId}:verify`);

            if (check.done) {
              if (check.image === null || !sameImage(check.image, input.image))
                return fail("conflict");
              storage.transaction(() => {
                saveJournal(input.operationId, { ...loaded, verified: true });
                saveGuard({ ...guard(), verified: input.image.digest });
              });
            }

            return Reply.Progress({ value: check });
          }),
        ),
        Match.tag("Activate", (input) =>
          Effect.sync(() => {
            if (
              restoreOwned(input.operationId) &&
              guard().operationId === input.operationId &&
              guard().mode === "active" &&
              guard().activating !== null
            )
              return Reply.Status({ value: status() });

            if (
              !restoreOwned(input.operationId) ||
              !frozen(input.operationId) ||
              identity?.phase !== "activating" ||
              !journal(input.operationId)?.verified ||
              guard().verified === null
            )
              return Reply.Rejected({ reason: "fenced" });
            storage.transaction(() => {
              releaseHeld();

              saveGuard({ ...guard(), mode: "active", held: false, activating: nonce });
            });

            return Reply.Status({ value: status() });
          }),
        ),
        Match.tag("VerifyActive", (input) =>
          Effect.sync(() =>
            initialized &&
            guard().activating === input.before &&
            nonce !== input.before &&
            restoreOwned(input.operationId)
              ? Reply.Status({ value: status() })
              : Reply.Rejected({ reason: "fenced" }),
          ),
        ),
        Match.tag("ResumeCapture", (input) =>
          Effect.sync(() => {
            if (
              !captureOwned(input.operationId) ||
              recovery?.phase !== "resuming" ||
              identity?.phase !== "resuming" ||
              guard().operationId !== input.operationId
            )
              return Reply.Rejected({ reason: "fenced" });

            if (guard().mode === "active" && guard().resuming != null)
              return Reply.Status({ value: status() });

            if (!frozen(input.operationId)) return Reply.Rejected({ reason: "fenced" });
            const captured = journal(input.operationId);

            if (captured?.mode !== "capture" || captured.stage !== 5) return fail("incomplete");

            storage.transaction(() => {
              releaseHeld();
              saveGuard({
                ...guard(),
                mode: "active",
                held: false,
                verified: captured.digest,
                activating: null,
                resuming: nonce,
              });
            });

            return Reply.Status({ value: status() });
          }),
        ),
        Match.tag("VerifyResumed", (input) =>
          Effect.sync(() =>
            initialized &&
            captureOwned(input.operationId) &&
            recovery?.phase === "resuming" &&
            identity?.phase === "resuming" &&
            guard().operationId === input.operationId &&
            guard().mode === "active" &&
            guard().resuming === input.before &&
            nonce !== input.before
              ? Reply.Status({ value: status() })
              : Reply.Rejected({ reason: "fenced" }),
          ),
        ),
        Match.exhaustive,
      );

    const libraryAdmin = (request: LibraryAdminRequest): Effect.Effect<LibraryAdminReply> =>
      Schema.decodeUnknownEffect(LibraryAdminRequest)(request).pipe(
        Effect.mapError(() => new LibraryImageError({ reason: "invalid" })),
        Effect.tap(() =>
          environment.refresh.pipe(
            Effect.tap((value) =>
              Effect.sync(() => {
                identity = value.identity;
                recovery = value.recovery;
              }),
            ),
          ),
        ),
        Effect.flatMap((value) =>
          Effect.try({
            try: () => execute(value),
            catch: (cause) =>
              Schema.is(LibraryImageError)(cause)
                ? cause
                : new LibraryImageError({ reason: "storage" }),
          }).pipe(Effect.flatten),
        ),
        Effect.catchTag("LibraryImageError", (error) =>
          Effect.succeed(Reply.Rejected({ reason: error.reason })),
        ),
        Effect.catchCause((cause) => {
          const defect = cause.reasons.find(Cause.isDieReason);

          return Effect.succeed(
            Reply.Rejected({
              reason:
                defect !== undefined && Schema.is(LibraryImageError)(defect.defect)
                  ? defect.defect.reason
                  : "storage",
            }),
          );
        }),
        lock.withPermits(1),
      );

    const afterInitialize = (callbacks: ReadonlySet<string>) =>
      Effect.gen(function* () {
        yield* storage.prepareScheduler;
        const now = yield* Clock.currentTimeMillis;
        const outbox = [...storage.kv.list({ prefix: "outbox:", limit: 1 })];
        const jobs = [...storage.kv.list({ prefix: "bf:job:", limit: 1 })];
        storage.transaction(() => {
          for (const [name, id, pending, progressKey] of [
            ["domain:outbox", "drain", outbox.length > 0, "outbox-seq"],
            ["domain:backfill", "tick", jobs.length > 0, "bf:tick-progress"],
          ] as const) {
            if (
              pending &&
              sql
                .exec("SELECT 1 FROM alchemy_alarm_callbacks WHERE callback=? AND id=?", name, id)
                .toArray().length === 0
            ) {
              if (!callbacks.has(name)) return fail("incomplete");

              const progress = Schema.decodeUnknownSync(RecoveryOrdinal)(
                storage.kv.get(progressKey) ?? 0,
              );

              // Pinned beta85 scheduler v2: a fresh retry token, preserving the committed source progress.
              // Both native Domain handlers ignore their JSON payload; existing captured rows stay untouched.
              sql.exec(
                "INSERT INTO alchemy_alarm_callbacks(callback,id,version,run_at,payload,scheduled_at,retry_at,attempts,parked,progress) VALUES (?,?,?,?,?,?,NULL,0,0,?)",
                name,
                id,
                crypto.randomUUID(),
                now + 1,
                "{}",
                now + 1,
                progress,
              );
            }
          }
        });

        const next =
          read(
            Schema.Struct({ deadline: Schema.NullOr(RecoveryOrdinal) }),
            "SELECT MIN(run_at) AS deadline FROM (SELECT run_at FROM alchemy_alarm_callbacks UNION ALL SELECT run_at FROM alchemy_scheduled_events)",
          )?.deadline ?? null;

        const deadline =
          next === null
            ? guard().alarm
            : guard().alarm === null
              ? next
              : Math.min(next, guard().alarm!);

        if (deadline !== null) yield* storage.setAlarm(Math.max(now + 1, deadline));
        saveGuard({ ...guard(), alarm: null });
        initialized = true;
      });

    const beforeInvoke = Effect.suspend(() =>
      guard().mode === "active" && initialized
        ? Effect.void
        : Effect.die(new LibraryImageError({ reason: "conflict" })),
    );

    return { allowed, libraryAdmin, afterInitialize, beforeInvoke };
  });

/** Administrative owner of one native object, acquired before provider initialization. */
export class LibraryObjectAdmin extends Context.Service<
  LibraryObjectAdmin,
  Effect.Success<ReturnType<typeof makeLibraryObjectAdmin>>
>()("@kitties/gateway/LibraryObjectAdmin") {
  static readonly layer = (environment: LibraryObjectEnvironment) =>
    Layer.effect(LibraryObjectAdmin, makeLibraryObjectAdmin(environment));
}
