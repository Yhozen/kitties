import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import { APPLICATION, ISSUER, certificates, issuerState, servers } from "./fixture.mjs";

const verifier = "v".repeat(43);
const callback = "http://127.0.0.1:43210/oauth/callback/" + "r".repeat(43);

const registration = {
  client_name: "Kitties Desktop",
  redirect_uris: [callback],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code"],
  response_types: ["code"],
};

const challenge = createHash("sha256").update(verifier).digest("base64url");

const authorization = (clientId, changes = {}) =>
  new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: callback,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state: "s".repeat(43),
    resource: APPLICATION,
    ...changes,
  });

// Assertions retain only the refusal bit, so a broken issuer cannot print an
// accidentally issued bearer token into a failing test's diagnostic output.
const refuses = (effect) =>
  effect.then(
    () => false,
    (error) => error.message === "invalid_request",
  );

const fixture = () => {
  let time = 1000000;
  let issues = 0;

  const state = issuerState(
    {
      issue: async (ttlMs) => {
        issues++;

        return { key: "native-private-session", expiresAt: time + ttlMs };
      },
    },
    () => time,
  );

  const allowed = () => {
    const client = state.register(registration).client_id;
    const transaction = state.authorize(authorization(client));
    const location = new URL(state.decide({ transaction, decision: "allow" }));

    return {
      grant_type: "authorization_code",
      client_id: client,
      redirect_uri: callback,
      code: location.searchParams.get("code"),
      code_verifier: verifier,
      resource: APPLICATION,
    };
  };

  return {
    state,
    allowed,
    issues: () => issues,
    advance: (millis) => {
      time += millis;
    },
  };
};

test("the explicit consent binds state/issuer to the exact registered one-use loopback redirect and denial issues nothing", () => {
  const { state, issues } = fixture();
  expect(() =>
    state.register({ ...registration, redirect_uris: ["https://example.test/callback"] }),
  ).toThrow("invalid_request");
  const client = state.register(registration).client_id;
  expect(() =>
    state.authorize(authorization(client, { redirect_uri: callback.replace("43210", "43211") })),
  ).toThrow("invalid_request");
  expect(() => state.authorize(authorization(client, { resource: ISSUER }))).toThrow(
    "invalid_request",
  );
  const duplicate = authorization(client);
  duplicate.append("state", "x".repeat(43));
  expect(() => state.authorize(duplicate)).toThrow("invalid_request");
  const transaction = state.authorize(authorization(client));
  expect(() => state.authorize(authorization(client))).toThrow("invalid_request");
  const location = new URL(state.decide({ transaction, decision: "deny" }));
  expect(location.origin + location.pathname).toBe(callback);
  expect(Object.fromEntries(location.searchParams)).toEqual({
    state: "s".repeat(43),
    iss: ISSUER,
    error: "access_denied",
  });
  expect(() => state.decide({ transaction, decision: "allow" })).toThrow("invalid_request");
  expect(issues()).toBe(0);
  expect(state.evidence().live.tokens).toBe(0);
});

test("S256 mismatch consumes a code without issuing a native session; valid exchange is bound to client/resource/redirect and is single-use", async () => {
  const { state, allowed, issues } = fixture();
  const wrongVerifier = allowed();
  expect(await refuses(state.exchange({ ...wrongVerifier, code_verifier: "w".repeat(43) }))).toBe(
    true,
  );
  expect(await refuses(state.exchange(wrongVerifier))).toBe(true);
  expect(issues()).toBe(0);
  const wrongClient = allowed();
  expect(await refuses(state.exchange({ ...wrongClient, client_id: "x".repeat(43) }))).toBe(true);
  const wrongResource = allowed();
  expect(await refuses(state.exchange({ ...wrongResource, resource: ISSUER }))).toBe(true);
  const wrongRedirect = allowed();
  expect(
    await refuses(
      state.exchange({ ...wrongRedirect, redirect_uri: callback.replace("43210", "43211") }),
    ),
  ).toBe(true);
  expect(issues()).toBe(0);
  const valid = allowed();
  const token = await state.exchange(valid);
  expect(token.token_type).toBe("Bearer");
  expect(token.expires_in).toBe(60);
  expect(state.authenticate(`Bearer ${token.access_token}`).native.key).toBe(
    "native-private-session",
  );
  expect(await refuses(state.exchange(valid))).toBe(true);
  expect(issues()).toBe(1);
  const redacted = JSON.stringify(state.evidence());
  expect(redacted.includes(token.access_token)).toBe(false);
  expect(redacted.includes(valid.code)).toBe(false);
  expect(redacted.includes("native-private-session")).toBe(false);
  expect(redacted.includes(verifier)).toBe(false);
});

