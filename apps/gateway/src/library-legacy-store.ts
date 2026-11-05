import type * as Cloudflare from "@cloudflare/workers-types";
import {
  ImportInventoryId,
  MAX_SKILL_JSON_BYTES,
  SkillTimestamp,
} from "@kitties/domain/Library/Skill";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  LibraryRecoveryError,
  LibraryRecoveryState,
  RecoveryOrdinal,
} from "./library-recovery-records.ts";

/** This is control-plane authority, separate from ready-only public admission. */
export class LibraryMigrationControl extends Context.Service<
  LibraryMigrationControl,
  {
    readonly status: Effect.Effect<LibraryRecoveryState | null, LibraryRecoveryError>;
    readonly initialize: (
      inventoryId: string,
    ) => Effect.Effect<LibraryRecoveryState, LibraryRecoveryError>;
    readonly finishImport: (
      inventoryId: string,
      allocatorFloor: number,
    ) => Effect.Effect<LibraryRecoveryState, LibraryRecoveryError>;
  }
>()("@kitties/gateway/LibraryMigrationControl") {}

export interface LibraryLegacyDatabase {
  readonly query: (
    statement: string,
    ...bindings: ReadonlyArray<string | number | null>
  ) => ReadonlyArray<Schema.JsonObject>;
  readonly transaction: <A>(body: () => A) => A;
}

export const nativeLibraryLegacyDatabase = (
  storage: Pick<Cloudflare.DurableObjectStorage, "sql" | "transactionSync">,
): LibraryLegacyDatabase => ({
  query: (statement, ...bindings) =>
    Schema.decodeUnknownSync(Schema.Array(Schema.JsonObject))(
      storage.sql.exec(statement, ...bindings).toArray(),
    ),
  transaction: (body) => storage.transactionSync(body),
});

export class LibraryLegacyError extends Schema.TaggedError<
  LibraryLegacyError,
  { readonly brand: unique symbol }
>()("LibraryLegacyError", {
  reason: Schema.Literals([
    "invalid",
    "limit",
    "frozen",
    "missing",
    "conflict",
    "storage",
    "authority",
  ]),
  ordinal: Schema.optional(RecoveryOrdinal),
}) {}

export const LegacyInventory = Schema.Struct({
  inventoryId: ImportInventoryId,
  rowCount: RecoveryOrdinal,
  bytes: RecoveryOrdinal,
  fallbackCount: RecoveryOrdinal,
});

export type LegacyInventory = typeof LegacyInventory.Type;

export const LegacyInventoryRow = Schema.Struct({
  ordinal: RecoveryOrdinal,
  id: Schema.String,
  body: Schema.String,
  updatedAt: SkillTimestamp,
});

export type LegacyInventoryRow = typeof LegacyInventoryRow.Type;

export const LibraryLegacyStatus = Schema.Struct({
  authority: Schema.NullOr(LibraryRecoveryState),
  frozen: Schema.Boolean,
  inventory: Schema.NullOr(LegacyInventory),
});

export type LibraryLegacyStatus = typeof LibraryLegacyStatus.Type;

const Marker = Schema.Struct({ ...LegacyInventory.fields, materialized: Schema.Literals([0, 1]) });

const Limits = Schema.Struct({
  maxRows: RecoveryOrdinal,
  maxBytes: RecoveryOrdinal,
  controlTimeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
});

export type LibraryLegacyLimits = typeof Limits.Type;

export const DEFAULT_LIBRARY_LEGACY_LIMITS: LibraryLegacyLimits = {
  maxRows: 65536,
  maxBytes: 512 * 1024 * 1024,
  controlTimeoutMs: 5000,
};

export const LEGACY_INVENTORY_PAGE_SIZE = 64;
export const LEGACY_INVENTORY_PAGE_BYTES = 2 * 1024 * 1024;

export class LibraryLegacyStore extends Context.Service<
  LibraryLegacyStore,
  {
    readonly status: Effect.Effect<LibraryLegacyStatus, LibraryLegacyError>;
    readonly freeze: (inventoryId: string) => Effect.Effect<LegacyInventory, LibraryLegacyError>;
    readonly inventory: (inventoryId: string) => Effect.Effect<LegacyInventory, LibraryLegacyError>;
    readonly page: (
      inventoryId: string,
      afterOrdinal: number,
    ) => Effect.Effect<ReadonlyArray<LegacyInventoryRow>, LibraryLegacyError>;
    readonly writeSkill: (
      id: string,
      body: string,
      updatedAt: number,
    ) => Effect.Effect<void, LibraryLegacyError>;
    readonly removeSkill: (id: string) => Effect.Effect<void, LibraryLegacyError>;
  }
