import type { OAuthConfig } from "./oauth-core.ts";
// Retained Codex PKCE flow. The registered redirect is pasted back by the owner.
// https://developers.openai.com/codex/auth/
export const chatgptConfig: OAuthConfig = {
  issuer: "https://auth.openai.com",
  authorizationEndpoint: "https://auth.openai.com/oauth/authorize",
  tokenEndpoint: "https://auth.openai.com/oauth/token",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  redirectUri: "http://localhost:1455/auth/callback",
  scope: "openid profile email offline_access",
  protectedUrl: "https://chatgpt.com/backend-api/codex",
};
export const isChatgptConfig = (config: OAuthConfig) =>
  Object.entries(chatgptConfig).every(
    ([key, value]) => config[key as keyof OAuthConfig] === value,
  ) &&
  !config.clientSecret &&
  !config.resource;
export function chatgptAccount(token: string): string {
  try {
    const part = token.split(".")[1]!;
    const claims = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as Record<
      string,
      unknown
    >;
    // This claim only routes the request. The remote service verifies the bearer token.
    const account = (claims["https://api.openai.com/auth"] as Record<string, unknown>)
      ?.chatgpt_account_id;
    if (typeof account === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(account)) return account;
  } catch {
    /* stable error; never include token bytes */
  }
  throw Error("CHATGPT_ACCOUNT_REQUIRED");
}