test("expired consent/code cannot issue credentials and a three-second token closes owned streams at expiry or explicit revocation", async () => {
  const world = fixture();
  const client = world.state.register(registration).client_id;
  world.advance(180000);
  expect(() => world.state.authorize(authorization(client))).toThrow("invalid_request");
  const expiredCode = world.allowed();
  world.advance(30000);
  expect(await refuses(world.state.exchange(expiredCode))).toBe(true);
  world.state.lifetime(3);
  const token = await world.state.exchange(world.allowed());
  expect(token.expires_in).toBe(3);
  let closed = 0;
  world.state.authenticate(`Bearer ${token.access_token}`).streams.add(() => {
    closed++;
  });
  world.advance(3000);
  expect(() => world.state.authenticate(`Bearer ${token.access_token}`)).toThrow("invalid_request");
  expect(closed).toBe(1);
  const next = await world.state.exchange(world.allowed());
  expect(next.expires_in).toBe(60);
  world.state.authenticate(`Bearer ${next.access_token}`).streams.add(() => {
    closed++;
  });
  world.state.revoke();
  expect(() => world.state.authenticate(`Bearer ${next.access_token}`)).toThrow("invalid_request");
  expect(closed).toBe(2);
});

test("issuer live registration inventory is bounded and expiration frees capacity", () => {
  const world = fixture();

  for (let index = 0; index < 128; index++) world.state.register(registration);
  expect(() => world.state.register(registration)).toThrow("invalid_request");
  expect(world.state.evidence().live.clients).toBe(128);
  world.advance(180000);
  expect(world.state.register(registration).client_id).toHaveLength(43);
  expect(world.state.evidence().live.clients).toBe(1);
});

const request = (transport, options, data) =>
  new Promise((resolveReply, reject) => {
    const req = transport(options, (reply) => {
      let text = "";
      reply.on("data", (chunk) => {
        text += chunk;
      });
      reply.on("error", reject);
      reply.on("end", () =>
        resolveReply({ status: reply.statusCode, headers: reply.headers, text }),
      );
    });

    req.setTimeout(5000, () => req.destroy(Error("Test request deadline")));
    req.on("error", reject);
    req.end(data);
  });

