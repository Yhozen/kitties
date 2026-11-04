import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Activity, Workflow, WorkflowEngine } from "effect/workflow";
import { RecoveryDO } from "./recovery-store.ts";

const StartedAt = Context.Reference<number>(
  "alchemy/Cloudflare/Workflows/DurableObjectEngine/StartedAt",
  { defaultValue: () => 0 },
);

// A granted permit is reused briefly within one isolate. Every activity used to pay a
// cross-colo RecoveryDO round trip (RecoveryDO lives far from the workflow objects), which was
// two of the serial calls in each desktop step. A restore still fences the run: the next
// segment re-checks, and KittyDO's recovery fence rotates guest credentials immediately.
export const permitCacheMs = 5000;
const granted = new Map<string, number>();

export const makeRecoveryGuard = Effect.gen(function* () {
  const roots = yield* RecoveryDO;

  return (workflow: string, id: string) =>
    StartedAt.pipe(
      Effect.flatMap((startedAt) => {
        const key = `${workflow}\u0000${id}\u0000${startedAt}`;
        const until = granted.get(key);

        if (until !== undefined && until > Date.now()) return Effect.void;

        return roots
          .getByName("control", { locationHint: "weur" })
          .permit(workflow, id, startedAt)
          .pipe(
            Effect.mapError(() => "RECOVERY_UNAVAILABLE"),
            Effect.flatMap((allowed) => {
              if (!allowed) {
                granted.delete(key);

                return Effect.fail("RESTORE_REVIEW_REQUIRED");
              }

              if (granted.size > 512) granted.clear();
              granted.set(key, Date.now() + permitCacheMs);

              return Effect.void;
            }),
          );
      }),
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
              "BOAT_BILLING",
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
