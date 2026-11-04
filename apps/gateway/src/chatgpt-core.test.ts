import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { makeChatgptStorage, verifyChatgptIdentity } from "./chatgpt-core.ts";
import { chatgptConfig as config } from "./chatgpt-config.ts";
import { pkceChallenge } from "./oauth-core.ts";
let key: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: JsonWebKey;
beforeAll(async () => {
  key = await generateKeyPair("RS256");
  jwk = { ...(await exportJWK(key.publicKey)), kid: "test-key", alg: "RS256" } as JsonWebKey;
});
afterEach(() => vi.unstubAllGlobals());
const redirectUri = "http://127.0.0.1:45678/auth/callback";
const signed = (nonce: string, claims: Record<string, unknown> = {}) =>
  new SignJWT({
    iss: config.issuer,
    sub: "subject-owner",
    aud: "oaiapp_test",
    nonce,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: "owner@example.com",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .sign(key.privateKey);
const setup = () => {
  const rows = new Map<string, string>();
  const storage = {
    get: (kind: string, id: string) => rows.get(`${kind}/${id}`) ?? null,
    put: (kind: string, id: string, body: string) => {
      rows.set(`${kind}/${id}`, body);
    },
    take: (kind: string, id: string) => {
      const value = rows.get(`${kind}/${id}`) ?? null;
      rows.delete(`${kind}/${id}`);
      return value;
    },
    list: (kind: string) =>
      [...rows]
        .filter(([key]) => key.startsWith(kind + "/"))
        .map(([key, body]) => ({ id: key.slice(kind.length + 1), body })),
  };
  const ctx = { epoch: 0, hostId: "urn:uuid:stable-stage-host" };
  const store = () => makeChatgptStorage(storage, "ab".repeat(32), async () => ctx);
  const core = store();
  let authorize: URL,
    scopes: string = config.scope,
    expires = 3600,
    claims: Record<string, unknown> = {};
  const counts = { exchanges: 0, refreshes: 0, inference: 0, revocations: 0 };
  let onRefresh: (() => Promise<Response>) | undefined;
  let catalog: unknown = {
    models: [
      { slug: "second", display_name: "Second", visibility: "list" },
      { slug: "hidden", visibility: "hide" },
      { slug: "first", display_name: "First", visibility: "list" },
    ],
  };
  let stream = 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';
  const tokenResponse = async (refreshed = false) =>
    Response.json({
      access_token: refreshed ? "fresh-access-private" : "access-private",
      refresh_token: "refresh-private",
      token_type: "Bearer",
      id_token: await signed(authorize.searchParams.get("nonce")!, claims),
      expires_in: refreshed ? 3600 : expires,
      scope: scopes,
    });
  const fetcher = vi.fn(
    async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const endpoint = url instanceof Request ? url.url : url.toString();
      if (endpoint === config.jwksUri) return Response.json({ keys: [jwk] });
      if (endpoint === config.tokenEndpoint) {
        const body = init!.body as URLSearchParams;
        expect(init?.redirect).toBe("manual");
        expect(body.get("resource")).toBe(config.resource);
        expect(body.get("client_id")).toBe("oaiapp_test");
        expect(body.has("client_secret")).toBe(false);
        if (body.get("grant_type") === "refresh_token") {
          counts.refreshes++;
          expect(body.has("scope")).toBe(false);
          expect(body.get("refresh_token")).toBe("refresh-private");
          return onRefresh ? onRefresh() : tokenResponse(true);
        }
        counts.exchanges++;
        expect(body.get("redirect_uri")).toBe(redirectUri);
        expect(await pkceChallenge(body.get("code_verifier")!)).toBe(
          authorize.searchParams.get("code_challenge"),
        );
        return tokenResponse();
      }
      if (endpoint === config.resource + "/models") {
        expect(new Headers(init?.headers).get("Authorization")).toMatch(
          /^Bearer (?:fresh-)?access-private$/,
        );
        return Response.json(catalog, { headers: { "x-request-id": "req_catalog" } });
      }
      if (endpoint === config.resource + "/responses") {
        counts.inference++;
        expect(JSON.parse(init?.body as string)).toEqual({
          model: "second",
          input: [{ role: "user", content: "Say exactly: Hello, world!" }],
          store: false,
          stream: true,
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream", "x-request-id": "req_probe" },
        });
      }
      if (endpoint === config.discoveryUri)
        return Response.json({
          issuer: config.issuer,
          revocation_endpoint: config.issuer + "/revoke",
        });
      if (endpoint === config.issuer + "/revoke") {
        counts.revocations++;
        return new Response(null, { status: 200 });
      }
      throw Error("Unexpected endpoint");
    },
  );
  vi.stubGlobal("fetch", fetcher);
  const begin = async (accountId?: string) => {
    const attempt = await core.begin({ redirectUri, accountId });
    authorize = new URL(await core.authorize(attempt.id));
    return {
      attempt,
      url: authorize,
      callback: {
        state: authorize.searchParams.get("state")!,
        code: "code-private",
        clientId: "oaiapp_test",
      },
    };
  };
  const connect = async () => {
    const flow = await begin();
    await core.finish(flow.callback);
    return flow.attempt.accountId!;
  };
  return {
    rows,
    storage,
    ctx,
    store,
    core,
    counts,
    fetcher,
    begin,
    connect,
    setScopes: (v: string) => {
      scopes = v;
    },
    setExpiry: (v: number) => {
      expires = v;
    },
    setClaims: (v: Record<string, unknown>) => {
      claims = v;
    },
    setRefresh: (v: () => Promise<Response>) => {
      onRefresh = v;
    },
    setStream: (v: string) => {
      stream = v;
    },
    setCatalog: (value: unknown) => {
      catalog = value;
    },
    tokenResponse,
  };
};
test("account catalogs can exceed the OAuth response bound without retaining extra metadata", async () => {
  const f = setup(),
    id = await f.connect();
  f.setCatalog({
    models: [
      {
        slug: "second",
        display_name: "Second",
        visibility: "list",
        description: "x".repeat(656000),
      },
      { slug: "hidden", visibility: "hide" },
      { slug: "first", display_name: "First", visibility: "list" },
    ],
  });
  expect(await f.core.models(id)).toEqual([
    { slug: "second", displayName: "Second" },
    { slug: "first", displayName: "First" },
  ]);
  expect(await f.core.probe(id)).toMatchObject({ ok: true, model: "second" });
  expect([...f.rows.values()].join("")).not.toContain("x".repeat(100));
});
test("oversized catalogs return a sanitized bounded error with their request ID", async () => {
  const f = setup(),
    id = await f.connect();
  f.setCatalog({ models: [], privateMetadata: "x".repeat(4 * 1024 * 1024) });
  expect(await f.core.probe(id)).toEqual({
    ok: false,
    error: {
      reason: "unsupported_request",
      code: "CHATGPT_CATALOG_TOO_LARGE",
      status: 200,
      requestId: "req_catalog",
      bodyShape: "other",
    },
  });
});
test("dynamic registration, verified identity, encrypted credentials, catalog ordering and real completion gate", async () => {
  const f = setup(),
    flow = await f.begin();
  expect(flow.url.origin + flow.url.pathname).toBe(config.authorizationEndpoint);
  expect(flow.url.searchParams.get("client_id")).toBe("dynamic_agent_client");
  expect(flow.url.searchParams.get("agent_name_hint")).toBe("Kitties");
  expect(flow.url.searchParams.get("ext_agent_host_id")).toBe(f.ctx.hostId);
  await f.core.finish(flow.callback);
  const id = flow.attempt.accountId!;
  expect(await f.core.account(id)).toMatchObject({
    status: "connected",
    subject: "subject-owner",
    clientId: "oaiapp_test",
  });
  expect((await f.core.account(id)).admittedAt).toBeUndefined();
  expect(await f.core.models(id)).toEqual([
    { slug: "second", displayName: "Second" },
    { slug: "first", displayName: "First" },
  ]);
  expect(await f.core.probe(id)).toMatchObject({ ok: true, model: "second" });
  expect((await f.core.account(id)).admittedAt).toBeGreaterThan(0);
  const stored = [...f.rows.values()].join("");
  for (const secret of [
    "access-private",
    "refresh-private",
    "code-private",
    flow.url.searchParams.get("nonce")!,
  ])
    expect(stored).not.toContain(secret);
  expect(f.counts).toMatchObject({ exchanges: 1, inference: 1 });
});
test("callback replay, wrong state, wrong issuer, cancellation and expiry never exchange a code", async () => {
  const f = setup(),
    first = await f.begin();
  await f.core.finish(first.callback);
  await expect(f.core.finish(first.callback)).rejects.toThrow("CHATGPT_STATE_USED");
  await expect(f.core.finish({ ...first.callback, state: "wrong" })).rejects.toThrow(
    "CHATGPT_STATE_USED",
  );
  const mixed = await f.begin();
  await expect(
    f.core.finish({ ...mixed.callback, issuer: "https://evil.example" }),
  ).rejects.toThrow("CHATGPT_STATE_INVALID");
  const cancel = await f.begin();
  await f.core.cancel(cancel.attempt.id);
  await expect(f.core.finish(cancel.callback)).rejects.toThrow();
  const expiry = await f.begin();
  const name = "chatgpt-link/" + expiry.attempt.id,
    row = JSON.parse(f.rows.get(name)!);
  row.view.expiresAt = Date.now() - 1;
  f.rows.set(name, JSON.stringify(row));
  await expect(f.core.finish(expiry.callback)).rejects.toThrow();
  expect(f.counts.exchanges).toBe(1);
  const denied = await f.begin();
  expect(
    await f.core.finish({ state: denied.callback.state, error: "access_denied" }),
  ).toMatchObject({ status: "denied" });
});
test.each([
  { iss: "https://evil.example" },
  { aud: "wrong-client" },
  { nonce: "wrong-nonce" },
  { exp: 0 },
  { sub: "" },
  { iat: undefined },
])("signed ID token rejects invalid required claims %j", async (claims) => {
  const f = setup(),
    flow = await f.begin();
  f.setClaims(claims);
  await expect(f.core.finish(flow.callback)).rejects.toThrow("CHATGPT_IDENTITY_INVALID");
  expect(await f.core.accounts()).toEqual([]);
});
test("ID-token signature is verified", async () => {
  setup();
  const original = await signed("nonce");
  const parts = original.split(".");
  parts[2] = (parts[2]![0] === "a" ? "b" : "a") + parts[2]!.slice(1);
  await expect(verifyChatgptIdentity(parts.join("."), "oaiapp_test", "nonce")).rejects.toThrow(
    "CHATGPT_IDENTITY_INVALID",
  );
});
test("reconnect reuses the issued registration, rejects account/client mismatch, preserves active credentials", async () => {
  const f = setup(),
    id = await f.connect(),
    flow = await f.begin(id);
  expect(flow.url.searchParams.get("client_id")).toBe("oaiapp_test");
  expect(flow.url.searchParams.has("agent_name_hint")).toBe(false);
  expect(flow.url.searchParams.has("id_token_hint")).toBe(true);
  f.setClaims({ sub: "other-owner" });
  await expect(f.core.finish(flow.callback)).rejects.toThrow("CHATGPT_ACCOUNT_MISMATCH");
  expect((await f.core.account(id)).subject).toBe("subject-owner");
  expect((await f.core.models(id)).length).toBe(2);
  const wrongClient = await f.begin(id);
  await expect(
    f.core.finish({ ...wrongClient.callback, clientId: "oaiapp_other" }),
  ).rejects.toThrow("CHATGPT_CLIENT_MISMATCH");
  expect((await f.core.account(id)).status).toBe("connected");
});
test("a valid identity without subscription scope stays signed in and cannot infer", async () => {
  const f = setup();
  f.setScopes("openid profile email offline_access");
  const id = await f.connect();
  expect((await f.core.account(id)).status).toBe("consent_required");
  expect(await f.core.probe(id)).toMatchObject({
    ok: false,
    error: { reason: "consent_required" },
  });
  expect(f.counts.inference).toBe(0);
});
test("twenty simultaneous model callers serialize one rotating refresh", async () => {
  const f = setup();
  f.setExpiry(1);
  const id = await f.connect();
  await Promise.all(Array.from({ length: 20 }, () => f.core.models(id)));
  expect(f.counts.refreshes).toBe(1);
});
test("explicit temporary refresh failure preserves credentials for an operator retry", async () => {
  const f = setup();
  f.setExpiry(1);
  const id = await f.connect();
  f.setRefresh(async () => Response.json({ error: "temporarily_unavailable" }, { status: 503 }));
  await expect(f.core.models(id)).rejects.toThrow("temporarily_unavailable");
  expect((await f.core.account(id)).status).toBe("connected");
  expect(JSON.parse(f.rows.get("chatgpt-account/" + id)!).credentials).toBeDefined();
  f.setRefresh(() => f.tokenResponse(true));
  await f.core.models(id);
  expect(f.counts.refreshes).toBe(2);
});
test.each(["invalid_grant", "refresh_token_reused"])(
  "terminal refresh %s requires relinking",
  async (code) => {
    const f = setup();
    f.setExpiry(1);
    const id = await f.connect();
    f.setRefresh(async () => Response.json({ error: code }, { status: 400 }));
    await expect(f.core.models(id)).rejects.toThrow(code);
    expect((await f.core.account(id)).status).toBe("reauthorize");
    expect(JSON.parse(f.rows.get("chatgpt-account/" + id)!).credentials).toBeUndefined();
  },
);
test("lost refresh response and an interrupted durable marker cannot replay an old token", async () => {
  const f = setup();
  f.setExpiry(1);
  const id = await f.connect();
  f.setRefresh(async () => {
    throw Error("network-private");
  });
  await expect(f.core.models(id)).rejects.toThrow("CHATGPT_UNAVAILABLE");
  expect((await f.core.account(id)).status).toBe("reauthorize");
  await expect(f.core.models(id)).rejects.toThrow();
  expect(f.counts.refreshes).toBe(1);
  const g = setup();
  g.setExpiry(1);
  const another = await g.connect(),
    name = "chatgpt-account/" + another,
    row = JSON.parse(g.rows.get(name)!);
  row.refreshing = true;
  g.rows.set(name, JSON.stringify(row));
  await expect(g.store().models(another)).rejects.toThrow("CHATGPT_REFRESH_OUTCOME_UNKNOWN");
  expect(g.counts.refreshes).toBe(0);
});
test("disconnect during refresh clears tokens, revokes remotely and fences the late response", async () => {
  const f = setup();
  f.setExpiry(1);
  const id = await f.connect();
  let release!: (r: Response) => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.setRefresh(() => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const pending = f.core.models(id);
  await ready;
  expect(await f.core.disconnect(id)).toEqual({ revocationConfirmed: false });
  release(await f.tokenResponse(true));
  await expect(pending).rejects.toThrow("CHATGPT_REVISION_CHANGED");
  expect((await f.core.account(id)).status).toBe("disconnected");
  expect(JSON.parse(f.rows.get("chatgpt-account/" + id)!).credentials).toBeUndefined();
  expect(f.counts.revocations).toBe(1);
});
test("recovery changes invalidate credentials and pending callbacks while preserving the host identity", async () => {
  const f = setup(),
    id = await f.connect(),
    flow = await f.begin();
  f.ctx.epoch++;
  await expect(f.core.finish(flow.callback)).rejects.toThrow();
  expect((await f.core.account(id)).status).toBe("reauthorize");
  expect((await f.core.account(id)).hostId).toBe(f.ctx.hostId);
  await expect(f.core.models(id)).rejects.toThrow();
  expect(f.counts.exchanges).toBe(1);
});
test("probe rejects failed, incomplete and truncated streams, including a quota error after text", async () => {
  const f = setup(),
    id = await f.connect();
  for (const [stream, reason] of [
    ['data: {"type":"response.output_text.delta","delta":"partial"}\n\n', "interrupted"],
    ['data: {"type":"response.incomplete"}\n\n', "incomplete"],
    [
      'data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"secret-private"}}}\n\n',
      "usage_limit",
    ],
  ]) {
    f.setStream(stream);
    const result = await f.core.probe(id);
    expect(result).toMatchObject({ ok: false, error: { reason } });
    expect(JSON.stringify(result)).not.toContain("secret-private");
    expect((await f.core.account(id)).admittedAt).toBeUndefined();
  }
});

test("an unsuccessful first exchange retains the issued client for a fresh retry", async () => {
  const f = setup(),
    flow = await f.begin();
  f.fetcher.mockImplementationOnce(async () =>
    Response.json({ error: "invalid_grant" }, { status: 400 }),
  );
  await expect(f.core.finish(flow.callback)).rejects.toThrow("invalid_grant");
  expect(await f.core.attempt(flow.attempt.id)).toMatchObject({
    status: "failed",
    canRetryRegistration: true,
  });
  const next = await f.core.begin({ redirectUri, retryAttemptId: flow.attempt.id });
  const url = new URL(await f.core.authorize(next.id));
  expect(url.searchParams.get("client_id")).toBe("oaiapp_test");
  expect(url.searchParams.has("agent_name_hint")).toBe(false);
  expect(url.searchParams.get("state")).not.toBe(flow.callback.state);
  expect(url.searchParams.get("code_challenge")).not.toBe(
    flow.url.searchParams.get("code_challenge"),
  );
});
test("refresh scope loss retains verified identity and credentials but disables plan usage", async () => {
  const f = setup();
  f.setExpiry(1);
  const id = await f.connect();
  f.setScopes("openid email offline_access");
  await expect(f.core.models(id)).rejects.toThrow("CHATGPT_CONSENT_REQUIRED");
  expect((await f.core.account(id)).status).toBe("consent_required");
  expect(JSON.parse(f.rows.get("chatgpt-account/" + id)!).credentials).toBeDefined();
});
test("reconnect during a refresh fences the stale token response", async () => {
  const f = setup();
  f.setExpiry(1);
  const id = await f.connect();
  let entered!: () => void, release!: (r: Response) => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.setRefresh(() => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const pending = f.core.models(id);
  await ready;
  f.setExpiry(3600);
  const next = await f.begin(id);
  await f.core.finish({ ...next.callback, clientId: undefined });
  release(await f.tokenResponse(true));
  await expect(pending).rejects.toThrow("CHATGPT_REVISION_CHANGED");
  expect((await f.core.account(id)).status).toBe("connected");
  await f.core.models(id);
});
test("restored copies of consumed links and credentials remain fenced by the external epoch", async () => {
  const f = setup(),
    flow = await f.begin(),
    snapshot = new Map(f.rows);
  await f.core.finish(flow.callback);
  f.ctx.epoch++;
  f.rows.clear();
  for (const [key, value] of snapshot) f.rows.set(key, value);
  await expect(f.core.finish(flow.callback)).rejects.toThrow("CHATGPT_LINK_EXPIRED");
  expect(f.counts.exchanges).toBe(1);
});

test("a successful refresh without a replacement refresh token requires relinking", async () => {
  const f = setup();
  f.setExpiry(1);
  const id = await f.connect();
  f.setRefresh(async () => {
    const response = await f.tokenResponse(true);
    const body = (await response.json()) as Record<string, unknown>;
    delete body.refresh_token;
    return Response.json(body);
  });
  await expect(f.core.models(id)).rejects.toThrow("CHATGPT_INVALID_TOKEN_RESPONSE");
  expect((await f.core.account(id)).status).toBe("reauthorize");
});
