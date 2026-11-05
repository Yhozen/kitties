import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import * as DomainFoldkit from "@alchemy.run/domain/Foldkit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { LibraryApi } from "../../../packages/domain/src/LibraryApi.api.ts";
import {
  APPLICATION,
  ISSUER,
  certificates,
  commandObserver,
  issuerState,
  replyLoss,
  servers,
} from "./fixture.mjs";

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

const requestLiteral = JSON.parse(
  '{"_tag":"Request","id":1,"tag":"ProposeSkill","payload":{"target":"owner","commandId":"library:1:gate:0","input":{"name":"Keep","body":"Private original body"}},"headers":[]}',
);

const successLiteral = JSON.parse(
  '{"_tag":"Exit","requestId":1,"exit":{"_tag":"Success","value":{"stream":"Library/owner","version":2,"reply":{"skillId":"kitties-skill-0000000000000001","proposalRevision":2}}}}',
);

test("pinned NDJSON numeric and string IDs correlate separately, including null replies, with bounded body-free observations", () => {
  const events = [];
  const observer = commandObserver((event, fields) => events.push({ event, ...fields }));
  const parser = RpcSerialization.makeNdjson({ maxBufferSize: 32768 }).makeUnsafe();

  for (const id of [1, "1"]) {
    const bytes = Buffer.from(parser.encode({ ...requestLiteral, id }));
    observer.request(bytes.subarray(0, 13));
    observer.request(bytes.subarray(13));
    observer.reply(Buffer.from(parser.encode({ ...successLiteral, requestId: id })));
  }

  const accepting = {
    ...requestLiteral,
    id: 2,
    tag: "AcceptSkill",
    payload: {
      target: "owner",
      commandId: "library:1:gate:1",
      input: { skillId: "kitties-skill-0000000000000001", expectedProposalRevision: 2 },
    },
  };

  observer.request(Buffer.from(parser.encode(accepting)));
  observer.reply(Buffer.from(parser.encode({ ...successLiteral, requestId: "2" })));
  expect(events.filter((event) => event.event === "domain-receipt")).toHaveLength(2);
  observer.reply(
    Buffer.from(
      parser.encode({
        ...successLiteral,
        requestId: 2,
        exit: {
          ...successLiteral.exit,
          value: { stream: "Library/owner", version: 3, reply: null },
        },
      }),
    ),
  );
  expect(
    events
      .values()
      .filter((event) => event.event === "domain-receipt")
      .map((event) => [event.requestId, event.version, event.reply])
      .toArray(),
  ).toEqual([
    [1, 2, { skillId: "kitties-skill-0000000000000001", proposalRevision: 2 }],
    ["1", 2, { skillId: "kitties-skill-0000000000000001", proposalRevision: 2 }],
    [2, 3, null],
  ]);
  expect(JSON.stringify(events).includes("Private original body")).toBe(false);
  expect(events[0].inputSha256).toBe(
    createHash("sha256")
      .update('{"name":"Keep","body":"Private original body"}')
      .digest("base64url"),
  );
});

test("reply loss has one bounded pending selection, preserves request-ID type and expires unused without touching unrelated commands", () => {
  let now = 1000;

  const loss = replyLoss(
    () => {},
    () => now,
  );

  expect(loss.arm("ProposeSkill", 20)).toEqual({
    armed: true,
    tag: "ProposeSkill",
    expiresAt: 1020,
    maxReplyBytes: 32768,
  });
  expect(() => loss.arm("RemoveSkill", 20)).toThrow("invalid_request");
  expect(loss.claim({ tag: "RemoveSkill", requestId: 1, commandId: "library:1:gate:0" })).toBe(
    false,
  );
  now = 1020;
  expect(loss.status().phase).toBe("expired");
  loss.arm("ProposeSkill", 20);
  const command = { tag: "ProposeSkill", requestId: 1, commandId: "library:1:gate:0" };
  expect(loss.claim(command)).toBe(true);
  loss.finish({ ...command, requestId: "1" }, "dropped");
  expect(loss.status().phase).toBe("claimed");
  loss.finish(command, "dropped");
  expect(loss.status().phase).toBe("dropped");

  for (let index = 0; index < 126; index++) {
    loss.arm("ProposeSkill", 1);
    now++;
    loss.status();
  }

  expect(() => loss.arm("ProposeSkill", 1)).toThrow("invalid_request");
});

