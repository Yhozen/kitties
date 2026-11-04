import { makeRecoveryGuard, guardedActivities } from "../recovery-guard.ts";
import * as Workflows from "alchemy/Workflows";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DurableClock } from "effect/workflow";
import { buildPushPayload, type PushSubscription } from "@block65/webcrypto-web-push";
import { HomeDO } from "../actors.ts";
import { Notify } from "../notification-definition.ts";
import { open, type Envelope } from "../secrets.ts";
import { sha256 } from "../kitty.ts";

export const NotifyLive = Workflows.layer(
  Notify,
  Effect.gen(function* () {
    const recovery = yield* makeRecoveryGuard;
    const fenced = (id: string) => guardedActivities(recovery(Notify._tag, id));

    const homes = yield* HomeDO,
      env = (yield* Cloudflare.WorkerEnvironment) as { KITTIES_KEK: string };

    return Effect.fn(function* ({ id }, executionId) {
      yield* recovery(Notify._tag, executionId);
      const home = homes.getByName("owner", { locationHint: "weur" });

      const due = yield* fenced(executionId)({
        name: "due",
        success: Schema.Number,
        error: Schema.String,
        execute: home.read("notification-batch", id).pipe(
          Effect.map((body) => (body ? (JSON.parse(body) as { dueAt: number }).dueAt : 0)),
          Effect.mapError(() => "STORAGE_UNAVAILABLE"),
        ),
      });

      if (!due) return id;
      yield* DurableClock.sleep({
        name: "fold",
        duration: Math.max(1, due - Date.now()),
        inMemoryThreshold: 0,
      });
      yield* fenced(executionId)({
        name: "deliver",
        success: Schema.String,
        error: Schema.String,
        execute: Effect.gen(function* () {
          const saved = yield* home.read("notification-batch", id);

          if (!saved) return id;

          const batch = JSON.parse(saved) as {
            status: string;
            title: string;
            url: string;
            count: number;
          };

          if (batch.status !== "pending") return id;
          const prefs = yield* home.read("settings", "notifications");

          if (!prefs || !JSON.parse(prefs).enabled) {
            yield* home.write(
              "notification-batch",
              id,
              JSON.stringify({ ...batch, status: "skipped" }),
            );

            return id;
          }

          const keyBody = yield* home.read("settings", "vapid");

          if (!keyBody) {
            yield* home.write(
              "notification-batch",
              id,
              JSON.stringify({ ...batch, status: "skipped" }),
            );

            return id;
          }

          const keys = JSON.parse(keyBody) as { publicKey: string; secret: Envelope };

          const privateKey = yield* Effect.tryPromise({
            try: () => open(env.KITTIES_KEK, "settings:vapid:private-key", keys.secret),
            catch: () => "KEY_UNAVAILABLE",
          });

          let unknown = false,
            delivered = 0;

          for (const row of yield* home.list("push-subscription")) {
            const subscription = yield* Effect.tryPromise({
              try: async () =>
                JSON.parse(
                  await open(
                    env.KITTIES_KEK,
                    `push-subscription:${row.id}:payload`,
                    JSON.parse(row.body) as Envelope,
                  ),
                ) as PushSubscription,
              catch: () => "KEY_UNAVAILABLE",
            });

            const data = JSON.stringify({
              title: batch.count > 1 ? `${batch.title} (+${batch.count - 1})` : batch.title,
              url: batch.url,
              tag: id,
            });

            const payload = yield* Effect.tryPromise({
              try: () =>
                buildPushPayload({ data, options: { ttl: 300 } }, subscription, {
                  subject: "mailto:gabriel@garox.org",
                  publicKey: keys.publicKey,
                  privateKey,
                }),
              catch: () => "PUSH_UNAVAILABLE",
            });

            const effectId = `${executionId}:${row.id}`,
              digest = yield* Effect.promise(() => sha256(data));

            const claim = yield* home.claimEffect(effectId, digest);

            if (!claim.claimed) {
              if (claim.status !== "completed") unknown = true;
              continue;
            }

            const status = yield* Effect.tryPromise({
              try: async () => {
                const response = await fetch(subscription.endpoint, {
                  ...payload,
                  redirect: "manual",
                  signal: AbortSignal.timeout(15000),
                });

                await response.body?.cancel();

                return response.status;
              },
              catch: () => "PUSH_OUTCOME_UNKNOWN",
            }).pipe(Effect.catch(() => Effect.succeed(0)));

            if (status === 404 || status === 410) yield* home.remove("push-subscription", row.id);

            if (status >= 200 && status < 300) delivered++;
            else unknown = true;
            yield* home.completeEffect(effectId, JSON.stringify({ status }));
          }

          yield* home.write(
            "notification-batch",
            id,
            JSON.stringify({
              ...batch,
              status: unknown ? "unknown" : "completed",
              delivered,
              finishedAt: Date.now(),
            }),
          );

          return id;
        }).pipe(
          Effect.mapError((error) => (typeof error === "string" ? error : "STORAGE_UNAVAILABLE")),
        ),
      });

      return id;
    });
  }),
);
