import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { LibraryControlDatabase } from "./library-recovery-store.ts";
import {
  LIBRARY_CAPTURE_PRUNE_MIN_AGE_MS,
  LibraryArchivePruneRequest,
  LibraryCapturePrunePlan,
} from "./library-capture-prune-records.ts";
import {
  LibraryCaptureOperation,
  LibraryRecoveryError,
  LibraryRecoverySet,
  LibraryRecoveryState,
  RecoveryOperationId,
  RecoveryOrdinal,
} from "./library-recovery-records.ts";

export type LibraryRecoveryAccess =
  | { readonly kind: "read" | "normal" }
  | {
      readonly kind:
        | "begin"
        | "operation"
        | "capture-begin"
        | "capture-operation"
        | "freeze-operation";
      readonly operationId: string;
    };

/** Called synchronously inside the journal's SQL transaction, before its body. */
export interface LibraryRecoveryAuthority {
  readonly authorize: (access: LibraryRecoveryAccess) => void;
}

const GlobalControl = Schema.Struct({
  epoch: RecoveryOrdinal,
  operation_id: Schema.NullOr(Schema.String),
  mode: Schema.Literals(["ready", "recovering"]),
});

const LibraryBody = Schema.Struct({ body: Schema.String });
const CompletedPublication = Schema.Struct({ libraryEpoch: RecoveryOrdinal });

const OperationKind = Schema.Struct({
  kind: Schema.optionalKey(Schema.Literals(["capture", "restore"])),
});

const GlobalOperation = Schema.Struct({ epoch: RecoveryOrdinal });

export const setupLibraryCapturePrunes = (database: LibraryControlDatabase): void => {
  database.query(
    "CREATE TABLE IF NOT EXISTS library_capture_prunes (id TEXT PRIMARY KEY,capture_id TEXT NOT NULL UNIQUE,archive_id TEXT NOT NULL,phase TEXT NOT NULL,body TEXT NOT NULL)",
  );
  database.query(
    "CREATE TABLE IF NOT EXISTS library_capture_prune_acks (prune_id TEXT NOT NULL,ordinal INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(prune_id,ordinal))",
  );
  database.query(
    "CREATE TABLE IF NOT EXISTS library_capture_prune_stops (prune_id TEXT NOT NULL,ordinal INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(prune_id,ordinal))",
  );
};

const pruneRow = (database: LibraryControlDatabase, id: string) => {
  const row = database.query("SELECT body FROM library_capture_prunes WHERE id=?", id)[0];

  return row === undefined
    ? null
    : Schema.decodeUnknownSync(Schema.fromJsonString(LibraryCapturePrunePlan))(
        Schema.decodeUnknownSync(LibraryBody)(row).body,
      );
};

/** Caller MUST hold the shared SQL transaction. This never starts a transaction. */
export const assertNoLibraryCapturePrune = (
  database: LibraryControlDatabase,
  operationId: string,
): void => {
  if (pruneRow(database, operationId) !== null)
    throw new LibraryRecoveryError({ reason: "conflict" });

  if (
    database.query(
      "SELECT id FROM library_capture_prunes WHERE phase NOT IN ('complete','abandoned') LIMIT 1",
    )[0] !== undefined
  )
    throw new LibraryRecoveryError({ reason: "fenced" });
};

/** Any reservation permanently retires the local image as a Native source. */
export const assertLibraryCaptureAvailable = (
  database: LibraryControlDatabase,
  captureId: string,
): void => {
  if (
    database.query("SELECT id FROM library_capture_prunes WHERE capture_id=?", captureId)[0] !==
    undefined
  )
    throw new LibraryRecoveryError({ reason: "fenced" });
};

const PruneCommit = Schema.Struct({
  manifest: Schema.Struct({
    header: Schema.Struct({ archiveId: RecoveryOperationId, set: LibraryRecoverySet }),
    expiresAt: RecoveryOrdinal,
  }),
  receipt: Schema.Struct({ plainSha256: LibraryArchivePruneRequest.fields.manifestDigest }),
});

