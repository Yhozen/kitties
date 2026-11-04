import * as Schema from "effect/Schema";
import { Workflow } from "effect/workflow";
export const ComputerOp = Workflow.make("ComputerOpV2", {
  payload: {
    kittyId: Schema.String,
    operationId: Schema.String,
    kind: Schema.Literals(["start", "sleep", "restore", "delete", "upgrade"]),
  },
  success: Schema.String,
  error: Schema.String,
  idempotencyKey: ({ kittyId, operationId }) => `${kittyId}:${operationId}`,
}).annotate(Workflow.SuspendOnFailure, true);
