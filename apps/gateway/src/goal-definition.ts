import * as Schema from "effect/Schema";
import { Workflow } from "effect/workflow";

export const GoalSlot = Workflow.make("GoalSlotV1", {
  payload: { goalId: Schema.String, revision: Schema.Number, slotTime: Schema.Number },
  success: Schema.String,
  error: Schema.String,
  idempotencyKey: ({ goalId, revision, slotTime }) => `${goalId}:${revision}:${slotTime}`,
}).annotate(Workflow.SuspendOnFailure, true);
