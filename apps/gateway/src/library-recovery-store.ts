import type * as Cloudflare from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import type {
  LibraryRecoveryAccess,
  LibraryRecoveryAuthority,
} from "./library-recovery-authority.ts";
import {
  LibraryLineage,
  LibraryObjectClass,
  LibraryObjectImage,
  LibraryObjectRef,
  LibraryRecoveryError,
  LibraryRecoverySet,
  LibraryRecoveryState,
  RecoveryDigest,
  RecoveryOperationId,
  RecoveryOrdinal,
  RegisteredLibraryObject,
} from "./library-recovery-records.ts";

/** The synchronous SQLite operations used by RecoveryDO's library journal. */
export interface LibraryControlDatabase {
  readonly query: (
    statement: string,
    ...bindings: ReadonlyArray<string | number | null>
  ) => ReadonlyArray<Schema.JsonObject>;
  readonly transaction: <A>(body: () => A) => A;
}

export const nativeLibraryControlDatabase = (
  storage: Pick<Cloudflare.DurableObjectStorage, "sql" | "transactionSync">,
): LibraryControlDatabase => ({
  query: (statement, ...bindings) =>
    Schema.decodeUnknownSync(Schema.Array(Schema.JsonObject))(
      storage.sql.exec(statement, ...bindings).toArray(),
    ),
  transaction: (body) => storage.transactionSync(body),
});

const Body = Schema.Struct({ body: Schema.String });
const Count = Schema.Struct({ count: RecoveryOrdinal });
const Ordinal = Schema.Struct({ ordinal: RecoveryOrdinal });
const SessionId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));
const FreezeAck = Schema.Struct({ before: SessionId, after: Schema.NullOr(SessionId) });
const Operation = Schema.Struct({ setId: Schema.NullOr(RecoveryOperationId) });

const increment = (value: number) => {
  if (value >= Number.MAX_SAFE_INTEGER) throw new LibraryRecoveryError({ reason: "exhausted" });

  return value + 1;
};

