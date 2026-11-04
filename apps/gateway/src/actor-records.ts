import { mutableRecord } from "./stored-records.ts";
import * as Schema from "effect/Schema";
import { KittyInput, GoalInput, NotificationPrefs, RuleInput } from "./entities.ts";

const NoteRecord = mutableRecord({
  id: Schema.String,
  scope: Schema.String,
  text: Schema.String,
  strength: Schema.Number,
  at: Schema.Number,
  updated: Schema.Number,
  source: Schema.String,
  pinned: Schema.Boolean,
});

const FeedbackRecord = mutableRecord({
  id: Schema.String,
  rating: Schema.Literals(["up", "down"]),
  note: Schema.String,
  at: Schema.Number,
});

export const MemoryRecord = mutableRecord({
  notes: Schema.mutable(Schema.Array(NoteRecord)),
  profile: mutableRecord({
    demand: Schema.Number,
    auto: Schema.Boolean,
    up: Schema.Number,
    down: Schema.Number,
    recent: Schema.mutable(Schema.Array(Schema.String)),
    pending: Schema.Number,
  }),
  feedback: Schema.mutable(Schema.Array(FeedbackRecord)),
});

export const MemoryCommandRecord = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("remember"),
    id: Schema.String,
    scope: Schema.String,
    text: Schema.String,
    source: Schema.String,
    pinned: Schema.Boolean,
    at: Schema.Number,
  }),
  Schema.Struct({ type: Schema.Literal("forget"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("profile"), demand: Schema.Number, auto: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("feedback"), ...FeedbackRecord.fields }),
  Schema.Struct({
    type: Schema.Literal("distill"),
    notes: Schema.mutable(
      Schema.Array(
        Schema.Struct({ scope: Schema.String, text: Schema.String, strength: Schema.Number }),
      ),
    ),
    pending: Schema.Number,
    at: Schema.Number,
  }),
]);

export const TurnKittyRecord = Schema.Struct({
  kitty: Schema.Struct({ id: Schema.String, limits: KittyInput.fields.limits }),
});

export const GoalUpdateRecord = Schema.Struct({ ...GoalInput.fields, nextSlot: Schema.Number });
export const NotificationSettingsRecord = NotificationPrefs;
export const NotificationFoldRecord = Schema.Struct({ id: Schema.String, dueAt: Schema.Number });

export const NotificationBatchRecord = mutableRecord({
  title: Schema.String,
  url: Schema.String,
  dueAt: Schema.Number,
  count: Schema.Number,
  status: Schema.String,
});

export const RuleModeRecord = Schema.Struct({ mode: RuleInput.fields.mode });
export const TrustRecord = Schema.Struct({ streak: Schema.Number });
