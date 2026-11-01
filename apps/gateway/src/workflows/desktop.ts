import { makeRecoveryGuard, guardedActivities } from "../recovery-guard.ts";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Activity, DurableClock, DurableDeferred } from "effect/workflow";
import { HomeDO, KittyDO, ChatDO } from "../actors.ts";
import { DesktopAttempt, DesktopDecision } from "../desktop-definition.ts";
import { Action } from "@kitties/protocol";
import { sha256 } from "../kitty.ts";
import { open, type Envelope } from "../secrets.ts";
const storage = () => "STORAGE_UNAVAILABLE";
export const DesktopAttemptLive = Workflows.layer(
  DesktopAttempt,
  Effect.gen(function* () {
    const recovery = yield* makeRecoveryGuard;
    const fenced = (id: string) => guardedActivities(recovery(DesktopAttempt._tag, id));
    const homes = yield* HomeDO,
      kitties = yield* KittyDO,
      chats = yield* ChatDO;
    const env = (yield* Cloudflare.WorkerEnvironment) as { KITTIES_KEK: string };
    return Effect.fn(function* (payload, executionId) {
      yield* recovery(DesktopAttempt._tag, executionId);
      const home = homes.getByName("owner", { locationHint: "weur" }),
        kitty = kitties.getByName(payload.kittyId, { locationHint: "weur" }),
        chat = chats.getByName(payload.chatId, { locationHint: "weur" });
      const key = yield* Activity.idempotencyKey("desktop-dispatch");
      const intentId = yield* Effect.promise(() => sha256(key));
      const load = Effect.gen(function* () {
        const saved = yield* home.read("desktop-job", payload.id).pipe(Effect.mapError(storage));
        if (!saved) return yield* Effect.fail("TOOL_NOT_FOUND");
        return JSON.parse(saved) as {
          action: string;
          args: Record<string, unknown>;
          preparedAt?: number;
        };
      });
      const initial = yield* fenced(executionId)({
        name: "dispatch",
        success: Schema.String,
        error: Schema.String,
        execute: Effect.gen(function* () {
          const startedAt = Date.now();
          const [run, job] = yield* Effect.all(
            [chat.run(payload.messageId).pipe(Effect.mapError(storage)), load],
            { concurrency: 2 },
          );
          if (run?.status === "cancelled") return "cancelled";
          if (job.action === "ask_help") {
            yield* home
              .insert(
                "desktop-help",
                payload.id,
                JSON.stringify({
                  ...payload,
                  executionId,
                  reason: job.args.reason,
                  status: "pending",
                  expiresAt: Date.now() + 900000,
                }),
              )
              .pipe(Effect.mapError(storage));
            return "help";
          }
          const name = yield* Schema.decodeUnknownEffect(Action.fields.action)(job.action).pipe(
            Effect.mapError(() => "UNSUPPORTED_ACTION"),
          );
          if (name === "type_secret") {
            const ref = typeof job.args.ref === "string" ? job.args.ref : "";
            const value = yield* home.read("vault", ref).pipe(Effect.mapError(storage));
            if (!value) return yield* Effect.fail("SECRET_NOT_FOUND");
            const entry = JSON.parse(value) as { secret: Envelope };
            job.args = {
              ref,
              value: yield* Effect.tryPromise({
                try: () => open(env.KITTIES_KEK, `vault:${ref}:value`, entry.secret),
                catch: () => "KEY_UNAVAILABLE",
              }),
            };
          }
          const result = yield* kitty
            .agentAction(intentId, name, job.args)
            .pipe(Effect.mapError(storage));
          return JSON.stringify({
            status: result.status,
            timing: { preparedAt: job.preparedAt, startedAt, dispatchedAt: Date.now() },
          });
        }),
      });
      const dispatch = initial.startsWith("{")
        ? (JSON.parse(initial) as { status: string; timing: Record<string, number> })
        : { status: initial, timing: undefined };
      let status = dispatch.status;
      for (let index = 0; (status === "started" || status === "held") && index < 60; index++) {
        yield* DurableClock.sleep({
          name: `receipt-wait/${index}`,
          duration: status === "held" ? "5 seconds" : "1 second",
          inMemoryThreshold: 0,
        });
        status = yield* fenced(executionId)({
          name: `receipt/${index}`,
          success: Schema.String,
          error: Schema.String,
          execute: Effect.gen(function* () {
            if (
              (yield* chat.run(payload.messageId).pipe(Effect.mapError(storage)))?.status ===
              "cancelled"
            )
              return "cancelled";
            if (status === "held") {
              const job = yield* load;
              if (job.action === "type_secret") {
                const ref = typeof job.args.ref === "string" ? job.args.ref : "",
                  value = yield* home.read("vault", ref).pipe(Effect.mapError(storage));
                if (!value) return yield* Effect.fail("SECRET_NOT_FOUND");
                const entry = JSON.parse(value) as { secret: Envelope };
                job.args = {
                  ref,
                  value: yield* Effect.tryPromise({
                    try: () => open(env.KITTIES_KEK, `vault:${ref}:value`, entry.secret),
                    catch: () => "KEY_UNAVAILABLE",
                  }),
                };
              }
              const name = yield* Schema.decodeUnknownEffect(Action.fields.action)(job.action).pipe(
                Effect.mapError(() => "UNSUPPORTED_ACTION"),
              );
              return (yield* kitty
                .agentAction(intentId, name, job.args)
                .pipe(Effect.mapError(storage))).status;
            }
            const receipt = yield* kitty.receipt(intentId).pipe(Effect.mapError(storage));
            return receipt?.status ?? "unknown";
          }),
        });
      }
      if (status === "help" || status === "unknown" || status === "started" || status === "held") {
        yield* fenced(executionId)({
          name: "park-for-owner",
          error: Schema.String,
          execute: home
            .insert(
              "desktop-help",
              payload.id,
              JSON.stringify({
                ...payload,
                executionId,
                intentId,
                status: "pending",
                reason:
                  status === "help" ? "Owner help requested" : "Desktop outcome requires review",
                expiresAt: Date.now() + 900000,
              }),
            )
            .pipe(Effect.mapError(storage)),
        });
        yield* fenced(executionId)({
          name: "help-notice",
          error: Schema.String,
          execute: home
            .queueNotice(
              payload.id,
              "help",
              "Tu kitty necesita ayuda en el escritorio",
              "/?panel=vault",
              true,
            )
            .pipe(Effect.mapError(storage)),
        });
        const decision = yield* DurableDeferred.raceAll({
          name: "owner-or-expiry",
          success: Schema.String,
          error: Schema.Never,
          effects: [
            DurableDeferred.await(DesktopDecision),
            DurableClock.sleep({
              name: "help-expiry",
              duration: "15 minutes",
              inMemoryThreshold: 0,
            }).pipe(Effect.as("skip")),
          ],
        });
        status = decision === "accept" ? "completed" : "unknown";
      }
      yield* fenced(executionId)({
        name: "save-result",
        success: Schema.String,
        error: Schema.String,
        execute: Effect.gen(function* () {
          const receipt = yield* kitty.receipt(intentId).pipe(Effect.mapError(storage));
          let result: unknown = { status };
          if (receipt?.result) {
            try {
              result = JSON.parse(receipt.result);
            } catch {
              result = { text: receipt.result, status };
            }
          }
          yield* Effect.all(
            [
              chat
                .saveToolResult(
                  payload.messageId,
                  payload.callId,
                  JSON.stringify({
                    isFailure: status !== "completed" || (result as { ok?: boolean })?.ok === false,
                    result,
                    timing: dispatch.timing
                      ? { ...dispatch.timing, resultAt: Date.now() }
                      : undefined,
                  }),
                )
                .pipe(Effect.mapError(storage)),
              home
                .charge(key, new Date().toISOString().slice(0, 10), payload.kittyId, 0, 1)
                .pipe(Effect.mapError(storage)),
              home
                .write(
                  "desktop-help",
                  payload.id,
                  JSON.stringify({ ...payload, executionId, status: "completed" }),
                )
                .pipe(Effect.mapError(storage)),
            ],
            { concurrency: 3 },
          );
          return payload.callId;
        }),
      });
      return payload.callId;
    });
  }),
);
