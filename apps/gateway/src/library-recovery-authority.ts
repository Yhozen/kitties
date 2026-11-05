import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { LibraryControlDatabase } from "./library-recovery-store.ts";
import {
  LibraryRecoveryError,
  LibraryRecoveryState,
  RecoveryOperationId,
  RecoveryOrdinal,
} from "./library-recovery-records.ts";

export type LibraryRecoveryAccess =
  | { readonly kind: "read" | "normal" }
  | { readonly kind: "begin" | "operation"; readonly operationId: string };

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
    const current = control();
    const unfinished = library();

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

    return { epoch, operation_id: operationId, mode: "recovering" as const };
  };

  const completeGlobal = (operationId: string) => {
    const current = control();
    const unfinished = library();

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
      case "operation": {
        validateOperation(access.operationId);
        const current = control();

        if (current.mode !== "recovering" || current.operation_id !== access.operationId)
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
