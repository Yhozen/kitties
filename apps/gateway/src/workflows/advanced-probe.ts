import * as Cloudflare from "@alchemy.run/cloudflare";
import { makeCallback } from "alchemy/Callback";
import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Activity, Workflow } from "effect/workflow";
import { HomeDO } from "../actors.ts";
import { Probe } from "./probe.ts";

export const AdvancedProbe = Workflow.make("AdvancedProbeV1", {
  payload: { id: Schema.String, mode: Schema.Literals(["children", "suspend"]) },
  success: Schema.Number,
  error: Schema.String,
  idempotencyKey: ({ id }) => id,
}).annotate(Workflow.SuspendOnFailure, true);

export const AdvancedProbeLive = Workflows.layer(
  AdvancedProbe,
  Effect.gen(function* () {
    const homes = yield* HomeDO;
    return Effect.fn(function* ({ id, mode }) {
      const home = homes.getByName("owner", { locationHint: "weur" });
      if (mode === "suspend") {
        yield* Activity.make({
          name: "before-failure",
          execute: home.recordProbeCall(id, 0).pipe(Effect.orDie),
        });
        // This dependency is deliberately outside an activity: the completed side effect
        // stays journaled, while an operator can repair the dependency before resuming.
        const repaired = yield* home.read("probe-repair", id).pipe(Effect.orDie);
        if (!repaired) return yield* Effect.fail("REPAIR_REQUIRED");
        return 1;
      }
      const children = [0, 1, 2].map((index) => ({
        id: `${id}/child/${index}`,
        steps: index + 1,
        delayMs: 20,
        wait: false,
        fail: false,
      }));
      yield* Effect.all(
        children.map((payload, index) =>
          Activity.make({
            name: `start-child/${index}`,
            success: Schema.String,
            execute: Probe.execute(payload, { discard: true }),
          }),
        ),
        { concurrency: "unbounded" },
      );
      let total = 0;
      for (const payload of children) total += yield* Probe.execute(payload);
      return total;
    });
  }),
);

export class CallbackProbeDO extends Cloudflare.DurableObject<CallbackProbeDO>()(
  "CallbackProbeDO",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const callback = yield* makeCallback(
        "parking-probe",
        () => Effect.fail("EXPECTED_CALLBACK_FAILURE"),
        { retry: { delay: "1 second" } },
      );
      return {
        start: () => callback.schedule("probe", { after: 0, payload: {} }),
        status: () => callback.getStatus("probe"),
        cancel: () => callback.cancel("probe"),
        alarm: () => Effect.void,
        rawStatus: () =>
          state.storage.sql
            .exec(
              "SELECT attempts,parked,retry_at FROM alchemy_alarm_callbacks WHERE callback='parking-probe'",
            )
            .pipe(Effect.flatMap((c) => c.toArray())),
      };
    });
  }),
) {}
