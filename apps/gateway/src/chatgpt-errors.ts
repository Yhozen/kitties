import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import type { ChatgptFailure } from "@kitties/domain/entities";

const ProviderFailure = Schema.Struct({
  error: Schema.optional(Schema.Unknown),
  detail: Schema.optional(Schema.Unknown),
});

const ErrorDetails = Schema.Struct({
  code: Schema.optional(Schema.Unknown),
  param: Schema.optional(Schema.Unknown),
});

const diagnosticField = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z0-9_.[\]-]+$/),
);

const requestIdField = Schema.String.check(
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-zA-Z0-9_.[\]-]+$/),
);

export class ChatgptProviderError extends Error {
  constructor(readonly info: ChatgptFailure) {
    super(info.code);
  }
}

export function chatgptFailure(
  status: number,
  body: typeof ProviderFailure.Type,
  requestId?: string,
): ChatgptFailure {
  const raw = Schema.decodeUnknownSync(ProviderFailure)(body);

  const error = Option.getOrElse(Schema.decodeUnknownOption(ErrorDetails)(raw.error), () => ({
    code: undefined,
    param: undefined,
  }));

  const code = Option.getOrElse(
    Schema.decodeUnknownOption(diagnosticField)(error.code),
    () => "CHATGPT_ADMISSION_FAILED",
  );

  const reason: ChatgptFailure["reason"] =
    code === "subscription_sharing_usage_limit_exceeded"
      ? "usage_limit"
      : code === "subscription_sharing_user_not_eligible"
        ? "account_ineligible"
        : [
              "invalid_grant",
              "invalid_refresh_token",
              "token_expired",
              "refresh_token_expired",
              "refresh_token_invalidated",
              "refresh_token_reused",
              "subscription_sharing_invalid_user",
            ].includes(code) || status === 401
          ? "authorization_expired"
          : [
                "subscription_sharing_unsupported_capability",
                "subscription_sharing_route_not_supported",
              ].includes(code) || status === 400
            ? "unsupported_request"
            : [
                  "chatpass_v2_scope_not_authorized",
                  "chatpass_v2_invalid_authorization_context",
                ].includes(code)
              ? "consent_required"
              : status === 403
                ? "account_ineligible"
                : "provider_unavailable";

  const diagnostics: {
    -readonly [K in keyof Pick<ChatgptFailure, "requestId" | "param">]: ChatgptFailure[K];
  } = {};

  const diagnosticRequestId = Option.getOrUndefined(
    Schema.decodeUnknownOption(requestIdField)(requestId),
  );

  const param = Option.getOrUndefined(Schema.decodeUnknownOption(diagnosticField)(error.param));

  if (diagnosticRequestId !== undefined) diagnostics.requestId = diagnosticRequestId;

  if (param !== undefined) diagnostics.param = param;

  // This serialized field belongs to the shared ChatgptFailure contract.
  return {
    reason,
    code,
    status,
    ...diagnostics,
    ["bodyShape"]: Schema.is(Schema.ObjectKeyword)(raw.error)
      ? "structured"
      : Schema.is(Schema.String)(raw.detail)
        ? "detail"
        : "other",
  };
}

export const safeChatgptError = (cause: unknown): ChatgptFailure =>
  cause instanceof ChatgptProviderError
    ? cause.info
    : {
        reason: "provider_unavailable",
        code: "CHATGPT_UNAVAILABLE",
      };

export function chatgptError(
  code: string,
  reason: ChatgptFailure["reason"] = "authorization_expired",
): never {
  throw new ChatgptProviderError({ code, reason });
}
