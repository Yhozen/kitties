// Public-client registration; these endpoints must never be user configurable.
export const chatgptConfig = {
  issuer: "https://auth.openai.com",
  authorizationEndpoint: "https://auth.openai.com/api/accounts/authorize",
  tokenEndpoint: "https://auth.openai.com/api/accounts/oauth/token",
  jwksUri: "https://auth.openai.com/.well-known/jwks.json",
  discoveryUri: "https://auth.openai.com/.well-known/openid-configuration",
  clientId: "dynamic_agent_client",
  scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
  resource: "https://api.openai.com/v1",
  protectedUrl: "https://api.openai.com/v1",
} as const;

export function loopbackRedirect(value: string): string {
  const url = new URL(value);

  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/auth/callback" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw Error("CHATGPT_INVALID_CALLBACK");

  return url.href;
}
