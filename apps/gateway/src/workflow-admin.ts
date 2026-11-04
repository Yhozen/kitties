import * as Schema from "effect/Schema";
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

  // SAFETY: The pinned @alchemy.run/cloudflare patch installs adminCall on every
  // DurableObjectEngine instance; this adapter is only given that engine.
  const administration = engine as WorkflowEngine.WorkflowEngine["Service"] & Administration;

  const invoke = <A>(method: string, schema: Schema.Codec<A>, ...args: readonly unknown[]) =>
    administration.adminCall(workflow, id, method, args).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(() => "STORAGE_UNAVAILABLE"),
    );

  return {
    adminSummary: () => invoke("adminSummary", Schema.Unknown),
    adminBookmark: (at?: number) => invoke("adminBookmark", Schema.String, at),
    adminPrepareRestore: (bookmark: string) =>
      invoke("adminPrepareRestore", Schema.String, bookmark),
    adminEvict: () => invoke("adminEvict", Schema.Void),
    adminCapture: (capture: string) => invoke("adminCapture", Schema.String, capture),
    adminPurge: (before: number) => invoke("adminPurge", Schema.Boolean, before),
    adminExportPart: (capture: string, table: string, row: number, part: number, aad: string) =>
      Effect.gen(function* () {
        const value = yield* invoke(
          "adminReadPart",
          Schema.Struct({ body: Schema.String, last: Schema.Boolean }),
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
