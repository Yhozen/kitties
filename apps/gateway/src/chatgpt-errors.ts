import type { ChatgptFailure } from "@kitties/domain/entities";

export class ChatgptProviderError extends Error {
  constructor(readonly info: ChatgptFailure) {
    super(info.code);
  }
}

const field = (value: unknown, max = 128) =>
  typeof value === "string" && value.length <= max && /^[a-zA-Z0-9_.[\]-]+$/.test(value)
    ? value
    : undefined;

export function chatgptFailure(status: number, body: unknown, requestId?: string): ChatgptFailure {
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : {};

  const error =
    raw.error && typeof raw.error === "object" ? (raw.error as Record<string, unknown>) : {};

  const code = field(error.code) ?? "CHATGPT_ADMISSION_FAILED";

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

  return {
    reason,
    code,
    status,
    ...(field(requestId, 200) ? { requestId } : {}),
    ...(field(error.param) ? { param: field(error.param) } : {}),
    bodyShape:
      raw.error && typeof raw.error === "object"
        ? "structured"
        : typeof raw.detail === "string"
          ? "detail"
          : "other",
  };
}

export const safeChatgptError = (error: unknown): ChatgptFailure =>
  error instanceof ChatgptProviderError
    ? error.info
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
