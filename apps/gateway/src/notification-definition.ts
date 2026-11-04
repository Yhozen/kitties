import * as Schema from "effect/Schema";
import { Workflow } from "effect/workflow";
export const Notify = Workflow.make("NotifyV1", {
  payload: { id: Schema.String },
  success: Schema.String,
  error: Schema.String,
  idempotencyKey: ({ id }) => id,
}).annotate(Workflow.SuspendOnFailure, true);
