import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Activity, DurableClock } from "effect/workflow";
import { HomeDO, ChatDO } from "../actors.ts";
import { GoalSlot } from "../goal-definition.ts";
import type { Goal } from "../entities.ts";
import { nextSlot } from "../schedule.ts";
const storage = () => "STORAGE_UNAVAILABLE";
export const GoalSlotLive = Workflows.layer(
  GoalSlot,
  Effect.gen(function* () {
    const homes = yield* HomeDO,
      chats = yield* ChatDO;
    return Effect.fn(function* (payload) {
      const home = homes.getByName("owner", { locationHint: "weur" });
      // The persisted clock deadline stays fixed across replay and redeployment.
      yield* DurableClock.sleep({
        name: "slot-time",
        duration: Math.max(1, payload.slotTime - Date.now()),
        inMemoryThreshold: 0,
      });
      const following = yield* Activity.make({
        name: "deliver-slot",
        success: Schema.Number,
        error: Schema.String,
        execute: Effect.gen(function* () {
          const saved = yield* home.read("goal", payload.goalId).pipe(Effect.mapError(storage));
          if (!saved) return 0;
          const goal = JSON.parse(saved) as Goal;
          if (!goal.enabled || goal.revision !== payload.revision) return 0;
          const messageId = `slot-${goal.id}-${goal.revision}-${payload.slotTime}`;
          yield* chats
            .getByName(goal.chatId, { locationHint: "weur" })
            .enqueue({
              chatId: goal.chatId,
              messageId,
              kittyId: goal.kittyId,
              text: goal.instruction,
            })
            .pipe(Effect.mapError(storage));
          const next = yield* Effect.try({
            try: () => nextSlot(goal.schedule, goal.timezone, payload.slotTime),
            catch: () => "INVALID_SCHEDULE",
          });
          yield* home
            .advanceGoalSlot(goal.id, goal.revision, payload.slotTime, next)
            .pipe(Effect.mapError(storage));
          return next;
        }),
      });
      if (following)
        yield* Activity.make({
          name: "chain-next",
          success: Schema.String,
          execute: GoalSlot.execute({ ...payload, slotTime: following }, { discard: true }),
        });
      return payload.goalId;
    });
  }),
);