const withCommandProxy = async (respond, use) => {
  const tls = certificates();
  const requests = [];

  const native = createServer(async (req, res) => {
    const chunks = [];

    for await (const chunk of req) chunks.push(chunk);
    const parser = RpcSerialization.makeNdjson({ maxBufferSize: 32768 }).makeUnsafe();
    const frames = parser.decode(Buffer.concat(chunks));
    requests.push(frames);
    await respond(frames, res);
  });

  native.listen(0, "127.0.0.1");
  await once(native, "listening");

  const live = await servers({
    backend: {
      issue: async (ttlMs) => ({ key: "test-native-only", expiresAt: Date.now() + ttlMs }),
    },
    upstream: new URL(`http://127.0.0.1:${native.address().port}`),
    tls,
    httpsPort: 0,
    controlPort: 0,
  });

  try {
    const clientId = live.state.register(registration).client_id;
    const transaction = live.state.authorize(authorization(clientId));
    const callback = new URL(live.state.decide({ transaction, decision: "allow" }));

    const token = await live.state.exchange({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: registration.redirect_uris[0],
      code: callback.searchParams.get("code"),
      code_verifier: verifier,
      resource: APPLICATION,
    });

    const headers = {
      host: "app.kitties.test:9443",
      authorization: `Bearer ${token.access_token}`,
      "x-kitties-library-epoch": "1",
      "content-type": "application/x-ndjson",
    };

    const transport = Layer.effect(
      HttpClient.HttpClient,
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;

        return HttpClient.mapRequest(http, HttpClientRequest.setHeaders(headers));
      }),
    ).pipe(
      Layer.provide(
        NodeHttpClient.layerNodeHttpOptions({
          ca: readFileSync(tls.caPath),
          servername: "app.kitties.test",
        }),
      ),
    );

    /**
     * @template A,E
     * @param {(client: Effect.Success<typeof LibraryApi.client>) => Effect.Effect<A,E>} useClient
     */
    const official = (useClient) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* LibraryApi.clientHttp(
            `https://127.0.0.1:${live.https.address().port}/v1/library/rpc`,
          );

          return yield* useClient(api);
        }).pipe(Effect.scoped, Effect.timeout("5 seconds"), Effect.provide(transport)),
      );

    const control = async (input) =>
      request(
        httpRequest,
        {
          hostname: "127.0.0.1",
          port: live.control.address().port,
          path: "/control",
          method: "POST",
          headers: { "content-type": "application/json" },
        },
        JSON.stringify(input),
      );

    const raw = (bytes) =>
      request(
        httpsRequest,
        {
          hostname: "127.0.0.1",
          port: live.https.address().port,
          servername: "app.kitties.test",
          ca: readFileSync(tls.caPath),
          path: "/v1/library/rpc",
          method: "POST",
          headers,
        },
        bytes,
      );

    await use({ live, official, control, raw, requests });
  } finally {
    await live.close();
    await new Promise((done) => {
      native.close(done);
      native.closeAllConnections();
    });
  }
};

