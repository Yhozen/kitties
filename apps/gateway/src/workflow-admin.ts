import * as Effect from "effect/Effect";
import { WorkflowEngine } from "effect/workflow";
import { seal } from "./secrets.ts";

// Supplied by the pinned engine patch; only the owner recovery router uses it.
type Administration = {
  adminCall: (
    workflow: string,
    id: string,
    method: string,
    args: readonly unknown[],
  ) => Effect.Effect<unknown>;
};

export const workflowActor = (
  engine: WorkflowEngine.WorkflowEngine["Service"],
  name: string,
  kek: string,
) => {
  const slash = name.indexOf("/"),
    workflow = name.slice(0, slash),
    id = name.slice(slash + 1);

  if (slash < 1 || !id) throw Error("INVALID_WORKFLOW");

  const invoke = <A>(method: string, ...args: readonly unknown[]) =>
    (engine as unknown as Administration).adminCall(workflow, id, method, args) as Effect.Effect<A>;

  return {
    adminSummary: () => invoke<unknown>("adminSummary"),
    adminBookmark: (at?: number) => invoke<string>("adminBookmark", at),
    adminPrepareRestore: (bookmark: string) => invoke<string>("adminPrepareRestore", bookmark),
    adminEvict: () => invoke<void>("adminEvict"),
    adminCapture: (capture: string) => invoke<string>("adminCapture", capture),
    adminPurge: (before: number) => invoke<boolean>("adminPurge", before),
    adminExportPart: (capture: string, table: string, row: number, part: number, aad: string) =>
      Effect.gen(function* () {
        const value = yield* invoke<{ body: string; last: boolean }>(
          "adminReadPart",
          capture,
          table,
          row,
          part,
        );

        return {
          body: JSON.stringify(
            yield* Effect.tryPromise({
              try: () => seal(kek, aad, value.body),
              catch: () => "EXPORT_UNAVAILABLE",
            }),
          ),
          last: value.last,
        };
      }),
  };
};
