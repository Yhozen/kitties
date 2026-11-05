import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { LibraryControlDatabase } from "./library-recovery-store.ts";
import {
  LibraryObjectRef,
  LibraryObjectImage,
  LibraryRecoverySet,
  LibraryRecoveryState,
  RecoveryDigest,
  RecoveryOperationId,
} from "./library-recovery-records.ts";

export const LIBRARY_ARCHIVE_RETENTION_MS = 90 * 86400000;
export const LIBRARY_ARCHIVE_PAGE_SIZE = 8;

export const ArchiveNumber = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);

export class LibraryArchiveError extends Schema.TaggedError<
  LibraryArchiveError,
  { readonly brand: unique symbol }
>()("LibraryArchiveError", {
  reason: Schema.Literals([
    "invalid",
    "conflict",
    "incomplete",
    "expired",
    "limit",
    "storage",
    "timeout",
  ]),
}) {}

export const LibraryArchiveHeader = Schema.Struct({
  archiveId: RecoveryOperationId,
  grantId: RecoveryOperationId,
  set: LibraryRecoverySet,
  capturedAt: ArchiveNumber,
});

export type LibraryArchiveHeader = typeof LibraryArchiveHeader.Type;

export const LibraryArchiveUploadReceipt = Schema.Struct({
  plainSha256: RecoveryDigest,
  cipherSha256: RecoveryDigest,
  bytes: ArchiveNumber,
  uploadedAt: ArchiveNumber,
  verifiedAt: ArchiveNumber,
});

export type LibraryArchiveUploadReceipt = typeof LibraryArchiveUploadReceipt.Type;

export const LibraryArchivePartReceipt = Schema.Struct({
  ...LibraryArchiveUploadReceipt.fields,
  row: ArchiveNumber.check(Schema.isGreaterThan(0)),
  part: ArchiveNumber.check(Schema.isLessThan(512)),
  parts: ArchiveNumber.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(512)),
});

export type LibraryArchivePartReceipt = typeof LibraryArchivePartReceipt.Type;

export const LibraryArchiveObject = Schema.Struct({
  ordinal: ArchiveNumber.check(Schema.isGreaterThan(0)),
  source: LibraryObjectRef,
  image: LibraryObjectImage,
  complete: Schema.Boolean,
  partCount: ArchiveNumber,
});

export type LibraryArchiveObject = typeof LibraryArchiveObject.Type;

export const LibraryArchivePageReceipt = Schema.Struct({
  ...LibraryArchiveUploadReceipt.fields,
  page: ArchiveNumber,
  after: ArchiveNumber,
  count: ArchiveNumber.check(Schema.isLessThanOrEqualTo(LIBRARY_ARCHIVE_PAGE_SIZE)),
  previousSha256: RecoveryDigest,
});

export type LibraryArchivePageReceipt = typeof LibraryArchivePageReceipt.Type;

export const LibraryArchiveManifest = Schema.Struct({
  format: Schema.Literal("kitties-library-archive-v1"),
  header: LibraryArchiveHeader,
  objectCount: ArchiveNumber,
  partCount: ArchiveNumber,
  pageCount: ArchiveNumber,
  lastPageSha256: RecoveryDigest,
  oldestUploadedAt: ArchiveNumber,
  expiresAt: ArchiveNumber,
});

export type LibraryArchiveManifest = typeof LibraryArchiveManifest.Type;

export const LibraryArchiveCommit = Schema.Struct({
  manifest: LibraryArchiveManifest,
  receipt: LibraryArchiveUploadReceipt,
});

export type LibraryArchiveCommit = typeof LibraryArchiveCommit.Type;

export const LibraryArchiveStatus = Schema.Struct({
  header: LibraryArchiveHeader,
  phase: Schema.Literals(["uploading", "committed"]),
  objectCount: ArchiveNumber,
  completeObjects: ArchiveNumber,
  partCount: ArchiveNumber,
  pageCount: ArchiveNumber,
  oldestUploadedAt: Schema.NullOr(ArchiveNumber),
  uploadVerifiedAt: Schema.NullOr(ArchiveNumber),
  expiresAt: Schema.NullOr(ArchiveNumber),
  commit: Schema.NullOr(LibraryArchiveCommit),
});

