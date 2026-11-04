import * as Schema from "effect/Schema";
import { Workflow } from "effect/workflow";

export const Export = Workflow.make("ExportV1", {
  payload: { id: Schema.String },
  success: Schema.String,
  error: Schema.String,
  idempotencyKey: ({ id }) => id,
}).annotate(Workflow.SuspendOnFailure, true);

export const Restore = Workflow.make("RestoreV1", {
  payload: {
    id: Schema.String,
    kind: Schema.Literals(["home", "kitty", "chat", "workflow"]),
    name: Schema.String,
    bookmark: Schema.String,
  },
  success: Schema.String,
  error: Schema.String,
  idempotencyKey: ({ id }) => id,
}).annotate(Workflow.SuspendOnFailure, true);

export const Purge = Workflow.make("PurgeV1", {
  payload: { id: Schema.String, before: Schema.Number },
  success: Schema.Number,
  error: Schema.String,
  idempotencyKey: ({ id }) => id,
}).annotate(Workflow.SuspendOnFailure, true);
