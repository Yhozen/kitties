import * as Schema from "effect/Schema";

export const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));

export const Health = Schema.Struct({
  ok: Schema.Boolean,
  version: Schema.String,
  runtime: Schema.Literal("boat"),
  stage: Schema.String,
});

export const Session = Schema.Struct({
  signed_in: Schema.Boolean,
  email: Schema.String,
  logout_url: Schema.Literal("/cdn-cgi/access/logout"),
});

export const Kitty = Schema.Struct({
  id: Id,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  generation: Schema.Number,
  status: Schema.Literals([
    "created",
    "starting",
    "running",
    "draining",
    "sleeping",
    "stopped",
    "error",
  ]),
  remoteId: Schema.optional(Schema.String),
  soul: Schema.String,
});

export type Kitty = typeof Kitty.Type;

export const ErrorCode = Schema.Literals([
  "ACCESS_REQUIRED",
  "ACCESS_DENIED",
  "ORIGIN_DENIED",
  "NOT_FOUND",
  "INVALID_REQUEST",
  "UNAVAILABLE",
  "HELD",
  "STALE_GENERATION",
  "UNKNOWN_OUTCOME",
  "CAPACITY_EXCEEDED",
]);

export const ApiError = Schema.Struct({
  code: ErrorCode,
  params: Schema.Record(Schema.String, Schema.String),
});

export type ApiError = typeof ApiError.Type;