test("the actual official client reports Unknown only after the selected real success, then retries the same intent with a new numeric ID and original receipt", async () => {
  const parser = RpcSerialization.makeNdjson().makeUnsafe();
  await withCommandProxy(
    async (frames, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      const wire = parser.encode({ ...successLiteral, requestId: frames[0].id });
      response.write(wire.slice(0, 19));
      response.end(wire.slice(19));
    },
    async ({ live, official, control, requests }) => {
      expect(
        (await control({ action: "dropNextCommandReply", tag: "ProposeSkill", armMs: 15000 }))
          .status,
      ).toBe(200);
      expect(
        (await control({ action: "dropNextCommandReply", tag: "ProposeSkill", armMs: 15000 }))
          .status,
      ).toBe(400);
      const commands = DomainFoldkit.make(LibraryApi);

      const send = () =>
        official((api) =>
          commands
            .ProposeSkill({
              target: "owner",
              commandId: "library:1:gate:0",
              input: { name: "Keep", body: "Private original body" },
            })
            .effect.pipe(Effect.provideService(LibraryApi.Client, api)),
        );

      const unknown = await send();
      expect(unknown._tag).toBe("FailedProposeSkill");
      expect(unknown.commandId).toBe("library:1:gate:0");
      expect(unknown.failure._tag).toBe("Unknown");
      const retry = await send();
      expect(retry).toMatchObject({
        commandId: "library:1:gate:0",
        receipt: { stream: "Library/owner", version: 2 },
        reply: { skillId: "kitties-skill-0000000000000001", proposalRevision: 2 },
      });
      expect(Schema.is(Schema.Number)(requests[0][0].id)).toBe(true);
      expect(requests[1][0].id).not.toBe(requests[0][0].id);
      const events = live.state.evidence().events;
      const receipts = events.filter((event) => event.event === "domain-receipt");
      expect(receipts).toHaveLength(2);
      expect(receipts[0].inputSha256).toBe(receipts[1].inputSha256);
      expect(
        receipts.map((event) => [event.commandId, event.stream, event.version, event.reply]),
      ).toEqual(
        Array.from({ length: 2 }, () => [
          "library:1:gate:0",
          "Library/owner",
          2,
          { skillId: "kitties-skill-0000000000000001", proposalRevision: 2 },
        ]),
      );
      const receiptIndex = events.findIndex((event) => event.event === "domain-receipt");
      const dropIndex = events.findIndex((event) => event.event === "reply-dropped");
      expect(receiptIndex).toBeGreaterThan(-1);
      expect(dropIndex).toBeGreaterThan(receiptIndex);
      expect(events.filter((event) => event.event === "reply-dropped")).toHaveLength(1);
      expect(JSON.stringify(events).includes("Private original body")).toBe(false);
    },
  );
});

test.each([
  [
    "typed Denied",
    '{"_tag":"Exit","requestId":1,"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"LibraryUnauthorized"}}]}}\n',
  ],
  [
    "mismatched request ID",
    '{"_tag":"Exit","requestId":99,"exit":{"_tag":"Success","value":{"stream":"Library/owner","version":2,"reply":{"skillId":"kitties-skill-0000000000000001","proposalRevision":2}}}}\n',
  ],
  [
    "wrong source",
    '{"_tag":"Exit","requestId":1,"exit":{"_tag":"Success","value":{"stream":"Library/other","version":2,"reply":{"skillId":"kitties-skill-0000000000000001","proposalRevision":2}}}}\n',
  ],
  ["oversize response", "x".repeat(32769) + "\n"],
])("armed loss passes %s bytes through without claiming a committed drop", async (label, bytes) => {
  await withCommandProxy(
    async (_, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(bytes);
    },
    async ({ live, control, raw }) => {
      expect(
        (await control({ action: "dropNextCommandReply", tag: "ProposeSkill", armMs: 15000 }))
          .status,
      ).toBe(200);
      const response = await raw(RpcSerialization.makeNdjson().makeUnsafe().encode(requestLiteral));
      expect(response.text === bytes).toBe(true);
      const evidence = live.state.evidence();
      expect(evidence.counters["reply-dropped"] ?? 0).toBe(0);

      expect(
        evidence.events
          .values()
          .filter((event) => event.event === "domain-denied")
          .map((event) => [event.requestId, event.commandId, event.error])
          .toArray(),
      ).toEqual(label === "typed Denied" ? [[1, "library:1:gate:0", "LibraryUnauthorized"]] : []);
    },
  );
});
