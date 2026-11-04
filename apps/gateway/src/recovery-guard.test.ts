import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Workflow, WorkflowEngine } from "effect/workflow";
import { guardedActivities } from "./recovery-guard.ts";

it("reuses recorded results while fencing every new activity", async () => {
  let permits = 0,
    effects = 0,
    allowed = true;
  const guard = Effect.suspend(() => {
    permits++;
    return allowed ? Effect.void : Effect.fail("RESTORE_REVIEW_REQUIRED");
  });
  const workflow = Workflow.make("guard-cache-test", {
    payload: {},
    success: Schema.String,
    error: Schema.String,
    idempotencyKey: () => "one",
  });
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine;
        yield* engine.register(workflow, () =>
          Effect.gen(function* () {
            const recorded = guardedActivities(guard)({
              name: "recorded",
              execute: Effect.sync(() => {
                effects++;
              }),
            });
            yield* recorded;
            allowed = false;
            yield* recorded;
            return yield* guardedActivities(guard)({
              name: "new-effect",
              success: Schema.String,
              execute: Effect.sync(() => {
                effects++;
                return "unsafe";
              }),
            }).pipe(Effect.catch((code) => Effect.succeed(code)));
          }),
        );
        return yield* workflow.execute({});
      }),
    ).pipe(Effect.provide(WorkflowEngine.layerMemory)),
  );
  expect(result).toBe("RESTORE_REVIEW_REQUIRED");
  expect(effects).toBe(1);
  expect(permits).toBe(2);
});
