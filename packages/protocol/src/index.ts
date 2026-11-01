import * as Schema from "effect/Schema";
import { Id } from "@kitties/domain";

export const PROTOCOL_VERSION = 1;
export const Hello = Schema.Struct({
  type: Schema.Literal("hello"),
  protocolVersion: Schema.Number,
  buildId: Schema.String,
  kittyId: Id,
  remoteId: Schema.String,
  generation: Schema.Number,
});
export const Action = Schema.Struct({
  type: Schema.Literal("action"),
  intentId: Id,
  generation: Schema.Number,
  epoch: Schema.Number,
  deadline: Schema.Number,
  action: Schema.Literals([
    "click",
    "move",
    "scroll",
    "key",
    "type",
    "screenshot",
    "clipboard_read",
    "clipboard_write",
    "quiesce",
  ]),
  args: Schema.Record(Schema.String, Schema.Unknown),
});
export type Action = typeof Action.Type;
export const Ack = Schema.Struct({
  type: Schema.Literal("ack"),
  intentId: Id,
  generation: Schema.Number,
  epoch: Schema.Number,
  status: Schema.Literals(["completed", "failed", "unknown"]),
  result: Schema.optional(Schema.String),
});
