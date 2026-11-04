import { guardedActivities } from "../recovery-guard.ts";
import { workflowActor } from "../workflow-admin.ts";
import { WorkflowEngine } from "effect/workflow";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as cf from "@cloudflare/workers-types";
import { DurableClock } from "effect/workflow";
import { HomeDO, ChatDO, KittyDO } from "../actors.ts";
import { RecoveryDO } from "../recovery-store.ts";
import { Export } from "../recovery-definition.ts";
import { seal } from "../secrets.ts";

const activity = guardedActivities(Effect.void);
const storage = () => "EXPORT_UNAVAILABLE";

interface Snapshot {
  kind: string;
  name: string;
  bookmark: string;
  tables: { table: string; rows: number }[];
}

export const ExportLive = Workflows.layer(
  Export,
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine;

    const roots = yield* RecoveryDO,
      homes = yield* HomeDO,
      chats = yield* ChatDO,
      kitties = yield* KittyDO;

    const env = (yield* Cloudflare.WorkerEnvironment) as {
      EXPORTS: cf.R2Bucket;
      KITTIES_KEK: string;
    };

    const actor = (kind: string, name: string) =>
      kind === "workflow"
        ? workflowActor(engine, name, env.KITTIES_KEK)
        : kind === "home"
          ? homes.getByName(name, { locationHint: "weur" })
          : kind === "kitty"
            ? kitties.getByName(name, { locationHint: "weur" })
            : chats.getByName(name, { locationHint: "weur" });

    return Effect.fn(function* ({ id }, executionId) {
      const root = roots.getByName("control", { locationHint: "weur" }),
        prefix = `exports/${id}`;

      const captures = yield* activity({
        name: "capture",
        success: Schema.String,
        error: Schema.String,
        execute: Effect.gen(function* () {
          yield* root
            .save(
              "export",
              id,
              JSON.stringify({ id, executionId, status: "running", at: Date.now(), prefix }),
            )
            .pipe(Effect.mapError(storage));
          const snapshots: Snapshot[] = [];

          for (const o of yield* root.objects().pipe(Effect.mapError(storage))) {
            const a = actor(o.kind, o.name),
              capture = JSON.parse(yield* a.adminCapture(id).pipe(Effect.mapError(storage))) as {
                tables: Snapshot["tables"];
              };

            snapshots.push({
              ...o,
              ...capture,
              bookmark: yield* a.adminBookmark().pipe(Effect.mapError(storage)),
            });
          }

          return JSON.stringify(snapshots);
        }),
      });

      const snapshots = JSON.parse(captures) as Snapshot[];
      let parts = 0;

      for (const o of snapshots)
        for (const table of o.tables)
          for (let row = 1; row <= table.rows; row++) {
            for (let part = 0; part < 1000; part++) {
              const key = `${prefix}/${o.kind}/${o.name}/${table.table}/${row}/${part}.jsonl`,
                aad = `kitties-export-v1:${key}`;

              const last = yield* activity({
                name: `part/${o.kind}/${o.name}/${table.table}/${row}/${part}`,
                success: Schema.Boolean,
                error: Schema.String,
                execute: Effect.gen(function* () {
                  const existing = yield* Effect.tryPromise({
                    try: () => env.EXPORTS.head(key),
                    catch: storage,
                  });

                  if (existing) return existing.customMetadata?.last === "true";

                  const value = yield* actor(o.kind, o.name)
                    .adminExportPart(id, table.table, row, part, aad)
                    .pipe(Effect.mapError(storage));

                  yield* Effect.tryPromise({
                    try: () =>
                      env.EXPORTS.put(key, value.body + "\n", {
                        httpMetadata: { contentType: "application/x-ndjson" },
                        customMetadata: { last: String(value.last), format: "kitties-export-v1" },
                      }),
                    catch: storage,
                  });

                  return value.last;
                }),
              });

              parts++;

              if (parts % 50 === 0) {
                yield* activity({
                  name: `progress/${parts}`,
                  error: Schema.String,
                  execute: root
                    .save(
                      "export",
                      id,
                      JSON.stringify({
                        id,
                        executionId,
                        status: "running",
                        at: Date.now(),
                        prefix,
                        parts,
                        objects: snapshots.length,
                        capturedRows: snapshots.reduce(
                          (total, snapshot) =>
                            total + snapshot.tables.reduce((n, t) => n + t.rows, 0),
                          0,
                        ),
                      }),
                    )
                    .pipe(Effect.mapError(storage)),
                });
                yield* DurableClock.sleep({
                  name: `segment/${parts}`,
                  duration: "1 millis",
                  inMemoryThreshold: 0,
                });
              }

              if (last) break;

              if (part === 999) return yield* Effect.fail("EXPORT_ROW_LIMIT");
            }
          }

      yield* activity({
        name: "manifest",
        error: Schema.String,
        execute: Effect.gen(function* () {
          const key = `${prefix}/manifest.jsonl`,
            aad = `kitties-export-v1:${key}`;

          if (!(yield* Effect.tryPromise({ try: () => env.EXPORTS.head(key), catch: storage }))) {
            const body = yield* Effect.tryPromise({
              try: () =>
                seal(
                  env.KITTIES_KEK,
                  aad,
                  JSON.stringify({ version: 1, id, snapshots, parts, at: Date.now() }),
                ),
              catch: storage,
            });

            yield* Effect.tryPromise({
              try: () =>
                env.EXPORTS.put(key, JSON.stringify(body) + "\n", {
                  httpMetadata: { contentType: "application/x-ndjson" },
                }),
              catch: storage,
            });
          }

          yield* root
            .save(
              "export",
              id,
              JSON.stringify({
                id,
                executionId,
                status: "completed",
                at: Date.now(),
                prefix,
                parts,
                objects: snapshots.length,
                retentionDays: 90,
                lockedDays: 30,
              }),
            )
            .pipe(Effect.mapError(storage));
        }),
      });

      return id;
    });
  }),
);
