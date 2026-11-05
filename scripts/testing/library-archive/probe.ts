import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ArchiveBoundary } from "./protocol.ts";

export class ArchiveDeliveryHeld extends Schema.TaggedError<
  ArchiveDeliveryHeld,
  { readonly brand: unique symbol }
>()("ArchiveDeliveryHeld", {}) {}

/** Test milestones only. The production journal remains the sole recovery owner. */
export class LibraryArchiveProbe extends Cloudflare.DurableObject<LibraryArchiveProbe>()(
  "LibraryArchiveProbe",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.sync(() => {
      const sql = state.raw.storage.sql;
      sql.exec(
        "CREATE TABLE IF NOT EXISTS archive_probe (key TEXT PRIMARY KEY,body TEXT NOT NULL)",
      );
      const waiters = new Map<string, Set<(body: string) => void>>();

      const read = (key: string) =>
        sql.exec<{ body: string }>("SELECT body FROM archive_probe WHERE key=?", key).toArray()[0]
          ?.body;

      return {
        arm: (boundary: typeof ArchiveBoundary.Type | null) =>
          Effect.sync(() => {
            sql.exec("DELETE FROM archive_probe WHERE key='armed'");

            if (boundary !== null) {
              sql.exec("DELETE FROM archive_probe WHERE key=?", `hit:${boundary}`);
              sql.exec("INSERT INTO archive_probe VALUES ('armed',?)", boundary);
            }
          }),
        hit: (boundary: typeof ArchiveBoundary.Type, evidence: Schema.Json) =>
          Effect.suspend(() => {
            if (read("armed") !== boundary) return Effect.void;
            const key = `hit:${boundary}`;
            const body = JSON.stringify(evidence);
            sql.exec("INSERT OR REPLACE INTO archive_probe VALUES (?,?)", key, body);

            for (const resume of waiters.get(key) ?? []) resume(body);
            waiters.delete(key);

            return Effect.never;
          }),
        wait: (boundary: typeof ArchiveBoundary.Type) =>
          Effect.callback<string>((resume) => {
            const key = `hit:${boundary}`;
            const existing = read(key);

            if (existing !== undefined) {
              resume(Effect.succeed(existing));

              return;
            }

            const waiting = waiters.get(key) ?? new Set();
            const done = (body: string) => resume(Effect.succeed(body));
            waiting.add(done);
            waiters.set(key, waiting);

            return Effect.sync(() => {
              waiting.delete(done);

              if (waiting.size === 0) waiters.delete(key);
            });
          }),
        gateDelivery: (key: string | null) =>
          Effect.sync(() => {
            sql.exec("DELETE FROM archive_probe WHERE key='delivery'");

            if (key !== null) sql.exec("INSERT INTO archive_probe VALUES ('delivery',?)", key);
          }),
        checkDelivery: (key: string) =>
          Effect.suspend(() =>
            read("delivery") === key ? new ArchiveDeliveryHeld() : Effect.void,
          ),
        count: (metric: "remote-get" | "remote-put" | "local-read") =>
          Effect.sync(() => {
            sql.exec(
              "INSERT INTO archive_probe VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET body=CAST(CAST(body AS INTEGER)+1 AS TEXT)",
              `metric:${metric}`,
            );
          }),
        metrics: () =>
          Effect.sync(() => ({
            remoteGet: Number(read("metric:remote-get") ?? "0"),
            remotePut: Number(read("metric:remote-put") ?? "0"),
            localRead: Number(read("metric:local-read") ?? "0"),
          })),
      };
    });
  }),
) {}
