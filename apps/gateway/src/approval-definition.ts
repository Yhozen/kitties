import * as Schema from "effect/Schema";
import { DurableDeferred, Workflow } from "effect/workflow";

export const ApprovalDecision = DurableDeferred.make("owner/approval", { success: Schema.Boolean });

export const Approval = Workflow.make("ApprovalV2", {
  payload: { id: Schema.String },
  success: Schema.Boolean,
  error: Schema.String,
  idempotencyKey: ({ id }) => id,
}).annotate(Workflow.SuspendOnFailure, true);
