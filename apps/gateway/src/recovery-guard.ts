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
// Check outside the journal, including when the underlying activity is already complete.
export const guardedActivities =
  (guard: Effect.Effect<void, string>) =>
  <
    R,
    Success extends Schema.Constraint = Schema.Void,
    Error extends Schema.Constraint = Schema.Never,
  >(options: {
    name: string;
    success?: Success;
    error?: Error;
    execute: Effect.Effect<Success["Type"], Error["Type"], R>;
  }) =>
    guard.pipe(
      Effect.andThen(
        Activity.make({
          ...options,
          execute: options.execute.pipe(
            Effect.catch((error) => {
              if (
                ![
                  "STORAGE_UNAVAILABLE",
                  "STORAGE_FAILED",
                  "EXPORT_UNAVAILABLE",
                  "RECOVERY_UNAVAILABLE",
                  "PURGE_UNAVAILABLE",
                ].includes(String(error))
              )
                return Effect.fail(error);
              return Effect.gen(function* () {
                yield* Effect.logWarning("Activity awaits operator retry", options.name);
                return yield* Workflow.suspend(yield* WorkflowEngine.WorkflowInstance);
              });
            }),
          ),
        }),
      ),
    );