test("HTTPS discovery and real consent form preserve TLS validation; exact proxy paths require a valid token and controls refuse browser callers", async () => {
  const tls = certificates();
  const issued = [];
  const observed = [];

  const backend = {
    issue: async (ttlMs) => {
      issued.push(ttlMs);

      return { key: "private-native-key", expiresAt: Date.now() + ttlMs };
    },
    fixture: async () => ({ sends: 0 }),
  };

  const native = createServer((req, res) => {
    observed.push({ path: req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.end('{"_tag":"Exit","requestId":"one","exit":{"_tag":"Success","value":null}}\n');
  });

  native.listen(0, "127.0.0.1");
  await once(native, "listening");

  const live = await servers({
    backend,
    upstream: new URL(`http://127.0.0.1:${native.address().port}`),
    tls,
    httpsPort: 0,
    controlPort: 0,
  });

  const options = (path, fields = {}) => ({
    hostname: "127.0.0.1",
    port: live.https.address().port,
    servername: "issuer.kitties.test",
    ca: readFileSync(tls.caPath),
    path,
    headers: { host: "issuer.kitties.test:9443" },
    ...fields,
  });

  try {
    const metadata = await request(
      httpsRequest,
      options("/.well-known/oauth-authorization-server"),
    );

    expect(JSON.parse(metadata.text)).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: ISSUER + "/authorize",
    });
    await expect(
      request(httpsRequest, { ...options("/.well-known/oauth-authorization-server"), ca: [] }),
    ).rejects.toThrow(/certificate|issuer/i);

    const register = await request(
      httpsRequest,
      options("/register", {
        method: "POST",
        headers: { host: "issuer.kitties.test:9443", "content-type": "application/json" },
      }),
      JSON.stringify(registration),
    );

    const client = JSON.parse(register.text).client_id;
    const consent = await request(httpsRequest, options("/authorize?" + authorization(client)));
    expect(consent.status).toBe(200);
    expect(consent.headers["referrer-policy"]).toBe("origin");
    expect(consent.text).toContain('action="/decision"');
    expect(consent.text).toContain(">Authorize Kitties Desktop</button>");
    expect(consent.text).toContain(">Deny sign-in</button>");
    expect(consent.text).not.toContain("s".repeat(43));
    const transaction = /name="transaction" value="([A-Za-z0-9_-]+)"/.exec(consent.text)[1];

    for (const origin of [undefined, "null", "https://foreign.test"]) {
      const headers = {
        host: "issuer.kitties.test:9443",
        "content-type": "application/x-www-form-urlencoded",
      };

      if (origin !== undefined) headers.origin = origin;

      const refused = await request(
        httpsRequest,
        options("/decision", { method: "POST", headers }),
        new URLSearchParams({ transaction, decision: "allow" }).toString(),
      );

      expect(refused.status).toBe(400);
    }

    expect(issued).toEqual([]);

    const decision = await request(
      httpsRequest,
      options("/decision", {
        method: "POST",
        headers: {
          host: "issuer.kitties.test:9443",
          origin: ISSUER,
          "content-type": "application/x-www-form-urlencoded",
        },
      }),
      new URLSearchParams({ transaction, decision: "allow" }).toString(),
    );

    expect(decision.status).toBe(303);
    const callbackLocation = new URL(decision.headers.location);
    expect(callbackLocation.origin + callbackLocation.pathname).toBe(callback);

    // Inspect only. No request is sent to a native callback from this protocol test.
    const exchange = {
      grant_type: "authorization_code",
      client_id: client,
      redirect_uri: callback,
      code: callbackLocation.searchParams.get("code"),
      code_verifier: verifier,
      resource: APPLICATION,
    };

    const tokenReply = await request(
      httpsRequest,
      options("/token", {
        method: "POST",
        headers: {
          host: "issuer.kitties.test:9443",
          "content-type": "application/x-www-form-urlencoded",
        },
      }),
      new URLSearchParams(exchange).toString(),
    );

    const token = JSON.parse(tokenReply.text).access_token;
    expect(issued).toEqual([60000]);

    const proxyOptions = options("/v1/library/rpc", {
      method: "POST",
      headers: {
        host: "app.kitties.test:9443",
        "content-type": "application/x-ndjson",
        authorization: `Bearer ${token}`,
        "x-kitties-library-epoch": "1",
      },
    });

    const reply = await request(httpsRequest, proxyOptions, '{"native":"frame"}\n');
    expect(reply.text).toBe(
      '{"_tag":"Exit","requestId":"one","exit":{"_tag":"Success","value":null}}\n',
    );
    expect(observed).toHaveLength(1);
    expect(observed[0].headers["x-local-session"]).toBe("private-native-key");
    expect(observed[0].headers.authorization).toBe("Bearer validated-local-oauth");

    const bad = await request(
      httpsRequest,
      {
        ...proxyOptions,
        headers: { ...proxyOptions.headers, authorization: "Bearer " + "z".repeat(43) },
      },
      "{}\n",
    );

    expect(bad.status).toBe(401);
    const arbitrary = await request(httpsRequest, { ...proxyOptions, path: "/fixture" }, "{}\n");
    expect(arbitrary.status).toBe(400);

    const query = await request(
      httpsRequest,
      { ...proxyOptions, path: "/v1/library/rpc?arbitrary=1" },
      "{}\n",
    );

    expect(query.status).toBe(400);

    const local = {
      hostname: "127.0.0.1",
      port: live.control.address().port,
      path: "/control",
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-mode": "cors" },
    };

    expect((await request(httpRequest, local, '{"action":"revokeAll"}')).status).toBe(400);
    expect(
      (
        await request(
          httpRequest,
          { ...local, headers: { "content-type": "application/json" } },
          '{"action":"revokeAll"}',
        )
      ).status,
    ).toBe(200);
    expect((await request(httpsRequest, proxyOptions, "{}\n")).status).toBe(401);
    expect(observed).toHaveLength(1);
  } finally {
    await live.close();
    await new Promise((done) => native.close(done));
  }
});
