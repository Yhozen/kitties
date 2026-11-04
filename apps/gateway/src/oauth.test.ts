import { afterEach, expect, test, vi } from "vitest";
import { makeOAuthStorage, pkceChallenge, discoverOAuth, type OAuthConfig } from "./oauth-core.ts";
const config: OAuthConfig = {
  issuer: "https://auth.example.com",
  authorizationEndpoint: "https://auth.example.com/authorize",
  tokenEndpoint: "https://auth.example.com/token",
  clientId: "client",
  clientSecret: "client-secret-private",
  scope: "read",
  resource: "https://api.example.com/mcp",
  protectedUrl: "https://api.example.com/mcp",
  redirectUri: "https://app.example.com/oauth/callback",
};
const setup = () => {
  const rows = new Map<string, string>();
  const storage = {
    get: (kind: string, id: string) => rows.get(`${kind}/${id}`) ?? null,
    put: (kind: string, id: string, value: string) => {
      rows.set(`${kind}/${id}`, value);
    },
    take: (kind: string, id: string) => {
      const key = `${kind}/${id}`,
        value = rows.get(key) ?? null;
      rows.delete(key);
      return value;
    },
  };
  return { rows, oauth: makeOAuthStorage(storage, "ab".repeat(32)), storage };
};
const tokenResponse = (access = "access-private", expires = 1) =>
  Response.json({
    access_token: access,
    refresh_token: "refresh-private",
    token_type: "Bearer",
    expires_in: expires,
  });
afterEach(() => vi.unstubAllGlobals());

test("PKCE matches RFC 7636; credentials and flows are encrypted, bound and single-use", async () => {
  expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
  const { oauth, rows } = setup();
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const body = init.body as URLSearchParams;
    expect(await pkceChallenge(body.get("code_verifier")!)).toBe(
      new URL(started.url).searchParams.get("code_challenge"),
    );
    expect(body.get("resource")).toBe(config.resource);
    return tokenResponse();
  });
  vi.stubGlobal("fetch", fetcher);
  const started = await oauth.begin("conn", config),
    state = new URL(started.url).searchParams.get("state")!;
  expect([...rows.values()].join("")).not.toContain("client-secret-private");
  expect(await oauth.finish(state, "one-code", config.issuer)).toBe("conn");
  await expect(oauth.finish(state, "one-code")).rejects.toThrow("OAUTH_STATE_USED");
  expect(fetcher).toHaveBeenCalledTimes(1);
  const stored = [...rows.values()].join("");
  for (const secret of ["access-private", "refresh-private", "client-secret-private"])
    expect(stored).not.toContain(secret);
  await expect(oauth.token("conn", "https://other.example.com/mcp")).rejects.toThrow(
    "OAUTH_RESOURCE_MISMATCH",
  );
});

test("twenty concurrent token callers share exactly one rotating refresh", async () => {
  const { oauth } = setup();
  let refreshes = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      if ((init.body as URLSearchParams).get("grant_type") === "refresh_token") {
        refreshes++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return tokenResponse("fresh-access", 3600);
      }
      return tokenResponse();
    }),
  );
  const flow = await oauth.begin("conn", config);
  await oauth.finish(new URL(flow.url).searchParams.get("state")!, "code");
  expect(
    await Promise.all(Array.from({ length: 20 }, () => oauth.token("conn", config.protectedUrl))),
  ).toEqual(Array(20).fill("fresh-access"));
  expect(refreshes).toBe(1);
});

test("an evicted refresh cannot replay and disconnect cannot resurrect credentials", async () => {
  const { oauth, rows, storage } = setup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => tokenResponse()),
  );
  const flow = await oauth.begin("conn", config);
  await oauth.finish(new URL(flow.url).searchParams.get("state")!, "code");
  const ready = rows.get("oauth-credentials/conn")!;
  rows.set(
    "oauth-credentials/conn",
    JSON.stringify({ ...JSON.parse(ready), status: "refreshing" }),
  );
  const evicted = makeOAuthStorage(storage, "ab".repeat(32));
  await expect(evicted.token("conn", config.protectedUrl)).rejects.toThrow(
    "OAUTH_REAUTHORIZE_REQUIRED",
  );
  rows.set("oauth-credentials/conn", ready);
  let release!: (response: Response) => void;
  const entered = new Promise<void>((resolve) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        resolve();
        return new Promise<Response>((done) => {
          release = done;
        });
      }),
    ),
  );
  const refreshing = oauth.token("conn", config.protectedUrl);
  await entered;
  oauth.disconnect("conn");
  release(tokenResponse("new-access", 3600));
  await expect(refreshing).rejects.toThrow("OAUTH_REAUTHORIZE_REQUIRED");
  expect(oauth.status("conn")).toBe("disconnected");
});

test("new sign-in invalidates old callbacks and issuer mix-up consumes the state", async () => {
  const { oauth } = setup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => tokenResponse()),
  );
  const first = await oauth.begin("conn", config),
    second = await oauth.begin("conn", config);
  await expect(oauth.finish(new URL(first.url).searchParams.get("state")!, "code")).rejects.toThrow(
    "OAUTH_REVISION_CHANGED",
  );
  const state = new URL(second.url).searchParams.get("state")!;
  await expect(oauth.finish(state, "code", "https://evil.example.com")).rejects.toThrow(
    "OAUTH_FLOW_EXPIRED",
  );
  await expect(oauth.finish(state, "code")).rejects.toThrow("OAUTH_STATE_USED");
});

test("MCP discovery binds the resource, issuer and S256 requirement", async () => {
  const fetcher = vi.fn(async (url: string) =>
    String(url).includes("oauth-protected-resource")
      ? Response.json({ resource: config.resource, authorization_servers: [config.issuer] })
      : Response.json({
          issuer: config.issuer,
          authorization_endpoint: config.authorizationEndpoint,
          token_endpoint: config.tokenEndpoint,
          code_challenge_methods_supported: ["S256"],
          client_id_metadata_document_supported: true,
        }),
  );
  vi.stubGlobal("fetch", fetcher);
  expect(await discoverOAuth(config.resource!)).toMatchObject({
    issuer: config.issuer,
    cimd: true,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        resource: "https://evil.example.com",
        authorization_servers: [config.issuer],
      }),
    ),
  );
  await expect(discoverOAuth(config.resource!)).rejects.toThrow("OAUTH_RESOURCE_MISMATCH");
});

test("confidential clients use encoded HTTP Basic credentials and never follow token redirects", async () => {
  const { oauth } = setup();
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${btoa("client%3Aid:secret%2Bvalue")}`);
    expect((init.body as URLSearchParams).has("client_secret")).toBe(false);
    expect(init.redirect).toBe("manual");
    return new Response(null, { status: 302, headers: { Location: "https://evil.example.com" } });
  });
  vi.stubGlobal("fetch", fetcher);
  const flow = await oauth.begin("conn", {
    ...config,
    clientId: "client:id",
    clientSecret: "secret+value",
    authMethod: "client_secret_basic",
  });
  await expect(oauth.finish(new URL(flow.url).searchParams.get("state")!, "code")).rejects.toThrow(
    "REDIRECT_DENIED",
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(oauth.status("conn")).toBe("disconnected");
});