export type LibraryArchiveStatus = typeof LibraryArchiveStatus.Type;

export const LibraryArchivePin = Schema.Struct({
  id: RecoveryOperationId,
  archiveId: RecoveryOperationId,
  kind: Schema.Literals(["upload", "restore"]),
  completed: Schema.Boolean,
});

export type LibraryArchivePin = typeof LibraryArchivePin.Type;

const Body = Schema.Struct({ body: Schema.String });
const Count = Schema.Struct({ count: ArchiveNumber });
const Time = Schema.Struct({ at: Schema.NullOr(ArchiveNumber) });
const same = <A>(left: A, right: A) => JSON.stringify(left) === JSON.stringify(right);
const ZERO = "0".repeat(64);

// RecoveryDO owns these immutable proofs. Historical operation rows omit kind
// and mean restore; capture rows explicitly say capture and cannot release pins.
const RestorePublicationOperation = Schema.Struct({
  setId: RecoveryOperationId,
  kind: Schema.optionalKey(Schema.Literal("restore")),
});

const PublicationCompleted = Schema.Struct({ libraryEpoch: ArchiveNumber });

const makeJournal = (database: LibraryControlDatabase) => {
  const query = database.query;

  const fail = (reason: LibraryArchiveError["reason"]): never => {
    throw new LibraryArchiveError({ reason });
  };

  const decode = <S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    input: S["Type"],
  ): S["Type"] => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input);

  const read = <S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    sql: string,
    ...args: ReadonlyArray<string | number | null>
  ): S["Type"] | null => {
    const value = query(sql, ...args)[0];

    return value === undefined
      ? null
      : Schema.decodeUnknownSync(Schema.fromJsonString(schema))(
          Schema.decodeUnknownSync(Body)(value).body,
        );
  };

  const rows = <S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    sql: string,
    ...args: ReadonlyArray<string | number | null>
  ) =>
    query(sql, ...args).map((value) =>
      Schema.decodeUnknownSync(Schema.fromJsonString(schema))(
        Schema.decodeUnknownSync(Body)(value).body,
      ),
    );

  const count = (sql: string, id: string) =>
    Schema.decodeUnknownSync(Count)(query(sql, id)[0]).count;

  const header = (id: string) =>
    read(LibraryArchiveHeader, "SELECT body FROM library_retained_archives WHERE id=?", id) ??
    fail("invalid");

  const object = (id: string, ordinal: number) =>
    read(
      LibraryArchiveObject,
      "SELECT body FROM library_retained_objects WHERE archive_id=? AND ordinal=?",
      id,
      ordinal,
    );

  const receipt = (id: string, ordinal: number, row: number, part: number) =>
    read(
      LibraryArchivePartReceipt,
      "SELECT body FROM library_retained_parts WHERE archive_id=? AND ordinal=? AND row_no=? AND part_no=?",
      id,
      ordinal,
      row,
      part,
    );

  const commit = (id: string) =>
    read(LibraryArchiveCommit, "SELECT body FROM library_retained_commits WHERE archive_id=?", id);

  const summary = (id: string): LibraryArchiveStatus => {
    const value = header(id);
    const completed = commit(id);

    const oldest = Schema.decodeUnknownSync(Time)(
      query(
        "SELECT MIN(uploaded_at) AS at FROM library_retained_uploads WHERE archive_id=?",
        id,
      )[0],
    ).at;

    const latest = Schema.decodeUnknownSync(Time)(
      query(
        "SELECT MAX(verified_at) AS at FROM library_retained_uploads WHERE archive_id=?",
        id,
      )[0],
    ).at;

    return LibraryArchiveStatus.make({
      header: value,
      phase: completed === null ? "uploading" : "committed",
      objectCount: count(
        "SELECT COUNT(*) AS count FROM library_retained_objects WHERE archive_id=?",
        id,
      ),
      completeObjects: count(
        "SELECT COUNT(*) AS count FROM library_retained_objects WHERE archive_id=? AND complete=1",
        id,
      ),
      partCount: count(
        "SELECT COUNT(*) AS count FROM library_retained_parts WHERE archive_id=?",
        id,
      ),
      pageCount: count(
        "SELECT COUNT(*) AS count FROM library_retained_pages WHERE archive_id=?",
        id,
      ),
      oldestUploadedAt: oldest,
      uploadVerifiedAt: latest,
      expiresAt:
        oldest === null ? null : decode(ArchiveNumber, oldest + LIBRARY_ARCHIVE_RETENTION_MS),
      commit: completed,
    });
  };

  const attempt = <A>(body: () => A) =>
    Effect.try({
      try: () => database.transaction(body),
      catch: (cause) =>
        Schema.is(LibraryArchiveError)(cause)
          ? cause
          : new LibraryArchiveError({ reason: "storage" }),
    });

  const mutable = (id: string) => {
    header(id);

    if (commit(id) !== null) fail("conflict");
  };

  const uploaded = (id: string, key: string, value: LibraryArchiveUploadReceipt) => {
    if (value.uploadedAt > value.verifiedAt) fail("invalid");
    query(
      "INSERT INTO library_retained_uploads VALUES (?,?,?,?)",
      id,
      key,
      value.uploadedAt,
      value.verifiedAt,
    );
  };

  return {
    setup: attempt(() => {
      query(
        "CREATE TABLE IF NOT EXISTS library_retained_archives (id TEXT PRIMARY KEY,body TEXT NOT NULL)",
      );
      query(
        "CREATE TABLE IF NOT EXISTS library_retained_objects (archive_id TEXT NOT NULL,ordinal INTEGER NOT NULL,complete INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(archive_id,ordinal))",
      );
      query(
        "CREATE TABLE IF NOT EXISTS library_retained_parts (archive_id TEXT NOT NULL,ordinal INTEGER NOT NULL,row_no INTEGER NOT NULL,part_no INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(archive_id,ordinal,row_no,part_no))",
      );
      query(
        "CREATE TABLE IF NOT EXISTS library_retained_pages (archive_id TEXT NOT NULL,page_no INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(archive_id,page_no))",
      );
      query(
        "CREATE TABLE IF NOT EXISTS library_retained_commits (archive_id TEXT PRIMARY KEY,body TEXT NOT NULL)",
      );
      query(
        "CREATE TABLE IF NOT EXISTS library_retained_uploads (archive_id TEXT NOT NULL,key TEXT NOT NULL,uploaded_at INTEGER NOT NULL,verified_at INTEGER NOT NULL,PRIMARY KEY(archive_id,key))",
      );
      query(
        "CREATE TABLE IF NOT EXISTS library_retained_pins (kind TEXT NOT NULL,id TEXT NOT NULL,archive_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id))",
      );
    }),
    begin: (input: LibraryArchiveHeader) =>
      attempt(() => {
        const value = decode(LibraryArchiveHeader, input);

        const previous = read(
          LibraryArchiveHeader,
          "SELECT body FROM library_retained_archives WHERE id=?",
          value.archiveId,
        );

        if (previous !== null) {
          if (!same(previous, value)) fail("conflict");

          return summary(value.archiveId);
        }

        query(
          "INSERT INTO library_retained_archives VALUES (?,?)",
          value.archiveId,
          JSON.stringify(value),
        );

        const pin = LibraryArchivePin.make({
          id: value.archiveId,
          archiveId: value.archiveId,
          kind: "upload",
          completed: false,
        });

        query(
          "INSERT INTO library_retained_pins VALUES (?,?,?,?)",
          pin.kind,
          pin.id,
          pin.archiveId,
          JSON.stringify(pin),
        );

        return summary(value.archiveId);
      }),
    status: (id: string) =>
      attempt(() => {
        decode(RecoveryOperationId, id);

        return read(
          LibraryArchiveHeader,
          "SELECT body FROM library_retained_archives WHERE id=?",
          id,
        ) === null
          ? null
          : summary(id);
      }),
    object: (id: string, ordinal: number) =>
      attempt(() => object(decode(RecoveryOperationId, id), decode(ArchiveNumber, ordinal))),
    objects: (id: string, after: number) =>
      attempt(() => {
        header(decode(RecoveryOperationId, id));
        decode(ArchiveNumber, after);

        return rows(
          LibraryArchiveObject,
          "SELECT body FROM library_retained_objects WHERE archive_id=? AND ordinal>? ORDER BY ordinal LIMIT 8",
          id,
          after,
        );
      }),
    recordObject: (id: string, input: Pick<LibraryArchiveObject, "ordinal" | "source" | "image">) =>
      attempt(() => {
        const value = decode(LibraryArchiveObject, { ...input, complete: false, partCount: 0 });
        const selected = header(id);
        const previous = object(id, value.ordinal);

        if (previous !== null) {
          if (!same(previous.source, value.source) || !same(previous.image, value.image))
            fail("conflict");

          return previous;
        }

        mutable(id);

        if (value.source.lineage !== selected.set.sourceLineage) fail("conflict");
        const state = summary(id);

        const last = rows(
          LibraryArchiveObject,
          "SELECT body FROM library_retained_objects WHERE archive_id=? ORDER BY ordinal DESC LIMIT 1",
          id,
        )[0];

        if (
          state.objectCount >= selected.set.objectCount ||
          (last !== undefined && (!last.complete || last.ordinal >= value.ordinal))
        )
          fail("conflict");
        query(
          "INSERT INTO library_retained_objects VALUES (?,?,0,?)",
          id,
          value.ordinal,
          JSON.stringify(value),
        );

        return value;
      }),
    part: (id: string, ordinal: number, row: number, part: number) =>
      attempt(() =>
        receipt(
          decode(RecoveryOperationId, id),
          decode(ArchiveNumber, ordinal),
          decode(ArchiveNumber, row),
          decode(ArchiveNumber, part),
        ),
      ),
    recordPart: (id: string, ordinal: number, input: LibraryArchivePartReceipt) =>
      attempt(() => {
        const value = decode(LibraryArchivePartReceipt, input);
        const previous = receipt(id, ordinal, value.row, value.part);

        if (previous !== null) {
          if (!same(previous, value)) fail("conflict");

          return previous;
        }

        mutable(id);
        const selected = object(id, ordinal) ?? fail("invalid");

        const last = rows(
          LibraryArchivePartReceipt,
          "SELECT body FROM library_retained_parts WHERE archive_id=? AND ordinal=? ORDER BY row_no DESC,part_no DESC LIMIT 1",
          id,
          ordinal,
        )[0];

        const nextRow = last === undefined ? 1 : last.row + (last.part + 1 === last.parts ? 1 : 0);
        const nextPart = last === undefined || last.part + 1 === last.parts ? 0 : last.part + 1;

        if (
          selected.complete ||
          value.row !== nextRow ||
          value.part !== nextPart ||
          value.part >= value.parts ||
          value.row > selected.image.kvCount + selected.image.sqlCount + 1
        )
          fail("conflict");

        if (last !== undefined && value.row === last.row && value.parts !== last.parts)
          fail("conflict");
        query(
          "INSERT INTO library_retained_parts VALUES (?,?,?,?,?)",
          id,
          ordinal,
          value.row,
          value.part,
          JSON.stringify(value),
        );
        uploaded(id, `part/${ordinal}/${value.row}/${value.part}`, value);
        const updated = { ...selected, partCount: decode(ArchiveNumber, selected.partCount + 1) };
        query(
          "UPDATE library_retained_objects SET body=? WHERE archive_id=? AND ordinal=?",
          JSON.stringify(updated),
          id,
          ordinal,
        );

        return value;
      }),
    completeObject: (id: string, ordinal: number) =>
      attempt(() => {
        const selected = object(id, ordinal) ?? fail("invalid");

        if (selected.complete) return selected;
        mutable(id);

        const last = rows(
          LibraryArchivePartReceipt,
          "SELECT body FROM library_retained_parts WHERE archive_id=? AND ordinal=? ORDER BY row_no DESC,part_no DESC LIMIT 1",
          id,
          ordinal,
        )[0];

        if (
          last === undefined ||
          last.row !== selected.image.kvCount + selected.image.sqlCount + 1 ||
          last.part + 1 !== last.parts
        )
          fail("incomplete");
        const updated = { ...selected, complete: true };
        query(
          "UPDATE library_retained_objects SET complete=1,body=? WHERE archive_id=? AND ordinal=?",
          JSON.stringify(updated),
          id,
          ordinal,
        );

        return updated;
      }),
    page: (id: string, page: number) =>
      attempt(() =>
        read(
          LibraryArchivePageReceipt,
          "SELECT body FROM library_retained_pages WHERE archive_id=? AND page_no=?",
          decode(RecoveryOperationId, id),
          decode(ArchiveNumber, page),
        ),
      ),
    recordPage: (id: string, input: LibraryArchivePageReceipt) =>
      attempt(() => {
        const value = decode(LibraryArchivePageReceipt, input);

        const previous = read(
          LibraryArchivePageReceipt,
          "SELECT body FROM library_retained_pages WHERE archive_id=? AND page_no=?",
          id,
          value.page,
        );

        if (previous !== null) {
          if (!same(previous, value)) fail("conflict");

          return previous;
        }

        mutable(id);
        const state = summary(id);

        if (
          state.completeObjects !== state.header.set.objectCount ||
          value.page !== state.pageCount ||
          value.page >= Math.max(1, Math.ceil(state.objectCount / LIBRARY_ARCHIVE_PAGE_SIZE))
        )
          fail("incomplete");

        const last = read(
          LibraryArchivePageReceipt,
          "SELECT body FROM library_retained_pages WHERE archive_id=? AND page_no=?",
          id,
          value.page - 1,
        );

        const after = last?.after ?? 0;

        const members = rows(
          LibraryArchiveObject,
          "SELECT body FROM library_retained_objects WHERE archive_id=? AND ordinal>? ORDER BY ordinal LIMIT 8",
          id,
          after,
        );

        if (
          members.length !== value.count ||
          (members.at(-1)?.ordinal ?? 0) !== value.after ||
          value.previousSha256 !== (last?.plainSha256 ?? ZERO)
        )
          fail("conflict");
        query(
          "INSERT INTO library_retained_pages VALUES (?,?,?)",
          id,
          value.page,
          JSON.stringify(value),
        );
        uploaded(id, `page/${value.page}`, value);

        return value;
      }),
    commit: (id: string, input: LibraryArchiveCommit, now: number) =>
      attempt(() => {
        const value = decode(LibraryArchiveCommit, input);
        decode(ArchiveNumber, now);
        const previous = commit(id);

        if (previous !== null) {
          if (!same(previous, value)) fail("conflict");

          return summary(id);
        }

        const state = summary(id);

        const last = read(
          LibraryArchivePageReceipt,
          "SELECT body FROM library_retained_pages WHERE archive_id=? AND page_no=?",
          id,
          state.pageCount - 1,
        );

        const manifest = value.manifest;

        const oldest = Math.min(
          state.oldestUploadedAt ?? value.receipt.uploadedAt,
          value.receipt.uploadedAt,
        );

        const expires = decode(ArchiveNumber, oldest + LIBRARY_ARCHIVE_RETENTION_MS);

        if (
          !same(manifest.header, state.header) ||
          state.objectCount !== state.header.set.objectCount ||
          state.completeObjects !== state.objectCount ||
          manifest.objectCount !== state.objectCount ||
          manifest.partCount !== state.partCount ||
          state.pageCount !==
            Math.max(1, Math.ceil(state.objectCount / LIBRARY_ARCHIVE_PAGE_SIZE)) ||
          manifest.pageCount !== state.pageCount ||
          manifest.lastPageSha256 !== (last?.plainSha256 ?? ZERO) ||
          manifest.oldestUploadedAt !== oldest ||
          manifest.expiresAt !== expires
        )
          fail("incomplete");

        if (now >= expires || value.receipt.verifiedAt > now) fail("expired");
        uploaded(id, "manifest", value.receipt);
        query("INSERT INTO library_retained_commits VALUES (?,?)", id, JSON.stringify(value));
        const pin = LibraryArchivePin.make({ id, archiveId: id, kind: "upload", completed: true });
        query(
          "UPDATE library_retained_pins SET body=? WHERE kind='upload' AND id=?",
          JSON.stringify(pin),
          id,
        );

        return summary(id);
      }),
    pinRestore: (id: string, archiveId: string, now: number) =>
      attempt(() => {
        decode(RecoveryOperationId, id);
        const state = summary(decode(RecoveryOperationId, archiveId));

        if (state.commit === null) fail("incomplete");

        if (state.expiresAt === null || decode(ArchiveNumber, now) >= state.expiresAt)
          fail("expired");

        const previous = read(
          LibraryArchivePin,
          "SELECT body FROM library_retained_pins WHERE kind='restore' AND id=?",
          id,
        );

        if (previous !== null) {
          if (previous.archiveId !== archiveId || previous.completed) fail("conflict");

          return previous;
        }

        const pin = LibraryArchivePin.make({ id, archiveId, kind: "restore", completed: false });
        query(
          "INSERT INTO library_retained_pins VALUES (?,?,?,?)",
          pin.kind,
          pin.id,
          pin.archiveId,
          JSON.stringify(pin),
        );

        return pin;
      }),
    restorePin: (id: string) =>
      attempt(() =>
        read(
          LibraryArchivePin,
          "SELECT body FROM library_retained_pins WHERE kind='restore' AND id=?",
          decode(RecoveryOperationId, id),
        ),
      ),
    finishRestore: (id: string) =>
      attempt(() => {
        const pin =
          read(
            LibraryArchivePin,
            "SELECT body FROM library_retained_pins WHERE kind='restore' AND id=?",
            decode(RecoveryOperationId, id),
          ) ?? fail("invalid");

        if (pin.completed) return pin;

        const selected = header(pin.archiveId);

        const operation = read(
          RestorePublicationOperation,
          "SELECT body FROM library_journal WHERE kind='operation' AND id=?",
          id,
        );

        const publication = read(
          LibraryRecoveryState,
          "SELECT body FROM library_journal WHERE kind='published' AND id=?",
          id,
        );

        const completedProof = read(
          PublicationCompleted,
          "SELECT body FROM library_journal WHERE kind='publication-complete' AND id=?",
          id,
        );

        if (operation === null || publication === null || completedProof === null)
          return fail("incomplete");

        if (
          operation.setId !== selected.set.id ||
          publication.phase !== "ready" ||
          publication.operationId !== null ||
          publication.stagingLineage !== null ||
          completedProof.libraryEpoch !== publication.epoch
        )
          return fail("conflict");

        const completed = { ...pin, completed: true };
        query(
          "UPDATE library_retained_pins SET body=? WHERE kind='restore' AND id=?",
          JSON.stringify(completed),
          id,
        );

        return completed;
      }),
    pins: (archiveId: string, after: string) =>
      attempt(() => {
        header(decode(RecoveryOperationId, archiveId));
        decode(Schema.String, after);

        return rows(
          LibraryArchivePin,
          "SELECT body FROM library_retained_pins WHERE archive_id=? AND kind||':'||id>? ORDER BY kind||':'||id LIMIT 64",
          archiveId,
          after,
        );
      }),
  };
};

/** Separate durable archive receipts/pins; no raw Domain data or prune authority. */
export class LibraryRetainedArchiveJournal extends Context.Service<
  LibraryRetainedArchiveJournal,
  ReturnType<typeof makeJournal>
>()("@kitties/gateway/LibraryRetainedArchiveJournal") {
  static readonly layer = (database: LibraryControlDatabase) =>
    Layer.effect(
      LibraryRetainedArchiveJournal,
      Effect.gen(function* () {
        const journal = makeJournal(database);
        yield* journal.setup;

        return journal;
      }),
    );
}
