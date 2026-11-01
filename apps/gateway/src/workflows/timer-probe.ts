import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Activity, DurableClock, Workflow } from "effect/workflow";
import { HomeDO } from "../actors.ts";
export const TimerProbe = Workflow.make("TimerProbeV1", {
  payload: { id: Schema.String },
  success: Schema.Number,
  error: Schema.String,
  idempotencyKey: ({ id }) => id,
});
export const TimerProbeLive = Workflows.layer(
  TimerProbe,
  Effect.gen(function* () {
    const homes = yield* HomeDO;
    return Effect.fn(function* ({ id }) {
      const home = homes.getByName("owner", { locationHint: "weur" });
      for (let index = 0; index < 20; index++) {
        yield* Activity.make({
          name: `step/${index}`,
          error: Schema.String,
          execute: home
            .insert("timer-probe", `${id}:${index}`, "ok")
            .pipe(Effect.mapError(() => "STORAGE_UNAVAILABLE")),
        });
        yield* DurableClock.sleep({
          name: `wait/${index}`,
          duration: "250 millis",
          inMemoryThreshold: 0,
        });
      }
      return 20;
    });
  }),
);