/** Atomic admission hook for the retained journal; no Effect or nested transaction. */
export const reserveLibraryCapturePrune = (
  database: LibraryControlDatabase,
  input: LibraryArchivePruneRequest,
  expiresAt: number,
  now: number,
): LibraryCapturePrunePlan => {
  const reject = (reason: LibraryRecoveryError["reason"]): never => {
    throw new LibraryRecoveryError({ reason });
  };

  if (
    !Schema.is(LibraryArchivePruneRequest)(input) ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(expiresAt)
  )
    return reject("invalid");
  const request = LibraryArchivePruneRequest.make(input);
  const previous = pruneRow(database, request.pruneId);

  if (previous !== null) {
    if (
      !Schema.toEquivalence(LibraryArchivePruneRequest)(previous.request, request) ||
      previous.expiresAt !== expiresAt
    )
      return reject("conflict");

    if (previous.phase !== "complete" && (now < previous.reservedAt || now >= expiresAt))
      return reject("fenced");

    return previous;
  }

  assertNoLibraryCapturePrune(database, request.pruneId);

  if (
    database.query(
      "SELECT id FROM library_capture_prunes WHERE capture_id=?",
      request.captureId,
    )[0] !== undefined
  )
    return reject("conflict");

  if (
    database.query(
      "SELECT id FROM library_journal WHERE id=? AND kind IN ('operation','global-operation','export-grant') LIMIT 1",
      request.pruneId,
    )[0] !== undefined
  )
    return reject("conflict");

  const control = Schema.decodeUnknownSync(GlobalControl)(
    database.query("SELECT epoch,operation_id,mode FROM recovery_control WHERE id=1")[0],
  );

  const read = <S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    sql: string,
    id?: string,
  ): S["Type"] | null => {
    const found = id === undefined ? database.query(sql)[0] : database.query(sql, id)[0];

    return found === undefined
      ? null
      : Schema.decodeUnknownSync(Schema.fromJsonString(schema))(
          Schema.decodeUnknownSync(LibraryBody)(found).body,
        );
  };

  const state = read(LibraryRecoveryState, "SELECT body FROM library_control WHERE id=1");

  if (control.mode !== "ready" || state?.phase !== "ready" || state.operationId !== null)
    return reject("fenced");

  if (control.operation_id === request.pruneId) return reject("conflict");

  const operation = read(
    LibraryCaptureOperation,
    "SELECT body FROM library_journal WHERE kind='operation' AND id=?",
    request.captureId,
  );

  const captured = read(
    LibraryRecoverySet,
    "SELECT body FROM library_journal WHERE kind='set' AND id=?",
    request.captureId,
  );

  const completed = read(
    LibraryRecoveryState,
    "SELECT body FROM library_journal WHERE kind='capture-complete' AND id=?",
    request.captureId,
  );

  if (
    operation === null ||
    captured === null ||
    completed === null ||
    captured.capturedAt === undefined
  )
    return reject("incomplete");

  if (
    captured.id !== request.captureId ||
    operation.codeDigest !== request.codeDigest ||
    captured.codeDigest !== request.codeDigest ||
    completed.phase !== "ready" ||
    completed.lineage !== captured.sourceLineage ||
    completed.inventoryId !== captured.inventoryId
  )
    return reject("conflict");

  if (
    !Number.isSafeInteger(captured.capturedAt) ||
    now < captured.capturedAt ||
    now - captured.capturedAt < LIBRARY_CAPTURE_PRUNE_MIN_AGE_MS ||
    now >= expiresAt
  )
    return reject("fenced");

  const commit = read(
    PruneCommit,
    "SELECT body FROM library_retained_commits WHERE archive_id=?",
    request.archiveId,
  );

  if (commit === null) return reject("incomplete");

  if (
    commit.manifest.header.archiveId !== request.archiveId ||
    !Schema.toEquivalence(LibraryRecoverySet)(commit.manifest.header.set, captured) ||
    commit.receipt.plainSha256 !== request.manifestDigest ||
    commit.manifest.expiresAt !== expiresAt
  )
    return reject("conflict");

  const count = Schema.decodeUnknownSync(Schema.Struct({ count: RecoveryOrdinal }))(
    database.query(
      "SELECT COUNT(*) AS count FROM library_images WHERE set_id=?",
      request.captureId,
    )[0],
  ).count;

  if (
    count !== captured.objectCount ||
    database.query(
      "SELECT i.ordinal FROM library_images i LEFT JOIN library_objects o ON o.ordinal=i.ordinal WHERE i.set_id=? AND (o.ordinal IS NULL OR o.lineage<>?) LIMIT 1",
      request.captureId,
      captured.sourceLineage,
    )[0] !== undefined
  )
    return reject("conflict");

  if (
    database.query(
      "SELECT p.id FROM library_retained_pins p JOIN library_retained_archives a ON a.id=p.archive_id WHERE json_extract(a.body,'$.set.id')=? AND json_extract(p.body,'$.completed')<>1 LIMIT 1",
      request.captureId,
    )[0] !== undefined
  )
    return reject("fenced");

  // Historical unbound restore rows are unsafe until a publication proves completion.
  if (
    database.query(
      "SELECT o.id FROM library_journal o WHERE o.kind='operation' AND COALESCE(json_extract(o.body,'$.kind'),'restore')='restore' AND NOT EXISTS (SELECT 1 FROM library_journal p WHERE p.kind='published' AND p.id=o.id) AND (json_extract(o.body,'$.intent.source._tag') IS NULL OR json_extract(o.body,'$.intent.source._tag')='Native') LIMIT 1",
    )[0] !== undefined
  )
    return reject("fenced");

  const plan = LibraryCapturePrunePlan.make({
    request,
    phase: "reserved",
    reservedAt: now,
    expiresAt,
    capturedAt: captured.capturedAt,
    objectCount: captured.objectCount,
  });

  database.query(
    "INSERT INTO library_capture_prunes VALUES (?,?,?,?,?)",
    request.pruneId,
    request.captureId,
    request.archiveId,
    plan.phase,
    JSON.stringify(plan),
  );

  return plan;
};

