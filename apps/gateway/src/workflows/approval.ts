import { RecoveryGuard, guardedActivities } from "../recovery-guard.ts";
import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DurableClock, DurableDeferred } from "effect/workflow";
import { HomeDO } from "../actors.ts";
import { Approval, ApprovalDecision } from "../approval-definition.ts";
import type { ApprovalRecord } from "../entities.ts";

export const ApprovalLive = Workflows.layer(
  Approval,
  Effect.gen(function* () {
    const recovery = yield* RecoveryGuard;
    const fenced = (id: string) => guardedActivities(recovery(Approval._tag, id));
    const homes = yield* HomeDO;

    return Effect.fn(function* ({ id }, executionId) {
      yield* recovery(Approval._tag, executionId);
      const home = homes.getByName("owner", { locationHint: "weur" });

      const expiresAt = yield* fenced(executionId)({
        name: "deadline",
        success: Schema.Number,
        error: Schema.String,
        execute: Effect.gen(function* () {
          const saved = yield* home
            .read("approval", id)
            .pipe(Effect.mapError(() => "STORAGE_UNAVAILABLE"));

          if (!saved) return yield* Effect.fail("APPROVAL_NOT_FOUND");

          // SAFETY: Turn persists typed ApprovalRecord values; HomeDO updates only decision/status fields.
          return (JSON.parse(saved) as ApprovalRecord).expiresAt;
        }),
      });

      const first = yield* DurableDeferred.raceAll({
        name: "decision-or-reminder",
        success: Schema.String,
        error: Schema.Never,
        effects: [
          DurableDeferred.await(ApprovalDecision).pipe(Effect.as("decided")),
          DurableClock.sleep({
            name: "reminder-time",
            duration: Math.max(1, expiresAt - 10 * 60000 - Date.now()),
            inMemoryThreshold: 0,
          }).pipe(Effect.as("reminder")),
        ],
      });

      if (first === "reminder") {
        yield* fenced(executionId)({
          name: "remind",
          error: Schema.String,
          execute: Effect.gen(function* () {
            const saved = yield* home
              .read("approval", id)
              .pipe(Effect.mapError(() => "STORAGE_UNAVAILABLE"));

            // SAFETY: Turn persists typed ApprovalRecord values; HomeDO updates only decision/status fields.
            if (saved && (JSON.parse(saved) as ApprovalRecord).status === "pending")
              yield* home
                .queueNotice(
                  id + ":reminder",
                  "approval",
                  "Tienes una aprobación pendiente",
                  "/?panel=approvals",
                  true,
                )
                .pipe(Effect.mapError(() => "STORAGE_UNAVAILABLE"));
          }),
        });
        yield* DurableDeferred.raceAll({
          name: "decision-or-expiry",
          success: Schema.Boolean,
          error: Schema.Never,
          effects: [
            DurableDeferred.await(ApprovalDecision),
            DurableClock.sleep({
              name: "expiry",
              duration: Math.max(1, expiresAt - Date.now()),
              inMemoryThreshold: 0,
            }).pipe(Effect.as(false)),
          ],
        });
      }

      return yield* fenced(executionId)({
        name: "decision",
        success: Schema.Boolean,
        error: Schema.String,
        execute: Effect.gen(function* () {
          yield* home.expireApproval(id).pipe(Effect.mapError(() => "STORAGE_UNAVAILABLE"));

          const saved = yield* home
            .read("approval", id)
            .pipe(Effect.mapError(() => "STORAGE_UNAVAILABLE"));

          // SAFETY: Turn persists typed ApprovalRecord values; HomeDO updates only decision/status fields.
          return !!saved && (JSON.parse(saved) as ApprovalRecord).status === "approved";
        }),
      });
    });
  }),
);