const makeLibraryRecoveryStore = (
  database: LibraryControlDatabase,
  authority: LibraryRecoveryAuthority,
) => {
  const query = database.query;

  const row = <S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    statement: string,
    ...bindings: ReadonlyArray<string | number | null>
  ): S["Type"] | undefined => {
    const found = query(statement, ...bindings)[0];

    return found === undefined ? undefined : Schema.decodeUnknownSync(schema)(found);
  };

  const read = <S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    statement: string,
    ...bindings: ReadonlyArray<string | number | null>
  ): S["Type"] | undefined => {
    const found = row(Body, statement, ...bindings);

    return found === undefined
      ? undefined
      : Schema.decodeUnknownSync(Schema.fromJsonString(schema))(found.body);
  };

  const count = (statement: string, ...bindings: ReadonlyArray<string | number | null>) =>
    row(Count, statement, ...bindings)?.count ?? 0;

  const fail = (reason: LibraryRecoveryError["reason"]): never => {
    throw new LibraryRecoveryError({ reason });
  };

  const status = () => read(LibraryRecoveryState, "SELECT body FROM library_control WHERE id=1");
  const current = () => status() ?? fail("uninitialized");

  const save = (state: LibraryRecoveryState) => {
    query("INSERT OR REPLACE INTO library_control VALUES (1,?)", JSON.stringify(state));

    return state;
  };

  const attempt = <A>(body: () => A, access: LibraryRecoveryAccess = { kind: "normal" }) =>
    Effect.try({
      try: () =>
        database.transaction(() => {
          authority.authorize(access);

          return body();
        }),
      catch: (cause) =>
        Schema.is(LibraryRecoveryError)(cause)
          ? cause
          : new LibraryRecoveryError({ reason: "storage" }),
    });

  const refAt = (ordinal: number) =>
    read(LibraryObjectRef, "SELECT body FROM library_objects WHERE ordinal=?", ordinal) ??
    fail("invalid");

  const phaseOf = (lineage: string) =>
    row(
      Schema.Struct({ phase: RegisteredLibraryObject.fields.phase }),
      "SELECT phase FROM library_lineages WHERE lineage=?",
      lineage,
    )?.phase ?? fail("invalid");

  const ownedOperation = (operationId: string) => {
    const state = current();

    if (state.operationId !== operationId) return fail("conflict");

    return state;
  };

  const immutable = (kind: string, id: string, body: string) => {
    const existing = row(Body, "SELECT body FROM library_journal WHERE kind=? AND id=?", kind, id);

    if (existing !== undefined) {
      if (existing.body !== body) fail("conflict");

      return;
    }

    query("INSERT INTO library_journal VALUES (?,?,?)", kind, id, body);
  };

  const initialize = Effect.fnUntraced(function* (inventoryId: string) {
    yield* Schema.decodeUnknownEffect(RecoveryOperationId)(inventoryId).pipe(
      Effect.mapError(() => new LibraryRecoveryError({ reason: "invalid" })),
    );

    return yield* attempt(() => {
      const previous = status();

      if (previous !== undefined) {
        if (previous.inventoryId !== inventoryId) return fail("conflict");

        return previous;
      }

      query("INSERT INTO library_lineages VALUES ('library-1',1,'importing')");

      return save({
        libraryId: "owner",
        epoch: 1,
        lineage: "library-1",
        nextLineage: 2,
        phase: "importing",
        inventoryId,
        operationId: null,
        stagingLineage: null,
        allocatorFloor: 0,
      });
    });
  });

  const validateRef = (ref: LibraryObjectRef) =>
    Schema.is(LibraryObjectRef)(ref) && ref.physicalName === `r:${ref.lineage}:${ref.logicalName}`;

  return {
    setup: attempt(
      () => {
        query(
          "CREATE TABLE IF NOT EXISTS library_control (id INTEGER PRIMARY KEY,body TEXT NOT NULL)",
        );
        query(
          "CREATE TABLE IF NOT EXISTS library_lineages (lineage TEXT PRIMARY KEY,epoch INTEGER NOT NULL UNIQUE,phase TEXT NOT NULL)",
        );
        query(
          "CREATE TABLE IF NOT EXISTS library_objects (ordinal INTEGER PRIMARY KEY AUTOINCREMENT,class_name TEXT NOT NULL,native_id TEXT NOT NULL,lineage TEXT NOT NULL,logical_name TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(class_name,native_id),UNIQUE(lineage,class_name,logical_name))",
        );
        query(
          "CREATE TABLE IF NOT EXISTS library_journal (kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id))",
        );
        query(
          "CREATE TABLE IF NOT EXISTS library_freezes (operation_id TEXT NOT NULL,ordinal INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(operation_id,ordinal))",
        );
        query(
          "CREATE TABLE IF NOT EXISTS library_images (set_id TEXT NOT NULL,ordinal INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(set_id,ordinal))",
        );
        query(
          "CREATE TABLE IF NOT EXISTS library_loads (operation_id TEXT NOT NULL,source_ordinal INTEGER NOT NULL,destination_ordinal INTEGER NOT NULL,body TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(operation_id,source_ordinal),UNIQUE(destination_ordinal))",
        );
      },
      { kind: "read" },
    ),
    status: attempt(() => status() ?? null, { kind: "read" }),
    recoverySet: (id: string) =>
      attempt(
        () =>
          read(
            LibraryRecoverySet,
            "SELECT body FROM library_journal WHERE kind='set' AND id=?",
            id,
          ) ?? null,
        { kind: "read" },
      ),
    publication: (id: string, setId: string, codeDigest: string) =>
      attempt(
        () => {
          const published = read(
            LibraryRecoveryState,
            "SELECT body FROM library_journal WHERE kind='published' AND id=?",
            id,
          );

          if (published === undefined) return null;

          const operation = read(
            Operation,
            "SELECT body FROM library_journal WHERE kind='operation' AND id=?",
            id,
          );

          const outgoing = read(
            LibraryRecoverySet,
            "SELECT body FROM library_journal WHERE kind='set' AND id=?",
            id,
          );

          if (operation?.setId !== setId || outgoing?.codeDigest !== codeDigest)
            return fail("conflict");

          return published;
        },
        { kind: "read" },
      ),
    image: (id: string, ordinal: number) =>
      attempt(
        () =>
          read(
            LibraryObjectImage,
            "SELECT body FROM library_images WHERE set_id=? AND ordinal=?",
            id,
            ordinal,
          ) ?? null,
        { kind: "read" },
      ),
    authorizeCapture: (operationId: string, captureId: string, ordinal: number) =>
      attempt(
        () => {
          const state = ownedOperation(operationId);

          const operation = read(
            Operation,
            "SELECT body FROM library_journal WHERE kind='operation' AND id=?",
            operationId,
          );

          if (!["staging", "activating"].includes(state.phase) || operation?.setId !== captureId)
            return fail("fenced");

          const selected = read(
            LibraryRecoverySet,
            "SELECT body FROM library_journal WHERE kind='set' AND id=?",
            captureId,
          );

          const source = refAt(ordinal);

          if (
            selected === undefined ||
            selected.sourceLineage !== source.lineage ||
            selected.inventoryId !== state.inventoryId ||
            !["frozen", "retired"].includes(phaseOf(source.lineage))
          )
            return fail("fenced");

          return (
            read(
              LibraryObjectImage,
              "SELECT body FROM library_images WHERE set_id=? AND ordinal=?",
              captureId,
              ordinal,
            ) ?? fail("incomplete")
          );
        },
        { kind: "operation", operationId },
      ),
    progress: (operationId: string, ordinal: number) =>
      attempt(
        () => ({
          frozen:
            read(
              FreezeAck,
              "SELECT body FROM library_freezes WHERE operation_id=? AND ordinal=?",
              operationId,
              ordinal,
            ) ?? null,
          loaded:
            row(
              Schema.Struct({
                destination_ordinal: RecoveryOrdinal,
                active: Schema.Literals([0, 1]),
              }),
              "SELECT destination_ordinal,active FROM library_loads WHERE operation_id=? AND source_ordinal=?",
              operationId,
              ordinal,
            ) ?? null,
        }),
        { kind: "read" },
      ),
    initialize,
    finishImport: (inventoryId: string, allocatorFloor: number) =>
      attempt(() => {
        const state = current();

        if (state.inventoryId !== inventoryId || !Schema.is(RecoveryOrdinal)(allocatorFloor))
          return fail("invalid");
        const body = JSON.stringify({ inventoryId, allocatorFloor });
        immutable("import-complete", inventoryId, body);

        if (state.phase === "ready") return state;

        if (state.phase !== "importing") return fail("fenced");
        query("UPDATE library_lineages SET phase='active' WHERE lineage=?", state.lineage);

        return save({ ...state, phase: "ready", allocatorFloor });
      }),
    admit: (epoch: number) =>
      attempt(() => {
        const state = current();

        if (state.phase !== "ready" || state.epoch !== epoch) return fail("fenced");

        return { libraryId: "owner" as const, epoch: state.epoch, lineage: state.lineage };
      }),
    resolve: (epoch: number) =>
      attempt(
        () => {
          if (!Schema.is(RecoveryOrdinal)(epoch)) return fail("invalid");

          return (
            row(
              Schema.Struct({ lineage: LibraryLineage }),
              "SELECT lineage FROM library_lineages WHERE epoch=?",
              epoch,
            )?.lineage ?? fail("fenced")
          );
        },
        { kind: "read" },
      ),
    register: (ref: LibraryObjectRef, operationId: string | null = null) =>
      attempt(
        () => {
          if (!validateRef(ref)) return fail("invalid");
          const state = current();
          const phase = phaseOf(ref.lineage);

          const active =
            ref.lineage === state.lineage &&
            ((phase === "active" && state.phase === "ready") ||
              (phase === "importing" && state.phase === "importing"));

          const staging =
            operationId !== null &&
            operationId === state.operationId &&
            ref.lineage === state.stagingLineage &&
            ["staging", "activating"].includes(phase);

          if (!active && !staging) return fail("fenced");

          const matches = query(
            "SELECT ordinal,body FROM library_objects WHERE (class_name=? AND native_id=?) OR (lineage=? AND class_name=? AND logical_name=?)",
            ref.className,
            ref.nativeId,
            ref.lineage,
            ref.className,
            ref.logicalName,
          );

          if (matches.length > 1) return fail("conflict");

          const previous =
            matches[0] === undefined
              ? undefined
              : Schema.decodeUnknownSync(
                  Schema.Struct({ ordinal: RecoveryOrdinal, body: Schema.String }),
                )(matches[0]);

          if (previous !== undefined) {
            const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(LibraryObjectRef))(
              previous.body,
            );

            if (Struct.keys(LibraryObjectRef.fields).some((key) => decoded[key] !== ref[key]))
              return fail("conflict");

            return previous.ordinal;
          }

          if (phase === "activating") return fail("fenced");

          query(
            "INSERT INTO library_objects(class_name,native_id,lineage,logical_name,body) VALUES (?,?,?,?,?)",
            ref.className,
            ref.nativeId,
            ref.lineage,
            ref.logicalName,
            JSON.stringify(LibraryObjectRef.make(ref)),
          );

          return row(Ordinal, "SELECT last_insert_rowid() AS ordinal")!.ordinal;
        },
        operationId === null ? { kind: "normal" } : { kind: "operation", operationId },
      ),
    lookup: (className: string, nativeId: string) =>
      attempt(
        () => {
          if (!Schema.is(LibraryObjectClass)(className)) return fail("invalid");

          const found = row(
            Schema.Struct({ ordinal: RecoveryOrdinal, body: Schema.String }),
            "SELECT ordinal,body FROM library_objects WHERE class_name=? AND native_id=?",
            className,
            nativeId,
          );

          if (found === undefined) return null;
          const ref = Schema.decodeUnknownSync(Schema.fromJsonString(LibraryObjectRef))(found.body);

          return { ...ref, ordinal: found.ordinal, phase: phaseOf(ref.lineage) };
        },
        { kind: "read" },
      ),
    inventory: (lineage: string, after = 0) =>
      attempt(
        () => {
          if (!Schema.is(LibraryLineage)(lineage) || !Schema.is(RecoveryOrdinal)(after))
            return fail("invalid");
          const phase = phaseOf(lineage);

          return query(
            "SELECT ordinal,body FROM library_objects WHERE lineage=? AND ordinal>? ORDER BY ordinal LIMIT 64",
            lineage,
            after,
          ).map((value): RegisteredLibraryObject => {
            const item = Schema.decodeUnknownSync(
              Schema.Struct({ ordinal: RecoveryOrdinal, body: Schema.String }),
            )(value);

            return {
              ...Schema.decodeUnknownSync(Schema.fromJsonString(LibraryObjectRef))(item.body),
              ordinal: item.ordinal,
              phase,
            };
          });
        },
        { kind: "read" },
      ),
    beginFreeze: (operationId: string) =>
      attempt(
        () => {
          if (!Schema.is(RecoveryOperationId)(operationId)) return fail("invalid");
          const state = current();

          if (state.operationId === operationId) return state;

          if (state.phase !== "ready") return fail("fenced");

          if (
            read(
              Operation,
              "SELECT body FROM library_journal WHERE kind='operation' AND id=?",
              operationId,
            )
          )
            return fail("conflict");
          immutable("operation", operationId, JSON.stringify({ setId: null }));
          query("UPDATE library_lineages SET phase='frozen' WHERE lineage=?", state.lineage);

          return save({ ...state, operationId, phase: "frozen" });
        },
        { kind: "begin", operationId },
      ),
    acknowledgeFreeze: (
      operationId: string,
      ordinal: number,
      before: string,
      after: string | null,
    ) =>
      attempt(
        () => {
          const state = ownedOperation(operationId);
          const ref = refAt(ordinal);

          if (state.phase !== "frozen" || ref.lineage !== state.lineage) return fail("fenced");

          if (!Schema.is(FreezeAck)({ before, after }) || before === after) return fail("invalid");

          const previous = read(
            FreezeAck,
            "SELECT body FROM library_freezes WHERE operation_id=? AND ordinal=?",
            operationId,
            ordinal,
          );

          if (previous === undefined && after !== null) return fail("incomplete");

          if (previous?.before !== undefined && previous.before !== before) return fail("conflict");

          // A lost acknowledgement or a later admin-only restart cannot downgrade
          // the first persisted proof of a distinct frozen constructor.
          if (previous?.after != null) return;

          query(
            "INSERT OR REPLACE INTO library_freezes VALUES (?,?,?)",
            operationId,
            ordinal,
            JSON.stringify({ before, after }),
          );
        },
        { kind: "operation", operationId },
      ),
    recordImage: (operationId: string, ordinal: number, image: LibraryObjectImage) =>
      attempt(
        () => {
          const state = ownedOperation(operationId);
          const ref = refAt(ordinal);

          const ack = read(
            FreezeAck,
            "SELECT body FROM library_freezes WHERE operation_id=? AND ordinal=?",
            operationId,
            ordinal,
          );

          if (state.phase !== "frozen" || ref.lineage !== state.lineage || !ack?.after)
            return fail("fenced");

          if (!Schema.is(LibraryObjectImage)(image)) return fail("invalid");
          const body = JSON.stringify(LibraryObjectImage.make(image));

          const previous = row(
            Body,
            "SELECT body FROM library_images WHERE set_id=? AND ordinal=?",
            operationId,
            ordinal,
          );

          if (previous && previous.body !== body) return fail("conflict");
          query("INSERT OR IGNORE INTO library_images VALUES (?,?,?)", operationId, ordinal, body);
        },
        { kind: "operation", operationId },
      ),
    seal: (operationId: string, allocatorFloor: number, codeDigest: string) =>
      attempt(
        () => {
          const state = ownedOperation(operationId);

          if (state.phase !== "frozen") return fail("fenced");

          if (!Schema.is(RecoveryOrdinal)(allocatorFloor) || !Schema.is(RecoveryDigest)(codeDigest))
            return fail("invalid");

          const objectCount = count(
            "SELECT COUNT(*) AS count FROM library_objects WHERE lineage=?",
            state.lineage,
          );

          const imageCount = count(
            "SELECT COUNT(*) AS count FROM library_images WHERE set_id=?",
            operationId,
          );

          if (objectCount === 0 || objectCount !== imageCount) return fail("incomplete");
          const floor = Math.max(state.allocatorFloor, allocatorFloor);

          const captured = LibraryRecoverySet.make({
            id: operationId,
            sourceLineage: state.lineage,
            inventoryId: state.inventoryId,
            allocatorFloor: floor,
            objectCount,
            codeDigest,
          });

          immutable("set", operationId, JSON.stringify(captured));
          save({ ...state, allocatorFloor: floor });

          return captured;
        },
        { kind: "operation", operationId },
      ),
    prepareRestore: (operationId: string, setId: string) =>
      attempt(
        () => {
          const state = ownedOperation(operationId);

          const operation = read(
            Operation,
            "SELECT body FROM library_journal WHERE kind='operation' AND id=?",
            operationId,
          )!;

          if (operation.setId !== null && operation.setId !== setId) return fail("conflict");

          if (state.stagingLineage !== null) return state;

          if (state.phase !== "frozen") return fail("fenced");

          const outgoing = read(
            LibraryRecoverySet,
            "SELECT body FROM library_journal WHERE kind='set' AND id=?",
            operationId,
          );

          const selected = read(
            LibraryRecoverySet,
            "SELECT body FROM library_journal WHERE kind='set' AND id=?",
            setId,
          );

          if (!outgoing || !selected) return fail("incomplete");

          if (
            outgoing.codeDigest !== selected.codeDigest ||
            selected.inventoryId !== state.inventoryId
          )
            return fail("conflict");
          const nextLineage = increment(state.nextLineage);
          const stagingLineage = LibraryLineage.make(`library-${state.nextLineage}`);
          query(
            "INSERT INTO library_lineages VALUES (?,?,'staging')",
            stagingLineage,
            state.nextLineage,
          );
          query(
            "UPDATE library_journal SET body=? WHERE kind='operation' AND id=?",
            JSON.stringify({ setId }),
            operationId,
          );

          return save({ ...state, stagingLineage, nextLineage, phase: "staging" });
        },
        { kind: "operation", operationId },
      ),
    recordLoaded: (
      operationId: string,
      sourceOrdinal: number,
      destinationOrdinal: number,
      image: LibraryObjectImage,
    ) =>
      attempt(
        () => {
          const state = ownedOperation(operationId);

          if (state.phase !== "staging") return fail("fenced");

          const operation = read(
            Operation,
            "SELECT body FROM library_journal WHERE kind='operation' AND id=?",
            operationId,
          )!;

          const selected = read(
            LibraryRecoverySet,
            "SELECT body FROM library_journal WHERE kind='set' AND id=?",
            operation.setId,
          )!;

          const source = refAt(sourceOrdinal);
          const destination = refAt(destinationOrdinal);

          if (
            source.lineage !== selected.sourceLineage ||
            destination.lineage !== state.stagingLineage ||
            source.className !== destination.className ||
            source.logicalName !== destination.logicalName
          )
            return fail("invalid");

          const expected = row(
            Body,
            "SELECT body FROM library_images WHERE set_id=? AND ordinal=?",
            operation.setId,
            sourceOrdinal,
          )?.body;

          const body = JSON.stringify(LibraryObjectImage.make(image));

          if (expected !== body) return fail("conflict");

          const previous = row(
            Schema.Struct({ destination_ordinal: RecoveryOrdinal, body: Schema.String }),
            "SELECT destination_ordinal,body FROM library_loads WHERE operation_id=? AND source_ordinal=?",
            operationId,
            sourceOrdinal,
          );

          if (
            previous &&
            (previous.destination_ordinal !== destinationOrdinal || previous.body !== body)
          )
            return fail("conflict");
          query(
            "INSERT OR IGNORE INTO library_loads(operation_id,source_ordinal,destination_ordinal,body) VALUES (?,?,?,?)",
            operationId,
            sourceOrdinal,
            destinationOrdinal,
            body,
          );
        },
        { kind: "operation", operationId },
      ),
    beginActivation: (operationId: string) =>
      attempt(
        () => {
          const state = ownedOperation(operationId);

          if (state.phase === "activating") return state;

          if (state.phase !== "staging") return fail("fenced");

          const operation = read(
            Operation,
            "SELECT body FROM library_journal WHERE kind='operation' AND id=?",
            operationId,
          )!;

          const selected = read(
            LibraryRecoverySet,
            "SELECT body FROM library_journal WHERE kind='set' AND id=?",
            operation.setId,
          )!;

          const loaded = count(
            "SELECT COUNT(*) AS count FROM library_loads WHERE operation_id=?",
            operationId,
          );

          const destinations = count(
            "SELECT COUNT(*) AS count FROM library_objects WHERE lineage=?",
            state.stagingLineage,
          );

          if (loaded !== selected.objectCount || destinations !== selected.objectCount)
            return fail("incomplete");
          query(
            "UPDATE library_lineages SET phase='activating' WHERE lineage=?",
            state.stagingLineage,
          );

          return save({ ...state, phase: "activating" });
        },
        { kind: "operation", operationId },
      ),
    acknowledgeActive: (operationId: string, destinationOrdinal: number) =>
      attempt(
        () => {
          const state = ownedOperation(operationId);

          if (
            state.phase !== "activating" ||
            refAt(destinationOrdinal).lineage !== state.stagingLineage
          )
            return fail("fenced");
          query(
            "UPDATE library_loads SET active=1 WHERE operation_id=? AND destination_ordinal=?",
            operationId,
            destinationOrdinal,
          );
        },
        { kind: "operation", operationId },
      ),
    publish: (operationId: string, verifiedFloor: number) =>
      Effect.flatMap(
        attempt(
          () =>
            read(
              LibraryRecoveryState,
              "SELECT body FROM library_journal WHERE kind='published' AND id=?",
              operationId,
            ),
          { kind: "read" },
        ),
        (completed) =>
          completed !== undefined
            ? Effect.succeed(completed)
            : attempt(
                () => {
                  const state = ownedOperation(operationId);

                  if (state.phase !== "activating" || state.stagingLineage === null)
                    return fail("fenced");

                  if (
                    !Schema.is(RecoveryOrdinal)(verifiedFloor) ||
                    verifiedFloor < state.allocatorFloor
                  )
                    return fail("incomplete");

                  const operation = read(
                    Operation,
                    "SELECT body FROM library_journal WHERE kind='operation' AND id=?",
                    operationId,
                  )!;

                  const selected = read(
                    LibraryRecoverySet,
                    "SELECT body FROM library_journal WHERE kind='set' AND id=?",
                    operation.setId,
                  )!;

                  const active = count(
                    "SELECT COUNT(*) AS count FROM library_loads WHERE operation_id=? AND active=1",
                    operationId,
                  );

                  const destinations = count(
                    "SELECT COUNT(*) AS count FROM library_objects WHERE lineage=?",
                    state.stagingLineage,
                  );

                  if (active !== selected.objectCount || destinations !== selected.objectCount)
                    return fail("incomplete");

                  const epoch = row(
                    Schema.Struct({ epoch: RecoveryOrdinal }),
                    "SELECT epoch FROM library_lineages WHERE lineage=?",
                    state.stagingLineage,
                  )!.epoch;

                  query(
                    "UPDATE library_lineages SET phase='retired' WHERE lineage=?",
                    state.lineage,
                  );
                  query(
                    "UPDATE library_lineages SET phase='active' WHERE lineage=?",
                    state.stagingLineage,
                  );

                  const published = save({
                    ...state,
                    epoch,
                    lineage: state.stagingLineage,
                    stagingLineage: null,
                    phase: "ready",
                    operationId: null,
                    allocatorFloor: verifiedFloor,
                  });

                  immutable("published", operationId, JSON.stringify(published));

                  return published;
                },
                { kind: "operation", operationId },
              ),
      ),
  };
};

export class LibraryRecoveryStore extends Context.Service<
  LibraryRecoveryStore,
  ReturnType<typeof makeLibraryRecoveryStore>
>()("@kitties/gateway/LibraryRecoveryStore") {
  static readonly layer = (database: LibraryControlDatabase, authority: LibraryRecoveryAuthority) =>
    Layer.effect(
      LibraryRecoveryStore,
      Effect.gen(function* () {
        const store = makeLibraryRecoveryStore(database, authority);
        yield* store.setup;

        return store;
      }),
    );
}
