import * as Schema from "effect/Schema";
import { Workflow, DurableDeferred } from "effect/workflow";

export const DesktopDecision = DurableDeferred.make("desktop/outcome", {
  success: Schema.Literals(["accept", "skip"]),
});

export const DesktopAttempt = Workflow.make("DesktopAttemptV1", {
  payload: {
    id: Schema.String,
    kittyId: Schema.String,
    chatId: Schema.String,
    messageId: Schema.String,
    callId: Schema.String,
  },
  success: Schema.String,
  error: Schema.String,
  idempotencyKey: ({ id }) => id,
}).annotate(Workflow.SuspendOnFailure, true);
