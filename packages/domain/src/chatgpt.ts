import * as Schema from "effect/Schema";
import { Id } from "./index.ts";

export const ChatgptPauseReason = Schema.Literals([
  "usage_limit",
  "consent_required",
  "account_ineligible",
  "authorization_expired",
  "unsupported_request",
  "provider_unavailable",
  "incomplete",
  "interrupted",
]);

export const ChatgptError = Schema.Struct({
  reason: ChatgptPauseReason,
  code: Schema.String,
  status: Schema.optional(Schema.Number),
  requestId: Schema.optional(Schema.String),
  param: Schema.optional(Schema.String),
  ["bodyShape"]: Schema.optional(Schema.Literals(["structured", "detail", "other"])),
});

export type ChatgptFailure = typeof ChatgptError.Type;

export const ChatgptAccountView = Schema.Struct({
  id: Id,
  label: Schema.String,
  clientId: Schema.String,
  issuer: Schema.String,
  subject: Schema.String,
  email: Schema.optional(Schema.String),
  hostId: Schema.String,
  status: Schema.Literals(["connected", "consent_required", "reauthorize", "disconnected"]),
  admittedAt: Schema.optional(Schema.Number),
  lastError: Schema.optional(ChatgptError),
  updatedAt: Schema.Number,
});

export type ChatgptAccount = typeof ChatgptAccountView.Type;

export const ChatgptLinkInput = Schema.Struct({
  redirectUri: Schema.String.check(Schema.isMaxLength(200)),
  accountId: Schema.optional(Id),
  retryAttemptId: Schema.optional(Id),
  requestConsent: Schema.optional(Schema.Boolean),
});

export const ChatgptLinkView = Schema.Struct({
  id: Id,
  accountId: Schema.optional(Id),
  status: Schema.Literals([
    "pending",
    "exchanging",
    "connected",
    "denied",
    "cancelled",
    "expired",
    "failed",
  ]),
  expiresAt: Schema.Number,
  error: Schema.optional(ChatgptError),
  canRetryRegistration: Schema.optional(Schema.Boolean),
});

export type ChatgptLink = typeof ChatgptLinkView.Type;

export const ChatgptModelView = Schema.Struct({ slug: Schema.String, displayName: Schema.String });

export const ChatgptProbeView = Schema.Struct({
  ok: Schema.Boolean,
  model: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.Number),
  error: Schema.optional(ChatgptError),
});