/** All three operations require the caller's shared SQL transaction. */
const makeLibraryRecoveryAuthority = (database: LibraryControlDatabase, now: () => number) => {
  const control = () => {
    const row = database.query(
      "SELECT epoch,operation_id,mode FROM recovery_control WHERE id=1",
    )[0];

    if (row === undefined) throw new LibraryRecoveryError({ reason: "uninitialized" });

    return Schema.decodeUnknownSync(GlobalControl)(row);
  };

  const library = () => {
    const row = database.query("SELECT body FROM library_control WHERE id=1")[0];

    if (row === undefined) return undefined;

    return Schema.decodeUnknownSync(Schema.fromJsonString(LibraryRecoveryState))(
      Schema.decodeUnknownSync(LibraryBody)(row).body,
    );
  };

  const validateOperation = (operationId: string) => {
    if (!Schema.is(RecoveryOperationId)(operationId))
      throw new LibraryRecoveryError({ reason: "invalid" });
  };

  const operationKind = (operationId: string) => {
    const row = database.query(
      "SELECT body FROM library_journal WHERE kind='operation' AND id=?",
      operationId,
    )[0];

    return row === undefined
      ? undefined
      : (Schema.decodeUnknownSync(Schema.fromJsonString(OperationKind))(
          Schema.decodeUnknownSync(LibraryBody)(row).body,
        ).kind ?? "restore");
  };

  const globalOperation = (operationId: string) => {
    const row = database.query(
      "SELECT body FROM library_journal WHERE kind='global-operation' AND id=?",
      operationId,
    )[0];

    return row === undefined
      ? undefined
      : Schema.decodeUnknownSync(Schema.fromJsonString(GlobalOperation))(
          Schema.decodeUnknownSync(LibraryBody)(row).body,
        );
  };

  const publication = (operationId: string) => {
    const row = database.query(
      "SELECT body FROM library_journal WHERE kind='published' AND id=?",
      operationId,
    )[0];

    return row === undefined
      ? undefined
      : Schema.decodeUnknownSync(Schema.fromJsonString(LibraryRecoveryState))(
          Schema.decodeUnknownSync(LibraryBody)(row).body,
        );
  };

  const completedPublication = (operationId: string) => {
    const row = database.query(
      "SELECT body FROM library_journal WHERE kind='publication-complete' AND id=?",
      operationId,
    )[0];

    return row === undefined
      ? undefined
      : Schema.decodeUnknownSync(Schema.fromJsonString(CompletedPublication))(
          Schema.decodeUnknownSync(LibraryBody)(row).body,
        );
  };

  const beginGlobal = (operationId: string) => {
    assertNoLibraryCapturePrune(database, operationId);
    const current = control();
    const unfinished = library();

    // Capture identities can never acquire or release a destructive recovery fence.
    if (operationKind(operationId) === "capture")
      throw new LibraryRecoveryError({ reason: "conflict" });

    if (unfinished?.operationKind === "capture" && unfinished.phase !== "ready")
      throw new LibraryRecoveryError({ reason: "fenced" });

    // Preserve the last known pre-journal destructive identity before overwriting CURRENT.
    if (current.operation_id !== null && globalOperation(current.operation_id) === undefined)
      database.query(
        "INSERT INTO library_journal(kind,id,body) VALUES ('global-operation',?,?)",
        current.operation_id,
        JSON.stringify({ epoch: current.epoch }),
      );

    const reserved = globalOperation(operationId);

    if (
      reserved !== undefined &&
      (current.mode !== "recovering" ||
        current.operation_id !== operationId ||
        current.epoch !== reserved.epoch)
    )
      throw new LibraryRecoveryError({ reason: "conflict" });

    // A published Library identity cannot become a later legacy recovery incarnation.
    if (publication(operationId) !== undefined || completedPublication(operationId) !== undefined)
      throw new LibraryRecoveryError({ reason: "conflict" });

    if (
      unfinished !== undefined &&
      unfinished.phase !== "ready" &&
      unfinished.operationId !== operationId
    )
      throw new LibraryRecoveryError({ reason: "fenced" });

    if (current.mode === "recovering") {
      if (current.operation_id !== operationId)
        throw new LibraryRecoveryError({ reason: "fenced" });

      return current;
    }

    if (current.operation_id === operationId)
      throw new LibraryRecoveryError({ reason: "conflict" });

    if (current.epoch === Number.MAX_SAFE_INTEGER)
      throw new LibraryRecoveryError({ reason: "exhausted" });

    const timestamp = now();

    if (!Schema.is(RecoveryOrdinal)(timestamp))
      throw new LibraryRecoveryError({ reason: "invalid" });

    const epoch = Math.max(current.epoch + 1, timestamp);
    database.query(
      "UPDATE recovery_control SET epoch=?,operation_id=?,mode='recovering' WHERE id=1",
      epoch,
      operationId,
    );
    database.query("UPDATE recovery_runs SET review=1 WHERE epoch<?", epoch);
    database.query(
      "INSERT INTO library_journal(kind,id,body) VALUES ('global-operation',?,?)",
      operationId,
      JSON.stringify({ epoch }),
    );

    return { epoch, operation_id: operationId, mode: "recovering" as const };
  };

  const completeGlobal = (operationId: string) => {
    const current = control();
    const unfinished = library();

    if (operationKind(operationId) === "capture")
      throw new LibraryRecoveryError({ reason: "conflict" });

    if (
      current.operation_id !== operationId ||
      (unfinished !== undefined && unfinished.phase !== "ready")
    )
      throw new LibraryRecoveryError({ reason: "fenced" });

    if (current.mode === "ready") return current;

    database.query(
      "UPDATE recovery_control SET mode='ready' WHERE id=1 AND operation_id=?",
      operationId,
    );

    return { ...current, mode: "ready" as const };
  };

  const completePublication = (operationId: string): typeof GlobalControl.Type => {
    validateOperation(operationId);
    const published = publication(operationId);

    if (published === undefined) throw new LibraryRecoveryError({ reason: "incomplete" });

    if (
      published.phase !== "ready" ||
      published.operationId !== null ||
      published.stagingLineage !== null
    )
      throw new LibraryRecoveryError({ reason: "conflict" });
    const current = control();
    const completed = completedPublication(operationId);

    if (completed !== undefined) {
      if (completed.libraryEpoch !== published.epoch)
        throw new LibraryRecoveryError({ reason: "conflict" });

      return current;
    }

    // Another owner proves the original fence already closed. Never close theirs.
    const result = current.operation_id === operationId ? completeGlobal(operationId) : current;
    database.query(
      "INSERT INTO library_journal(kind,id,body) VALUES ('publication-complete',?,?)",
      operationId,
      JSON.stringify({ libraryEpoch: published.epoch }),
    );

    return result;
  };

  const authorize = (access: LibraryRecoveryAccess): void => {
    switch (access.kind) {
      case "read":
        return;
      case "normal":
        if (control().mode !== "ready") throw new LibraryRecoveryError({ reason: "fenced" });

        return;
      case "begin":
        validateOperation(access.operationId);
        beginGlobal(access.operationId);

        return;
      case "capture-begin": {
        validateOperation(access.operationId);
        assertNoLibraryCapturePrune(database, access.operationId);
        const current = control();

        if (current.mode !== "ready") throw new LibraryRecoveryError({ reason: "fenced" });

        if (
          current.operation_id === access.operationId ||
          globalOperation(access.operationId) !== undefined
        )
          throw new LibraryRecoveryError({ reason: "conflict" });

        return;
      }

      case "freeze-operation":
      case "capture-operation": {
        validateOperation(access.operationId);
        const state = library();
        const kind = operationKind(access.operationId);

        if (
          state?.operationId !== access.operationId ||
          state.phase === "ready" ||
          state.phase === "importing" ||
          (state.operationKind ?? "restore") !== kind
        )
          throw new LibraryRecoveryError({ reason: "fenced" });

        if (kind === "capture") {
          if (control().mode !== "ready") throw new LibraryRecoveryError({ reason: "fenced" });

          return;
        }

        if (access.kind === "capture-operation")
          throw new LibraryRecoveryError({ reason: "fenced" });

        authorize({ kind: "operation", operationId: access.operationId });

        return;
      }

      case "operation": {
        validateOperation(access.operationId);
        const current = control();

        if (
          operationKind(access.operationId) === "capture" ||
          current.mode !== "recovering" ||
          current.operation_id !== access.operationId
        )
          throw new LibraryRecoveryError({ reason: "fenced" });

        return;
      }
    }
  };

  return { authorize, beginGlobal, completeGlobal, completePublication };
};

export class GlobalRecoveryAuthority extends Context.Service<
  GlobalRecoveryAuthority,
  ReturnType<typeof makeLibraryRecoveryAuthority>
>()("@kitties/gateway/GlobalRecoveryAuthority") {
  static readonly layer = (database: LibraryControlDatabase, now: () => number) =>
    Layer.sync(GlobalRecoveryAuthority, () => makeLibraryRecoveryAuthority(database, now));
}
