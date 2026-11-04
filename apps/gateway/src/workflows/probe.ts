import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Activity, DurableClock, DurableDeferred, Workflow } from "effect/workflow";
import { HomeDO } from "../actors.ts";

export const ContinueProbe = DurableDeferred.make("owner/continue", { success: Schema.Boolean });
export const Probe = Workflow.make("ProbeV1", {
  payload: {
    id: Schema.String,
    steps: Schema.Number,
    delayMs: Schema.Number,
    wait: Schema.Boolean,
    fail: Schema.Boolean,
  },
  success: Schema.Number,
  error: Schema.String,
  idempotencyKey: ({ id }) => id,
});
export const ProbeLive = Workflows.layer(
  Probe,
  Effect.gen(function* () {
    const homes = yield* HomeDO;
    return Effect.fn(function* ({ id, steps, delayMs, wait, fail }) {
      const home = homes.getByName("owner", { locationHint: "weur" });
      for (let step = 0; step < steps; step++) {
        yield* Activity.make({
          name: `step/${step}`,
          error: Schema.String,
          execute: Effect.gen(function* () {
            yield* home.recordProbeCall(id, step).pipe(Effect.mapError(() => "STORAGE_FAILED"));
            if (fail && step === 0) return yield* Effect.fail("PROBE_FAILURE");
          }),
        });
        if (step === 0 && delayMs > 0)
          yield* DurableClock.sleep({
            name: "probe/wake",
            duration: delayMs,
            inMemoryThreshold: 0,
          });
      }
      if (wait) yield* DurableDeferred.await(ContinueProbe);
      return steps;
    });
  }),
);
