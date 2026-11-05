import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import {
  encodeLibraryValue,
  libraryImageBytes,
  libraryImageDigest,
} from "../../../apps/gateway/src/library-image.ts";
import { LibraryRecoveryError } from "../../../apps/gateway/src/library-recovery-records.ts";

/** Raw native observations only; never holds or changes callback scheduling. */
export const observeNativeProtection = Effect.fnUntraced(function* (
  storage: cf.DurableObjectStorage,
) {
  const alarm = yield* Effect.promise(() => storage.getAlarm());
  const kv = [...storage.kv.list({ limit: 1025 })];

  if (kv.length > 1024) return yield* new LibraryRecoveryError({ reason: "exhausted" });

  const tables = [
    "alchemy_alarm_callbacks",
    "alchemy_alarm_schema",
    "alchemy_scheduled_events",
    "library_admin_guard",
    "library_admin_hold_alchemy_alarm_callbacks",
    "library_admin_hold_alchemy_alarm_schema",
    "library_admin_hold_alchemy_scheduled_events",
  ].map((table) => {
    const exists = storage.sql
      .exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table)
      .toArray().length;

    if (exists === 0) return { table, rows: [] };

    const rows = storage.sql.exec(`SELECT * FROM ${table} ORDER BY rowid LIMIT 1025`).toArray();

    if (rows.length > 1024) throw new LibraryRecoveryError({ reason: "exhausted" });

    return { table, rows };
  });

  const encoded = encodeLibraryValue({ kv, alarm, tables });

  if (libraryImageBytes(encoded) > 4 * 1024 * 1024)
    return yield* new LibraryRecoveryError({ reason: "exhausted" });

  const digest = yield* libraryImageDigest(encoded).pipe(
    Effect.mapError(() => new LibraryRecoveryError({ reason: "storage" })),
  );

  return { digest, alarm };
});
