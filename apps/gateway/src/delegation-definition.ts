import * as Schema from "effect/Schema";
import { Workflow } from "effect/workflow";

export const Delegation = Workflow.make("DelegationV1", {
  payload: {
    id: Schema.String,
    chatId: Schema.String,
    messageId: Schema.String,
    callId: Schema.String,
    kittyId: Schema.String,
    depth: Schema.Number,
  },
  success: Schema.String,
  error: Schema.String,
  idempotencyKey: ({ id }) => id,
}).annotate(Workflow.SuspendOnFailure, true);
