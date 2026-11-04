import { guardedActivities } from "../recovery-guard.ts";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import { WorkflowEngine } from "effect/workflow";
import { HomeDO, ChatDO, KittyDO } from "../actors.ts";
import { RecoveryDO } from "../recovery-store.ts";
import { Purge } from "../recovery-definition.ts";
import { workflowActor } from "../workflow-admin.ts";

const activity = guardedActivities(Effect.void);

export const PurgeLive = Workflows.layer(
  Purge,
  Effect.gen(function* () {
    const roots = yield* RecoveryDO,
      homes = yield* HomeDO,
      chats = yield* ChatDO,
      kitties = yield* KittyDO,
      engine = yield* WorkflowEngine.WorkflowEngine;

    // SAFETY: Gateway declares these bindings in worker.ts and Alchemy supplies them to workflows.
    const env = (yield* Cloudflare.WorkerEnvironment) as { KITTIES_KEK: string };

    return Effect.fn(function* ({ id, before }, executionId) {
      const root = roots.getByName("control", { locationHint: "weur" });
      yield* activity({
        name: "started",
        error: Schema.String,
        execute: root
          .save(
            "purge",
            id,
            JSON.stringify({ id, before, executionId, status: "running", at: Date.now() }),
          )
          .pipe(Effect.mapError(() => "STORAGE_UNAVAILABLE")),
      });

      // SAFETY: The registry activity below serializes RecoveryDO.objects, whose rows have kind and name.
      const objects = JSON.parse(
        yield* activity({
          name: "registry",
          success: Schema.String,
          error: Schema.String,
          execute: root.objects().pipe(
            Effect.map(JSON.stringify),
            Effect.mapError(() => "STORAGE_UNAVAILABLE"),
          ),
        }),
      ) as { kind: string; name: string }[];

      for (const o of objects) {
        yield* activity({
          name: `purge/${o.kind}/${o.name}`,
          error: Schema.String,
          execute: Effect.gen(function* () {
            const actor = Match.value(o.kind).pipe(
              Match.when("workflow", () => workflowActor(engine, o.name, env.KITTIES_KEK)),
              Match.when("home", () => homes.getByName(o.name)),
              Match.when("kitty", () => kitties.getByName(o.name)),
              Match.orElse(() => chats.getByName(o.name)),
            );

            const purge: Effect.Effect<boolean | void, string> = actor.adminPurge(before);

            yield* purge.pipe(Effect.mapError(() => "PURGE_UNAVAILABLE"));
          }),
        });
      }

      yield* activity({
        name: "complete",
        error: Schema.String,
        execute: root
          .save(
            "purge",
            id,
            JSON.stringify({
              id,
              before,
              executionId,
              objects: objects.length,
              status: "completed",
              at: Date.now(),
            }),
          )
          .pipe(Effect.mapError(() => "STORAGE_UNAVAILABLE")),
      });

      return objects.length;
    });
  }),
);
