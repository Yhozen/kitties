import * as Schema from "effect/Schema";
import { Workflow } from "effect/workflow";
export const Turn = Workflow.make("TurnV4", {
  payload: {
    chatId: Schema.String,
    messageId: Schema.String,
    kittyId: Schema.String,
    text: Schema.String,
    depth: Schema.optional(Schema.Number),
  },
  success: Schema.String,
  error: Schema.String,
  idempotencyKey: ({ chatId, messageId }) => `${chatId}:${messageId}`,
}).annotate(Workflow.SuspendOnFailure, true);