>()("@kitties/gateway/LibraryLegacyStore") {
  static readonly layer = (
    database: LibraryLegacyDatabase,
    limits: LibraryLegacyLimits = DEFAULT_LIBRARY_LEGACY_LIMITS,
  ) =>
    Layer.effect(
      LibraryLegacyStore,
      Effect.gen(function* () {
        const policy = yield* Schema.decodeUnknownEffect(Limits)(limits).pipe(
          Effect.mapError(() => new LibraryLegacyError({ reason: "invalid" })),
        );

        const control = yield* LibraryMigrationControl;
        const query = database.query;

        const fail = (reason: LibraryLegacyError["reason"], ordinal?: number): never => {
          throw new LibraryLegacyError({ reason, ordinal });
        };

        const attempt = <A>(body: () => A) =>
          Effect.try({
            try: () => database.transaction(body),
            catch: (cause) =>
              Schema.is(LibraryLegacyError)(cause)
                ? cause
                : new LibraryLegacyError({ reason: "storage" }),
          });

        const marker = () => {
          const row = query(
            "SELECT inventory_id AS inventoryId,row_count AS rowCount,bytes,fallback_count AS fallbackCount,materialized FROM library_legacy_marker WHERE id=1",
          )[0];

          return row === undefined ? undefined : Schema.decodeUnknownSync(Marker)(row);
        };

        const getInventory = (inventoryId: string) => {
          if (!Schema.is(ImportInventoryId)(inventoryId)) return fail("invalid");
          const found = marker();

          if (found === undefined || found.materialized === 0) return fail("missing");

          if (found.inventoryId !== inventoryId) return fail("conflict");

          return LegacyInventory.make({
            inventoryId: found.inventoryId,
            rowCount: found.rowCount,
            bytes: found.bytes,
            fallbackCount: found.fallbackCount,
          });
        };

        yield* attempt(() => {
          query(
            "CREATE TABLE IF NOT EXISTS library_legacy_marker (id INTEGER PRIMARY KEY CHECK(id=1),inventory_id TEXT NOT NULL,row_count INTEGER NOT NULL,bytes INTEGER NOT NULL,fallback_count INTEGER NOT NULL,materialized INTEGER NOT NULL)",
          );
          query(
            "CREATE TABLE IF NOT EXISTS library_legacy_inventory (ordinal INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,body TEXT NOT NULL,updated_at INTEGER NOT NULL)",
          );
        });

        // Table setup does not start migration. A restored Home cannot infer that
        // legacy writes are safe merely because its own marker disappeared.
        const status = Effect.gen(function* () {
          const authoritative = yield* control.status.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.NullOr(LibraryRecoveryState))),
            Effect.timeoutOrElse({
              duration: policy.controlTimeoutMs,
              orElse: () => new LibraryLegacyError({ reason: "authority" }),
            }),
            Effect.mapError(() => new LibraryLegacyError({ reason: "authority" })),
          );

          return yield* attempt(() => {
            if (authoritative !== null && marker() === undefined)
              query(
                "INSERT INTO library_legacy_marker VALUES (1,?,0,0,0,0)",
                authoritative.inventoryId,
              );
            const found = marker();

            return LibraryLegacyStatus.make({
              authority: authoritative,
              frozen: found !== undefined,
              inventory: found?.materialized === 1 ? getInventory(found.inventoryId) : null,
            });
          });
        });

        yield* status;

        const writable = () => {
          if (marker() !== undefined) fail("frozen");
        };

        return LibraryLegacyStore.of({
          status,
          inventory: (inventoryId) => attempt(() => getInventory(inventoryId)),
          freeze: (inventoryId) =>
            attempt(() => {
              if (!Schema.is(ImportInventoryId)(inventoryId)) return fail("invalid");

              if (marker() !== undefined) return getInventory(inventoryId);

              const summary = Schema.decodeUnknownSync(
                Schema.Struct({
                  rowCount: RecoveryOrdinal,
                  bytes: RecoveryOrdinal,
                  fallbackCount: RecoveryOrdinal,
                }),
              )(
                query(
                  "SELECT COUNT(*) AS rowCount,COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes,COALESCE(SUM(CASE WHEN json_valid(body) THEN CASE WHEN json_type(body,'$.updatedAt') IS NULL THEN 1 ELSE 0 END ELSE 0 END),0) AS fallbackCount FROM records WHERE kind='skill'",
                )[0],
              );

              if (summary.rowCount > policy.maxRows || summary.bytes > policy.maxBytes)
                return fail("limit");
              query(
                "INSERT INTO library_legacy_inventory SELECT ROW_NUMBER() OVER (ORDER BY id COLLATE BINARY),id,body,updated_at FROM records WHERE kind='skill'",
              );
              query(
                "INSERT INTO library_legacy_marker VALUES (1,?,?,?,?,1)",
                inventoryId,
                summary.rowCount,
                summary.bytes,
                summary.fallbackCount,
              );

              return LegacyInventory.make({ inventoryId, ...summary });
            }),
          page: (inventoryId, afterOrdinal) =>
            attempt(() => {
              getInventory(inventoryId);

              if (!Schema.is(RecoveryOrdinal)(afterOrdinal)) return fail("invalid");

              // Check sizes in SQL before materializing bodies in the isolate. An
              // invalid giant row must fail visibly rather than become a huge page.
              const sizes = Schema.decodeUnknownSync(
                Schema.Array(
                  Schema.Struct({
                    ordinal: RecoveryOrdinal,
                    bytes: RecoveryOrdinal,
                    idBytes: RecoveryOrdinal,
                    jsonValid: Schema.Literals([0, 1]),
                    idValid: Schema.Literals([0, 1]),
                  }),
                ),
              )(
                query(
                  "SELECT ordinal,length(CAST(body AS BLOB)) AS bytes,length(CAST(id AS BLOB)) AS idBytes,(json_valid(body) AND instr(body,char(0))=0) AS jsonValid,CASE WHEN length(id) BETWEEN 1 AND 128 AND length(CAST(id AS BLOB))=length(id) AND id NOT GLOB '*[^a-zA-Z0-9_-]*' THEN 1 ELSE 0 END AS idValid FROM library_legacy_inventory WHERE ordinal>? ORDER BY ordinal LIMIT 64",
                  afterOrdinal,
                ),
              );

              let pageBytes = 0;
              let endOrdinal = afterOrdinal;

              for (const row of sizes) {
                if (row.idBytes > 128 || row.idValid !== 1) return fail("invalid", row.ordinal);

                if (row.bytes > MAX_SKILL_JSON_BYTES) return fail("limit", row.ordinal);

                if (row.jsonValid !== 1) return fail("invalid", row.ordinal);
                // JSON encoding the already-JSON body can double quote/backslash
                // bytes. Reserve that worst case plus the row's fixed envelope.
                const wireBytes = 2 * (row.bytes + row.idBytes) + 128;

                if (pageBytes + wireBytes > LEGACY_INVENTORY_PAGE_BYTES) break;
                pageBytes += wireBytes;
                endOrdinal = row.ordinal;
              }

              return query(
                "SELECT ordinal,id,body,updated_at AS updatedAt FROM library_legacy_inventory WHERE ordinal>? AND ordinal<=? ORDER BY ordinal LIMIT 64",
                afterOrdinal,
                endOrdinal,
              ).map((row) => {
                const ordinal = Schema.decodeUnknownSync(
                  Schema.Struct({ ordinal: RecoveryOrdinal }),
                )(row).ordinal;

                const decoded = Schema.decodeUnknownExit(LegacyInventoryRow)(row);

                if (Exit.isFailure(decoded)) return fail("invalid", ordinal);

                return decoded.value;
              });
            }),
          writeSkill: (id, body, updatedAt) =>
            attempt(() => {
              writable();
              query(
                "INSERT INTO records (kind,id,body,updated_at) VALUES ('skill',?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at",
                id,
                body,
                updatedAt,
              );
            }),
          removeSkill: (id) =>
            attempt(() => {
              writable();
              query("DELETE FROM records WHERE kind='skill' AND id=?", id);
            }),
        });
      }),
    );
}
