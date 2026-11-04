import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Activity, Workflow, WorkflowEngine } from "effect/workflow";
import { RecoveryDO } from "./recovery-store.ts";
const StartedAt = Context.Reference<number>(
  "alchemy/Cloudflare/Workflows/DurableObjectEngine/StartedAt",
  { defaultValue: () => 0 },
);
export const makeRecoveryGuard = Effect.gen(function* () {
  const roots = yield* RecoveryDO;
  return (workflow: string, id: string) =>
    StartedAt.pipe(
      Effect.flatMap((startedAt) =>
        roots
          .getByName("control", { locationHint: "weur" })
          .permit(workflow, id, startedAt)
          .pipe(
            Effect.mapError(() => "RECOVERY_UNAVAILABLE"),
            Effect.flatMap((allowed) =>
              allowed ? Effect.void : Effect.fail("RESTORE_REVIEW_REQUIRED"),
            ),
          ),
      ),
    );
});
// Every workflow checks on replay entry. Check again before each new activity;
// replaying a completed result cannot dispatch effects or require another RPC.
export const guardedActivities =
  (guard: Effect.Effect<void, string>) =>
  <R, Success extends Schema.Constraint = Schema.Void>(options: {
    name: string;
    success?: Success;
    error?: typeof Schema.String;
    execute: Effect.Effect<Success["Type"], string, R>;
  }) =>
    Activity.make({
      ...options,
      error: Schema.String,
      execute: guard.pipe(
        Effect.andThen(options.execute),
        Effect.catch((error) => {
          if (
            ![
              "STORAGE_UNAVAILABLE",
              "STORAGE_FAILED",
              "EXPORT_UNAVAILABLE",
              "RECOVERY_UNAVAILABLE",
              "PURGE_UNAVAILABLE",
              "BOAT_UNAVAILABLE",
              "QUIESCE_FAILED",
              "BOOTSTRAP_FAILED",
            ].includes(String(error))
          )
            return Effect.fail(error);
          return Effect.gen(function* () {
            yield* Effect.logWarning("Activity awaits operator retry", options.name);
            return yield* Workflow.suspend(yield* WorkflowEngine.WorkflowInstance);
          });
        }),
      ),
    });
