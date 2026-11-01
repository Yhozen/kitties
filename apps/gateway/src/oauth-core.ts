import { isChatgptConfig } from "./chatgpt-config.ts";
import { publicHttps, allowedFetch } from "./outbound.ts";
import { seal, open, type Envelope } from "./secrets.ts";

export interface OAuthConfig {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  authMethod?: "none" | "client_secret_post" | "client_secret_basic";
  scope: string;
  resource?: string;
  redirectUri: string;
  protectedUrl: string;
}
interface Tokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}
interface Flow {
  connectionId: string;
  verifier: string;
  config: OAuthConfig;
  expiresAt: number;
}
interface Credentials {
  envelope: Envelope;
  status: "ready" | "refreshing" | "reauthorize";
  revision: string;
}
export interface OAuthStorage {
  get(kind: string, id: string): string | null;
  put(kind: string, id: string, body: string): void;
  take(kind: string, id: string): string | null;
}
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
export const randomSecret = () => encode(crypto.getRandomValues(new Uint8Array(32)));
export const pkceChallenge = async (verifier: string) =>
  encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

export async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw Error("OAUTH_REMOTE_UNAVAILABLE");
  const reader = response.body?.getReader();
  if (!reader) throw Error("OAUTH_INVALID_RESPONSE");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 262144) throw Error("OAUTH_RESPONSE_LIMIT");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("OAUTH_INVALID_RESPONSE");
  return value as Record<string, unknown>;
}
const getJson = (url: string) =>
  allowedFetch(url, [publicHttps(url).hostname], { signal: AbortSignal.timeout(15000) }).then(
    jsonResponse,
  );

export async function discoverOAuth(resource: string) {
  const url = publicHttps(resource);
  // RFC 9728 inserts the well-known component before the protected-resource path.
  const prm = new URL(
    `/.well-known/oauth-protected-resource${url.pathname === "/" ? "" : url.pathname}`,
    url.origin,
  );
  let metadata: Record<string, unknown>;
  try {
    metadata = await getJson(prm.href);
  } catch {
    metadata = await getJson(new URL("/.well-known/oauth-protected-resource", url.origin).href);
  }
  if (typeof metadata.resource !== "string" || new URL(metadata.resource).href !== url.href)
    throw Error("OAUTH_RESOURCE_MISMATCH");
  const issuers = metadata.authorization_servers;
  if (!Array.isArray(issuers) || typeof issuers[0] !== "string")
    throw Error("OAUTH_DISCOVERY_REQUIRED");
  const issuer = publicHttps(issuers[0]);
  if (issuer.search) throw Error("OAUTH_INVALID_ISSUER");
  const suffix = issuer.pathname.replace(/\/$/, "");
  const server = await getJson(
    `${issuer.origin}/.well-known/oauth-authorization-server${suffix}`,
  ).catch(() => getJson(`${issuer.href.replace(/\/$/, "")}/.well-known/openid-configuration`));
  if (server.issuer !== issuer.href && server.issuer !== issuer.href.replace(/\/$/, ""))
    throw Error("OAUTH_ISSUER_MISMATCH");
  if (
    !Array.isArray(server.code_challenge_methods_supported) ||
    !server.code_challenge_methods_supported.includes("S256")
  )
    throw Error("OAUTH_PKCE_REQUIRED");
  for (const key of ["authorization_endpoint", "token_endpoint"])
    if (typeof server[key] !== "string") throw Error("OAUTH_INVALID_METADATA");
    else publicHttps(server[key]);
  return {
    issuer: String(server.issuer),
    authorizationEndpoint: String(server.authorization_endpoint),
    tokenEndpoint: String(server.token_endpoint),
    registrationEndpoint:
      typeof server.registration_endpoint === "string"
        ? publicHttps(server.registration_endpoint).href
        : undefined,
    cimd: server.client_id_metadata_document_supported === true,
    authMethods: Array.isArray(server.token_endpoint_auth_methods_supported)
      ? server.token_endpoint_auth_methods_supported.filter(
          (method): method is string => typeof method === "string",
        )
      : ["client_secret_basic"],
    scopes: Array.isArray(metadata.scopes_supported)
      ? metadata.scopes_supported.filter((s): s is string => typeof s === "string")
      : [],
  };
}
export function validateConfig(config: OAuthConfig) {
  for (const url of [
    config.issuer,
    config.authorizationEndpoint,
    config.tokenEndpoint,
    ...(isChatgptConfig(config) ? [] : [config.redirectUri]),
    config.protectedUrl,
  ])
    publicHttps(url);
  if (config.resource) publicHttps(config.resource);
  if (!config.clientId || config.clientId.length > 2048 || config.scope.length > 4096)
    throw Error("OAUTH_INVALID_CONFIG");
}
async function exchange(
  config: OAuthConfig,
  body: URLSearchParams,
  previous?: Tokens,
): Promise<Tokens> {
  body.set("client_id", config.clientId);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (config.clientSecret && config.authMethod === "client_secret_basic") {
    const form = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
    headers.Authorization = `Basic ${btoa(`${form(config.clientId)}:${form(config.clientSecret)}`)}`;
  } else if (config.clientSecret) body.set("client_secret", config.clientSecret);
  if (config.resource) body.set("resource", config.resource);
  const response = await allowedFetch(
    config.tokenEndpoint,
    [publicHttps(config.tokenEndpoint).hostname],
    {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(30000),
    },
  );
  const result = await jsonResponse(response);
  if (
    typeof result.access_token !== "string" ||
    !result.access_token ||
    result.access_token.length > 32768 ||
    (result.token_type !== undefined &&
      (typeof result.token_type !== "string" || result.token_type.toLowerCase() !== "bearer"))
  )
    throw Error("OAUTH_INVALID_TOKEN");
  if (
    result.refresh_token !== undefined &&
    (typeof result.refresh_token !== "string" || result.refresh_token.length > 32768)
  )
    throw Error("OAUTH_INVALID_TOKEN");
  if (
    result.expires_in !== undefined &&
    (!Number.isFinite(Number(result.expires_in)) || Number(result.expires_in) <= 0)
  )
    throw Error("OAUTH_INVALID_EXPIRY");
  return {
    accessToken: result.access_token,
    refreshToken:
      typeof result.refresh_token === "string" ? result.refresh_token : previous?.refreshToken,
    // Providers with non-expiring tokens omit expires_in. Never guess a refresh interval.
    expiresAt: result.expires_in === undefined ? 0 : Date.now() + Number(result.expires_in) * 1000,
  };
}

