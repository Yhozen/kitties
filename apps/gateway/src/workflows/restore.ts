import * as Schedule from "effect/Schedule";
import { guardedActivities, permitCacheMs } from "../recovery-guard.ts";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { workflowActor } from "../workflow-admin.ts";
import { DurableClock, WorkflowEngine } from "effect/workflow";
import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HomeDO, ChatDO, KittyDO } from "../actors.ts";
import { RecoveryDO } from "../recovery-store.ts";
import { Restore } from "../recovery-definition.ts";
const activity = guardedActivities(Effect.void);
const storage = () => "RECOVERY_UNAVAILABLE";
export const RestoreLive = Workflows.layer(
  Restore,
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine;
    const roots = yield* RecoveryDO,
      homes = yield* HomeDO,
      chats = yield* ChatDO,
      kitties = yield* KittyDO;
    const env = (yield* Cloudflare.WorkerEnvironment) as { KITTIES_KEK: string };
    return Effect.fn(function* (payload, executionId) {
      const root = roots.getByName("control", { locationHint: "weur" }),
        home = homes.getByName("owner", { locationHint: "weur" });
      const actor = () =>
        payload.kind === "workflow"
          ? workflowActor(engine, payload.name, env.KITTIES_KEK)
          : payload.kind === "home"
            ? homes.getByName("owner", { locationHint: "weur" })
            : payload.kind === "kitty"
              ? kitties.getByName(payload.name, { locationHint: "weur" })
              : chats.getByName(payload.name, { locationHint: "weur" });
      const epoch = yield* activity({
        name: "fence",
        success: Schema.Number,
        error: Schema.String,
        execute: Effect.gen(function* () {
          const control = yield* root.begin(payload.id).pipe(Effect.mapError(storage));
          yield* root
            .save(
              "restore",
              payload.id,
              JSON.stringify({
                ...payload,
                executionId,
                epoch: control.epoch,
                status: "restoring",
                at: Date.now(),
              }),
            )
            .pipe(Effect.mapError(storage));
          return control.epoch;
        }),
      });
      // Recovery guards cache a granted permit for permitCacheMs. Wait it out so no run that
      // was admitted before the fence can still start an activity once objects roll back.
      yield* DurableClock.sleep({
        name: "permit-drain",
        duration: permitCacheMs + 1000,
        inMemoryThreshold: 0,
      });
      yield* activity({
        name: "fence-desktops",
        error: Schema.String,
        execute: Effect.gen(function* () {
          for (const o of yield* root.objects().pipe(Effect.mapError(storage)))
            if (o.kind === "kitty")
              yield* kitties
                .getByName(o.name, { locationHint: "weur" })
                .recoveryFence(epoch)
                .pipe(Effect.mapError(storage));
        }),
      });
      yield* activity({
        name: "prepare",
        error: Schema.String,
        execute: Effect.gen(function* () {
          if (yield* root.read("undo", payload.id).pipe(Effect.mapError(storage))) return;
          const undo = yield* actor()
            .adminPrepareRestore(payload.bookmark)
            .pipe(Effect.mapError(storage));
          yield* root
            .save("undo", payload.id, JSON.stringify({ ...payload, bookmark: undo }))
            .pipe(Effect.mapError(storage));
        }),
      });
      yield* activity({
        name: "restart",
        error: Schema.String,
        // abort() invalidates the calling Cloudflare stub. Journal the eviction
        // before creating a new stub in a new durable callback.
        execute: actor()
          .adminEvict()
          .pipe(Effect.catchCause(() => Effect.void)),
      });
      yield* DurableClock.sleep({
        name: "restart-boundary",
        duration: "1 second",
        inMemoryThreshold: 0,
      });
      yield* activity({
        name: "verify-restart",
        error: Schema.String,
        execute: Effect.gen(function* () {
          yield* Effect.suspend(() => actor().adminBookmark()).pipe(
            Effect.retry({ times: 8, schedule: Schedule.exponential("100 millis") }),
            Effect.mapError(storage),
          );
        }),
      });
      yield* activity({
        name: "invalidate-credentials",
        error: Schema.String,
        execute: Effect.gen(function* () {
          for (const row of yield* home.list("connection").pipe(Effect.mapError(storage)))
            yield* home.oauthDisconnect(row.id).pipe(Effect.mapError(storage));
          for (const row of yield* home.list("provider").pipe(Effect.mapError(storage)))
            yield* home.oauthDisconnect(`chatgpt-${row.id}`).pipe(Effect.mapError(storage));
          for (const o of yield* root.objects().pipe(Effect.mapError(storage)))
            if (o.kind === "kitty")
              yield* kitties
                .getByName(o.name, { locationHint: "weur" })
                .recoveryFence(epoch)
                .pipe(Effect.mapError(storage));
          yield* home
            .write("settings", "restoredEpoch", String(epoch))
            .pipe(Effect.mapError(storage));
        }),
      });
      yield* activity({
        name: "complete",
        error: Schema.String,
        execute: Effect.gen(function* () {
          yield* root
            .save(
              "restore",
              payload.id,
              JSON.stringify({
                ...payload,
                executionId,
                epoch,
                status: "completed",
                at: Date.now(),
                credentials: "reauthorize",
                oldRuns: "owner-review",
              }),
            )
            .pipe(Effect.mapError(storage));
          yield* root.complete(payload.id).pipe(Effect.mapError(storage));
        }),
      });
      return payload.id;
    });
  }),
);