// This object lives inside HomeDO. Tokens never enter a workflow result/journal.
// A durable refresh marker makes a crash after token rotation fail closed instead of
// replaying the old refresh token. Concurrent callers in one incarnation share a Promise.
export function makeOAuthStorage(storage: OAuthStorage, kek: string) {
  const refreshing = new Map<string, Promise<string>>();
  const aad = (id: string) => `oauth:${id}:credentials`;
  const read = async (id: string, row: Credentials) =>
    JSON.parse(await open(kek, aad(id), row.envelope)) as { config: OAuthConfig; tokens: Tokens };
  const save = async (
    id: string,
    config: OAuthConfig,
    tokens: Tokens,
    expected: { revision: string } | { state: string },
  ) => {
    const revision = randomSecret();
    const row: Credentials = {
      status: "ready",
      revision,
      envelope: await seal(kek, aad(id), JSON.stringify({ config, tokens })),
    };
    if ("state" in expected) {
      if (storage.get("oauth-attempt", id) !== expected.state)
        throw Error("OAUTH_REVISION_CHANGED");
    } else {
      const current = storage.get("oauth-credentials", id);
      if (!current || (JSON.parse(current) as Credentials).revision !== expected.revision)
        throw Error("OAUTH_REVISION_CHANGED");
    }
    storage.put("oauth-credentials", id, JSON.stringify(row));
  };
  return {
    begin: async (connectionId: string, config: OAuthConfig) => {
      validateConfig(config);
      const state = randomSecret(),
        verifier = randomSecret();
      const flow: Flow = { connectionId, verifier, config, expiresAt: Date.now() + 600000 };
      const envelope = await seal(kek, `oauth-flow:${state}:pkce`, JSON.stringify(flow));
      storage.put("oauth-flow", state, JSON.stringify(envelope));
      storage.put("oauth-attempt", connectionId, state);
      const url = publicHttps(config.authorizationEndpoint);
      for (const [key, value] of Object.entries({
        response_type: "code",
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        scope: config.scope,
        state,
        code_challenge: await pkceChallenge(verifier),
        code_challenge_method: "S256",
        ...(config.resource ? { resource: config.resource } : {}),
      }))
        url.searchParams.set(key, value);
      return { url: url.href, expiresAt: flow.expiresAt };
    },
    finish: async (state: string, code: string, issuer?: string, expectedId?: string) => {
      if (!/^[\w-]{43}$/.test(state) || !code || code.length > 8192)
        throw Error("OAUTH_INVALID_CALLBACK");
      // Consume synchronously before any decryption/network await; callbacks are single-use.
      const saved = storage.take("oauth-flow", state);
      if (!saved) throw Error("OAUTH_STATE_USED");
      const flow = JSON.parse(
        await open(kek, `oauth-flow:${state}:pkce`, JSON.parse(saved) as Envelope),
      ) as Flow;
      if (expectedId && flow.connectionId !== expectedId) throw Error("OAUTH_RESOURCE_MISMATCH");
      if (flow.expiresAt <= Date.now() || (issuer && issuer !== flow.config.issuer))
        throw Error("OAUTH_FLOW_EXPIRED");
      if (storage.get("oauth-attempt", flow.connectionId) !== state)
        throw Error("OAUTH_REVISION_CHANGED");
      const tokens = await exchange(
        flow.config,
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: flow.config.redirectUri,
          code_verifier: flow.verifier,
        }),
      );
      await save(flow.connectionId, flow.config, tokens, { state });
      storage.take("oauth-attempt", flow.connectionId);
      return flow.connectionId;
    },
    token: async (id: string, protectedUrl: string): Promise<string> => {
      const flight = `${id}:${protectedUrl}`;
      const existing = refreshing.get(flight);
      if (existing) return existing;
      const pending = (async () => {
        const raw = storage.get("oauth-credentials", id);
        if (!raw) throw Error("OAUTH_AUTHORIZATION_REQUIRED");
        const row = JSON.parse(raw) as Credentials;
        if (row.status !== "ready") throw Error("OAUTH_REAUTHORIZE_REQUIRED");
        const { config, tokens } = await read(id, row);
        if (config.protectedUrl !== protectedUrl) throw Error("OAUTH_RESOURCE_MISMATCH");
        // Recheck after decrypt: another callback may have replaced this connection.
        if (storage.get("oauth-credentials", id) !== raw) throw Error("OAUTH_REVISION_CHANGED");
        if (!tokens.expiresAt || tokens.expiresAt > Date.now() + 60000) return tokens.accessToken;
        if (!tokens.refreshToken) throw Error("OAUTH_REAUTHORIZE_REQUIRED");
        storage.put("oauth-credentials", id, JSON.stringify({ ...row, status: "refreshing" }));
        try {
          const updated = await exchange(
            config,
            new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: tokens.refreshToken,
            }),
            tokens,
          );
          const current = storage.get("oauth-credentials", id);
          if (!current || (JSON.parse(current) as Credentials).revision !== row.revision)
            throw Error("OAUTH_REVISION_CHANGED");
          await save(id, config, updated, { revision: row.revision });
          return updated.accessToken;
        } catch {
          const current = storage.get("oauth-credentials", id);
          if (current && (JSON.parse(current) as Credentials).revision === row.revision)
            storage.put("oauth-credentials", id, JSON.stringify({ ...row, status: "reauthorize" }));
          throw Error("OAUTH_REAUTHORIZE_REQUIRED");
        }
      })();
      refreshing.set(flight, pending);
      try {
        return await pending;
      } finally {
        refreshing.delete(flight);
      }
    },
    status: (id: string) => {
      const raw = storage.get("oauth-credentials", id);
      return raw ? (JSON.parse(raw) as Credentials).status : "disconnected";
    },
    disconnect: (id: string) => {
      storage.take("oauth-credentials", id);
      storage.take("oauth-attempt", id);
    },
  };
}
