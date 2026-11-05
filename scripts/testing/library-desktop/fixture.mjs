// Explicit local OAuth issuer and HTTPS transport fixture. No production module imports it.
// This is not Cloudflare Access: the real Domain/HTTP host below is the persistence owner.
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as httpServer, request as httpRequest } from "node:http";
import { createServer as httpsServer } from "node:https";
import { dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const APPLICATION = "https://app.kitties.test:9443";
export const ISSUER = "https://issuer.kitties.test:9443";
const CONTROL = "http://127.0.0.1:9444";
const MAX_BODY = 32768;
const MAX_SLOTS = 128;
const MAX_REQUESTS = 32;
const LIFETIME = 180000;
const secret = () => randomBytes(32).toString("base64url");
const digest = (value) => createHash("sha256").update(value).digest("base64url");

const safeHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; form-action 'self' http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'",
};

const string = Schema.String.check(Schema.isMaxLength(4096));
const opaque = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/));
const CommandTag = Schema.Literals(["ProposeSkill", "AcceptSkill", "RemoveSkill"]);

const RequestId = Schema.Union([
  Schema.String.check(Schema.isMaxLength(128)),
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
]);

const Version = Schema.Int.check(Schema.isGreaterThan(0));

const Registration = Schema.Struct({
  client_name: Schema.Literal("Kitties Desktop"),
  redirect_uris: Schema.Tuple([string]),
  token_endpoint_auth_method: Schema.Literal("none"),
  grant_types: Schema.Tuple([Schema.Literal("authorization_code")]),
  response_types: Schema.Tuple([Schema.Literal("code")]),
});

const Authorization = Schema.Struct({
  response_type: Schema.Literal("code"),
  client_id: opaque,
  redirect_uri: string,
  code_challenge_method: Schema.Literal("S256"),
  code_challenge: opaque,
  state: opaque,
  resource: Schema.Literal(APPLICATION),
});

const Decision = Schema.Struct({
  transaction: opaque,
  decision: Schema.Literals(["allow", "deny"]),
});

const Exchange = Schema.Struct({
  grant_type: Schema.Literal("authorization_code"),
  client_id: opaque,
  redirect_uri: string,
  code: opaque,
  code_verifier: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._~-]{43,128}$/)),
  resource: Schema.Literal(APPLICATION),
});

const Metric = Schema.Literals([
  "started",
  "closed",
  "reads",
  "sends",
  "scopes",
  "scopesClosed",
  "requests",
  "requestsClosed",
  "physicalAborts",
]);

const ControlInput = Schema.Union([
  Schema.Struct({ action: Schema.Literals(["status", "stats", "freeze", "revokeAll", "inspect"]) }),
  Schema.Struct({
    action: Schema.Literal("nextTokenLifetime"),
    ttlSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
  }),
  Schema.Struct({
    action: Schema.Literal("wait"),
    metric: Metric,
    target: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 })),
    waitMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10000 })),
  }),
  Schema.Struct({
    action: Schema.Literal("rpc"),
    tag: Schema.Literals([
      "ProposeSkill",
      "AcceptSkill",
      "RemoveSkill",
      "Library.get",
      "SkillDetail.get",
    ]),
    payload: Schema.Json,
  }),
  Schema.Struct({
    action: Schema.Literal("dropNextCommandReply"),
    tag: CommandTag,
    armMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30000 })),
  }),
]);

const NativeSession = Schema.Struct({ key: Schema.String, expiresAt: Schema.Int });

const RequestFrame = Schema.TaggedStruct("Request", {
  id: Schema.String,
  tag: Schema.String,
  payload: Schema.Json,
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
});

const CommandObservation = Schema.Struct({
  _tag: Schema.Literal("Request"),
  id: RequestId,
  tag: CommandTag,
  payload: Schema.Struct({
    target: Schema.Literal("owner"),
    commandId: Schema.String.check(Schema.isPattern(/^library:1:[A-Za-z0-9_.:-]{1,128}$/)),
    input: Schema.Json,
  }),
});

const ProposalReceipt = Schema.Struct({
  stream: Schema.Literal("Library/owner"),
  version: Version,
  reply: Schema.Struct({
    skillId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)),
    proposalRevision: Version,
  }),
});

const VoidReceipt = Schema.Struct({
  stream: Schema.Literal("Library/owner"),
  version: Version,
  reply: Schema.Null,
});

const SuccessObservation = Schema.TaggedStruct("Exit", {
  requestId: RequestId,
  exit: Schema.TaggedStruct("Success", { value: Schema.Json }),
});

const DeniedObservation = Schema.TaggedStruct("Exit", {
  requestId: RequestId,
  exit: Schema.TaggedStruct("Failure", {
    cause: Schema.Tuple([
      Schema.TaggedStruct("Fail", { error: Schema.TaggedStruct("LibraryUnauthorized", {}) }),
    ]),
  }),
});

const FrameDiagnostic = Schema.Struct({
  _tag: Schema.optional(Schema.String),
  id: Schema.optional(Schema.Unknown),
  requestId: Schema.optional(Schema.Unknown),
  tag: Schema.optional(Schema.String),
});

// A bounded observation tap; original chunks still pipe unchanged. Oversize
// lines are skipped rather than retaining catalogue bodies or unbounded streams.
const lines = (consume) => {
  let pending = Buffer.alloc(0);
  let oversize = false;

  return (chunk) => {
    let offset = 0;

    for (;;) {
      const end = chunk.indexOf(10, offset);
      const segment = chunk.subarray(offset, end === -1 ? chunk.length : end);

      if (!oversize && pending.length + segment.length <= MAX_BODY)
        pending = Buffer.concat([pending, segment]);
      else oversize = true;

      if (end === -1) return;

      if (!oversize) {
        let parsed;

        try {
          parsed = JSON.parse(pending.toString("utf8"));
        } catch {
          parsed = null;
        }

        consume(parsed);
      }

      pending = Buffer.alloc(0);
      oversize = false;
      offset = end + 1;
    }
  };
};

// The installed HTTP protocol uses newline-framed objects and numeric request
// IDs by default. Preserve the ID type: numeric1 and string"1" are distinct.
export const commandObserver = (record, diagnose = () => {}, received = () => {}) => {
  const commands = new Map();
  let requestFrames = 0;
  let responseFrames = 0;
  let proof;

  return {
    commands,
    requestFrames: () => requestFrames,
    responseFrames: () => responseFrames,
    proof: () => proof,
    request: lines((frame) => {
      requestFrames++;
      diagnose("request", frame);
      const decoded = Schema.decodeUnknownOption(CommandObservation)(frame);

      if (Option.isSome(decoded) && commands.size < 32) {
        const value = decoded.value;

        const command = {
          requestId: value.id,
          tag: value.tag,
          commandId: value.payload.commandId,
          inputSha256: digest(JSON.stringify(value.payload.input)),
        };

        commands.set(value.id, command);
        record("domain-command", command);
        received(command);
      }
    }),
    reply: lines((frame) => {
      responseFrames++;
      diagnose("reply", frame);
      const success = Schema.decodeUnknownOption(SuccessObservation)(frame);

      if (Option.isSome(success)) {
        const command = commands.get(success.value.requestId);

        if (!command) return;

        const receipt = Schema.decodeUnknownOption(
          command.tag === "ProposeSkill" ? ProposalReceipt : VoidReceipt,
          { onExcessProperty: "error" },
        )(success.value.exit.value);

        if (Option.isSome(receipt)) {
          proof = { ...command, ...receipt.value };
          record("domain-receipt", proof);
        }

        return;
      }

      const denied = Schema.decodeUnknownOption(DeniedObservation)(frame);

      if (Option.isSome(denied)) {
        const command = commands.get(denied.value.requestId);

        if (command) record("domain-denied", { ...command, error: "LibraryUnauthorized" });
      }
    }),
  };
};

export const replyLoss = (record, now = Date.now) => {
  let current = { phase: "idle" };
  let uses = 0;

  const status = () => {
    if (current.phase === "armed" && current.expiresAt <= now()) {
      current = { ...current, phase: "expired" };
      record("reply-loss-expired", { tag: current.tag });
    }

    return { ...current };
  };

  return {
    status,
    arm(tag, armMs) {
      status();

      if (["armed", "claimed"].includes(current.phase) || uses >= 128) return refuse();
      decode(CommandTag, tag);
      decode(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30000 })), armMs);
      uses++;
      current = { phase: "armed", tag, expiresAt: now() + armMs };
      record("reply-loss-armed", { tag, expiresAt: current.expiresAt });

      return { armed: true, tag, expiresAt: current.expiresAt, maxReplyBytes: MAX_BODY };
    },
    claim(command) {
      status();

      if (current.phase !== "armed" || current.tag !== command.tag) return false;
      current = { ...current, ...command, phase: "claimed" };
      record("reply-loss-claimed", command);

      return true;
    },
    finish(command, phase, reason) {
      if (
        current.phase !== "claimed" ||
        current.requestId !== command.requestId ||
        current.commandId !== command.commandId
      )
        return;
      current = { ...current, phase };

      if (phase === "passthrough") record("reply-loss-passthrough", { ...command, reason });
    },
  };
};

class Refused extends Error {}

const refuse = () => {
  throw new Refused("invalid_request");
};

const decode = (schema, input) => {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input);
  } catch {
    return refuse();
  }
};

const parameters = (query) => {
  const result = {};

  for (const [key, value] of query) {
    if (Object.hasOwn(result, key)) return refuse();
    result[key] = value;
  }

  return result;
};

const redirect = (text) => {
  let url;

  try {
    url = new URL(text);
  } catch {
    return refuse();
  }

  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    Number(url.port) < 1024 ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/oauth\/callback\/[A-Za-z0-9_-]{43}$/.test(url.pathname) ||
    url.href !== text
  )
    return refuse();

  return text;
};

const json = (response, status, value) => {
  response.writeHead(status, { ...safeHeaders, "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

const body = async (request) => {
  const chunks = [];
  let length = 0;

  for await (const chunk of request) {
    length += chunk.length;

    if (length > MAX_BODY) return refuse();
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
};

const jsonBody = async (request) => {
  if (request.headers["content-type"] !== "application/json") return refuse();

  try {
    return JSON.parse(await body(request));
  } catch {
    return refuse();
  }
};

const formBody = async (request) => {
  if (request.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded")
    return refuse();

  return parameters(new URLSearchParams(await body(request)));
};

const deadline = async (promise, ms, label) => {
  let timer;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`Deadline: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

export function certificates(
  directory = join(root, ".context/library-desktop/local-fixture/certs"),
) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const caPath = join(directory, "ca.pem");
  const certPath = join(directory, "server.pem");
  const keyPath = join(directory, "server-key.pem");

  if ([caPath, certPath, keyPath].every(existsSync)) {
    const certificate = new X509Certificate(readFileSync(certPath));

    if (
      Date.parse(certificate.validTo) > Date.now() + 3600000 &&
      certificate.checkHost("app.kitties.test") &&
      certificate.checkHost("issuer.kitties.test")
    ) {
      return { caPath, certPath, keyPath };
    }
  }

  const caKey = join(directory, "ca-key.pem");
  const csr = join(directory, "server.csr");
  const extensions = join(directory, "extensions.txt");
  const openssl = (args) => execFileSync("openssl", args, { stdio: "pipe", timeout: 15000 });

  try {
    openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "2",
      "-subj",
      "/CN=Kitties local fixture CA",
      "-keyout",
      caKey,
      "-out",
      caPath,
    ]);
    openssl([
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-subj",
      "/CN=app.kitties.test",
      "-keyout",
      keyPath,
      "-out",
      csr,
    ]);
    writeFileSync(
      extensions,
      "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:app.kitties.test,DNS:issuer.kitties.test\n",
    );
    openssl([
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      caPath,
      "-CAkey",
      caKey,
      "-set_serial",
      "1",
      "-out",
      certPath,
      "-days",
      "2",
      "-sha256",
      "-extfile",
      extensions,
    ]);
    chmodSync(keyPath, 0o600);
  } finally {
    for (const path of [caKey, csr, extensions]) rmSync(path, { force: true });
  }

  return { caPath, certPath, keyPath };
}

// Backend is an explicit port. Tests below exercise issuer semantics with a
// controlled port; CLI composition exclusively uses the real native host.
export function issuerState(backend, now = Date.now) {
  const clients = new Map(),
    transactions = new Map(),
    codes = new Map(),
    tokens = new Map();

  const events = [];
  const counters = {};
  let nextLifetime = 60;
  let totalIssued = 0;

  const record = (event, fields = {}) => {
    counters[event] = (counters[event] ?? 0) + 1;
    events.push({ event, at: now(), ...fields });

    if (events.length > 512) events.shift();
  };

  const prune = (map) => {
    for (const [key, value] of map)
      if (value.expiresAt <= now()) {
        value.close?.();
        map.delete(key);
      }
  };

  const reserve = (map) => {
    prune(map);

    if (map.size >= MAX_SLOTS) return refuse();
  };

  const evidence = () => {
    for (const map of [clients, transactions, codes, tokens]) prune(map);

    return {
      counters: { ...counters },
      events: [...events],
      live: {
        clients: clients.size,
        transactions: transactions.size,
        codes: codes.size,
        tokens: tokens.size,
      },
      totalIssued,
    };
  };

  return {
    record,
    evidence,
    register(input) {
      const value = decode(Registration, input);
      redirect(value.redirect_uris[0]);
      reserve(clients);
      const id = secret();
      clients.set(id, { redirect: value.redirect_uris[0], expiresAt: now() + LIFETIME });
      record("registered");

      return {
        client_id: id,
        token_endpoint_auth_method: "none",
        redirect_uris: value.redirect_uris,
      };
    },
    authorize(query) {
      const value = decode(Authorization, parameters(query));
      prune(clients);
      const client = clients.get(value.client_id);

      if (!client || client.redirect !== value.redirect_uri) return refuse();
      reserve(transactions);
      clients.delete(value.client_id);
      const transaction = secret();
      transactions.set(transaction, { ...value, expiresAt: now() + LIFETIME });
      record("authorization-presented");

      return transaction;
    },
    decide(input) {
      const value = decode(Decision, input);
      prune(transactions);
      const transaction = transactions.get(value.transaction);

      if (!transaction) return refuse();
      transactions.delete(value.transaction);
      const destination = new URL(transaction.redirect_uri);
      destination.searchParams.set("state", transaction.state);
      destination.searchParams.set("iss", ISSUER);

      if (value.decision === "deny") destination.searchParams.set("error", "access_denied");
      else {
        reserve(codes);
        const code = secret();
        codes.set(code, { ...transaction, expiresAt: now() + 30000 });
        destination.searchParams.set("code", code);
      }

      record(value.decision === "allow" ? "authorization-allowed" : "authorization-denied");

      return destination.href;
    },
    async exchange(input) {
      const value = decode(Exchange, input);
      prune(codes);
      const code = codes.get(value.code);
      codes.delete(value.code); // Any validly-shaped exchange consumes the code, including a bad verifier.

      if (
        !code ||
        code.client_id !== value.client_id ||
        code.redirect_uri !== value.redirect_uri ||
        code.resource !== value.resource ||
        digest(value.code_verifier) !== code.code_challenge
      )
        return refuse();
      reserve(tokens);

      if (totalIssued >= 1024) return refuse();
      totalIssued++;
      const seconds = nextLifetime;
      nextLifetime = 60;
      const native = decode(NativeSession, await backend.issue(seconds * 1000));
      const token = secret();

      const session = {
        native,
        expiresAt: Math.min(native.expiresAt, now() + seconds * 1000),
        streams: new Set(),
        close() {
          for (const stream of this.streams) stream();
          this.streams.clear();
        },
      };

      tokens.set(token, session);
      record("token-issued", { expiresAt: session.expiresAt });

      return { access_token: token, token_type: "Bearer", expires_in: seconds };
    },
    authenticate(authorization) {
      prune(tokens);
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
      const session = match && tokens.get(match[1]);

      if (!session) return refuse();

      return session;
    },
    lifetime(seconds) {
      nextLifetime = decode(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
        seconds,
      );
    },
    revoke() {
      for (const token of tokens.values()) token.close();
      tokens.clear();
      record("tokens-revoked");
    },
  };
}

function nativeTransport(upstream) {
  const request = (path, data, headers = {}) =>
    new Promise((resolveResponse, reject) => {
      const bytes = data === undefined ? undefined : Buffer.from(data);
      const requestHeaders = { ...headers };

      if (bytes) requestHeaders["content-length"] = bytes.length;

      const req = httpRequest(
        new URL(path, upstream),
        {
          method: bytes ? "POST" : "GET",
          headers: requestHeaders,
        },
        (response) => {
          const chunks = [];
          let size = 0;
          response.on("data", (chunk) => {
            size += chunk.length;

            if (size > 1048576) response.destroy(Error("Backend response limit"));
            else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () =>
            resolveResponse({
              status: response.statusCode,
              text: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );

      req.setTimeout(12000, () => req.destroy(Error("Backend deadline")));
      req.on("error", reject);
      req.end(bytes);
    });

  const fixture = async (action, fields = {}) => {
    const reply = await request("/fixture", JSON.stringify({ action, ...fields }), {
      "content-type": "application/json",
    });

    const value = decode(
      Schema.Struct({
        ok: Schema.Boolean,
        value: Schema.optional(Schema.Json),
        error: Schema.optional(Schema.String),
      }),
      JSON.parse(reply.text),
    );

    if (reply.status !== 200 || !value.ok) throw Error("Native fixture refused control");

    return value.value;
  };

  return {
    issue: (ttlMs) => fixture("issue", { ttlMs }),
    fixture,
    rpc: async (tag, payload, session) => {
      const reply = await request(
        "/v1/library/rpc",
        JSON.stringify(RequestFrame.make({ id: "control", tag, payload, headers: [] })) + "\n",
        {
          "content-type": "application/x-ndjson",
          "x-local-session": session.key,
          authorization: "Bearer fixture-control-only",
          "x-kitties-library-epoch": "1",
        },
      );

      if (reply.status !== 200) throw Error("Native RPC refused");

      return reply.text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => decode(Schema.Json, JSON.parse(line)));
    },
  };
}

export async function servers({
  backend,
  upstream,
  tls,
  httpsPort = 9443,
  controlPort = 9444,
  emit = () => {},
}) {
  const state = issuerState(backend);
  let active = 0;
  let controlSessions = 0;
  const streams = new Set();
  const loss = replyLoss(state.record);
  let diagnosticsCount = 0;

  const diagnose = (direction, frame) => {
    if (diagnosticsCount >= 32) return;
    diagnosticsCount++;
    const decoded = Schema.decodeUnknownOption(FrameDiagnostic)(frame);

    if (Option.isNone(decoded)) {
      state.record("rpc-shape", { direction, kind: "other", idKind: "other", tag: "other" });

      return;
    }

    const value = decoded.value;
    const id = direction === "request" ? value.id : value.requestId;
    state.record("rpc-shape", {
      direction,
      kind: ["Request", "Exit", "Chunk"].includes(value._tag) ? value._tag : "other",
      idKind: Schema.is(Schema.Number)(id)
        ? "number"
        : Schema.is(Schema.String)(id)
          ? "string"
          : "other",
      tag: [
        "ProposeSkill",
        "AcceptSkill",
        "RemoveSkill",
        "Library.get",
        "Library.watch",
        "SkillDetail.get",
        "SkillDetail.watch",
      ].includes(value.tag)
        ? value.tag
        : "other",
    });
  };

  const handle = (handler) => async (request, response) => {
    if (active >= MAX_REQUESTS) return json(response, 503, { error: "capacity" });
    active++;
    response.once("close", () => active--);
    const parsed = new URL(request.url, APPLICATION);

    const path = [
      "/authorize",
      "/decision",
      "/register",
      "/token",
      "/control",
      "/evidence",
      "/.well-known/oauth-authorization-server",
      "/v1/library/session",
      "/v1/library/rpc",
      "/v1/library/rpc/",
    ].includes(parsed.pathname)
      ? parsed.pathname
      : "other";

    response.once("close", () => {
      const entry = { event: "request", method: request.method, path, status: response.statusCode };
      state.record(entry.event, { method: entry.method, path, status: entry.status });
      emit(entry);
    });

    try {
      await handler(request, response, parsed);
    } catch (error) {
      state.record(error instanceof Refused ? "refused" : "dependency-failure");

      if (!response.headersSent)
        json(response, error instanceof Refused ? 400 : 502, {
          error: error instanceof Refused ? "invalid_request" : "unavailable",
        });
      else response.destroy();
    }
  };

  const metadata = {
    issuer: ISSUER,
    authorization_endpoint: ISSUER + "/authorize",
    token_endpoint: ISSUER + "/token",
    registration_endpoint: ISSUER + "/register",
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
  };

  const https = httpsServer(
    { key: readFileSync(tls.keyPath), cert: readFileSync(tls.certPath), minVersion: "TLSv1.2" },
    handle(async (request, response, url) => {
      const host = request.headers.host;

      const applicationHost = new URL(APPLICATION).host,
        issuerHost = new URL(ISSUER).host;

      if (
        ![applicationHost, issuerHost].includes(host) ||
        request.url.length > 8192 ||
        request.url.startsWith("//") ||
        !request.url.startsWith("/")
      )
        return refuse();

      if (
        url.pathname === "/.well-known/oauth-authorization-server" &&
        request.method === "GET" &&
        !url.search
      )
        return json(response, 200, metadata);

      if (host === issuerHost) {
        if (url.pathname === "/register" && request.method === "POST" && !url.search)
          return json(response, 201, state.register(await jsonBody(request)));

        if (url.pathname === "/authorize" && request.method === "GET") {
          const transaction = state.authorize(url.searchParams);
          const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Kitties local authorization</title><h1>Authorize Kitties Desktop</h1><p>Local test issuer. Allow this desktop to use the local Library?</p><form method="post" action="/decision"><input type="hidden" name="transaction" value="${transaction}"><button type="submit" name="decision" value="allow">Authorize Kitties Desktop</button><button type="submit" name="decision" value="deny">Deny sign-in</button></form></html>`;
          // Navigation POST Origin serialization follows the document's referrer
          // policy. Keep its issuer origin while never disclosing the query.
          response.writeHead(200, {
            ...safeHeaders,
            "referrer-policy": "origin",
            "content-type": "text/html; charset=utf-8",
          });

          return response.end(html);
        }

        if (url.pathname === "/decision" && request.method === "POST" && !url.search) {
          const origin =
            request.headers.origin === ISSUER
              ? "issuer"
              : request.headers.origin === "null"
                ? "opaque"
                : request.headers.origin === undefined
                  ? "absent"
                  : "other";

          const contentType =
            request.headers["content-type"]?.split(";")[0] === "application/x-www-form-urlencoded"
              ? "form"
              : "other";

          let input;

          try {
            input = await formBody(request);
          } catch {
            state.record("decision-rejected", { stage: "form", origin, contentType });

            return refuse();
          }

          const fieldNames = Object.keys(input)
            .slice(0, 8)
            .map((field) => (["transaction", "decision"].includes(field) ? field : "other"));

          state.record("decision-request", { origin, contentType, fieldNames });

          if (request.headers.origin !== ISSUER) {
            state.record("decision-rejected", { stage: "origin" });

            return refuse();
          }

          let destination;

          try {
            destination = state.decide(input);
          } catch {
            state.record("decision-rejected", { stage: "transaction" });

            return refuse();
          }

          response.writeHead(303, { ...safeHeaders, location: destination });

          return response.end();
        }

        if (url.pathname === "/token" && request.method === "POST" && !url.search)
          return json(response, 200, await state.exchange(await formBody(request)));

        return json(response, 404, { error: "not_found" });
      }

      if (
        !new Set(["/v1/library/session", "/v1/library/rpc", "/v1/library/rpc/"]).has(
          url.pathname,
        ) ||
        url.search ||
        request.headers.cookie ||
        request.headers["x-local-session"] ||
        Object.keys(request.headers).some((name) => name.startsWith("sec-fetch-")) ||
        (request.headers.origin &&
          !["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"].includes(
            request.headers.origin,
          ))
      )
        return refuse();

      if (request.method !== (url.pathname === "/v1/library/session" ? "GET" : "POST"))
        return refuse();
      let session;

      try {
        session = state.authenticate(request.headers.authorization);
      } catch {
        state.record("token-refused");

        return json(response, 401, { error: "unauthorized" });
      }

      const headers = {
        authorization: "Bearer validated-local-oauth",
        "x-local-session": session.native.key,
      };

      if (request.headers["x-kitties-library-epoch"])
        headers["x-kitties-library-epoch"] = request.headers["x-kitties-library-epoch"];

      if (request.headers["content-type"])
        headers["content-type"] = request.headers["content-type"];

      if (request.headers["content-length"])
        headers["content-length"] = request.headers["content-length"];

      // Preserve bytes, NDJSON framing, backpressure and native streaming lifetime.
      // Never buffer/rewrite official RPC frames or synthesize a confirmed result.
      const proxy = httpRequest(new URL(url.pathname, upstream), {
        method: request.method,
        headers,
      });

      let reply;
      let gate;
      let holdTimer;
      let requestBytes = 0;
      let selected;

      const observed = commandObserver(state.record, diagnose, (command) => {
        if (loss.claim(command)) selected = command;
      });

      const close = () => {
        proxy.destroy();
        reply?.destroy();
        response.destroy();
      };

      streams.add(close);
      session.streams.add(close);
      const timer = setTimeout(close, Math.max(1, Math.min(session.expiresAt - Date.now(), 60000)));
      proxy.setTimeout(10000, () => {
        if (!reply) proxy.destroy(Error("Upstream headers deadline"));
      });
      proxy.once("response", (incoming) => {
        reply = incoming;
        response.writeHead(incoming.statusCode, {
          ...safeHeaders,
          "content-type": incoming.headers["content-type"] ?? "application/octet-stream",
        });

        let holding =
          selected !== undefined && observed.requestFrames() === 1 && observed.commands.size === 1;

        let held = [];
        let heldBytes = 0;

        const passthrough = (reason) => {
          if (!holding) return;
          holding = false;
          loss.finish(selected, "passthrough", reason);

          for (const chunk of held) gate.push(chunk);
          held = [];
        };

        if (selected && !holding) loss.finish(selected, "passthrough", "multiple-frames");
        gate = new Transform({
          transform(chunk, _, callback) {
            observed.reply(chunk);

            if (holding) {
              if (heldBytes + chunk.length > MAX_BODY) {
                passthrough("size");
                this.push(chunk);
              } else {
                heldBytes += chunk.length;
                held.push(chunk);
              }
            } else this.push(chunk);
            callback();
          },
          flush(callback) {
            clearTimeout(holdTimer);
            const proof = observed.proof();
            let complete = false;

            if (holding) {
              try {
                complete = Schema.is(SuccessObservation)(
                  JSON.parse(Buffer.concat(held).toString("utf8")),
                );
              } catch {
                complete = false;
              }
            }

            if (
              holding &&
              incoming.statusCode === 200 &&
              observed.responseFrames() === 1 &&
              complete &&
              proof &&
              proof.requestId === selected.requestId &&
              proof.commandId === selected.commandId
            ) {
              holding = false;
              held = [];
              loss.finish(selected, "dropped");
              state.record("reply-dropped", proof);
              response.destroy();
            } else passthrough("no-matching-success");
            callback();
          },
        });

        if (holding) {
          state.record("reply-loss-withheld", selected);
          holdTimer = setTimeout(() => passthrough("deadline"), 10000);
        }

        gate.once("error", () => response.destroy());
        incoming.pipe(gate).pipe(response);
        incoming.once("error", () => response.destroy());
      });
      proxy.once("error", () => {
        if (!response.headersSent) json(response, 502, { error: "unavailable" });
        else response.destroy();
      });
      response.once("close", () => {
        clearTimeout(timer);
        clearTimeout(holdTimer);

        if (selected) loss.finish(selected, "passthrough", "closed");
        gate?.destroy();
        streams.delete(close);
        session.streams.delete(close);
        proxy.destroy();
        reply?.destroy();
      });
      request.on("data", (chunk) => {
        requestBytes += chunk.length;
        observed.request(chunk);

        if (requestBytes > 1048576) close();
      });
      request.once("aborted", close);
      request.pipe(proxy);
    }),
  );

  const control = httpServer(
    handle(async (request, response, url) => {
      if (
        request.headers.host !== `127.0.0.1:${control.address().port}` ||
        request.headers.origin ||
        Object.keys(request.headers).some((name) => name.startsWith("sec-fetch-")) ||
        url.search ||
        request.url.startsWith("//")
      )
        return refuse();

      if (request.method === "GET" && url.pathname === "/evidence")
        return json(response, 200, state.evidence());

      if (request.method !== "POST" || url.pathname !== "/control")
        return json(response, 404, { error: "not_found" });
      const input = decode(ControlInput, await jsonBody(request));
      let value;

      switch (input.action) {
        case "status":
          value = {
            application: APPLICATION,
            issuer: ISSUER,
            libraryId: "owner",
            epoch: 1,
            active,
            replyLoss: loss.status(),
            evidence: state.evidence(),
          };
          break;
        case "nextTokenLifetime":
          state.lifetime(input.ttlSeconds);
          value = { ttlSeconds: input.ttlSeconds };
          break;
        case "dropNextCommandReply":
          value = loss.arm(input.tag, input.armMs);
          break;
        case "revokeAll":
          state.revoke();
          value = { revoked: true };
          break;
        case "stats":
        case "freeze":
          value = await backend.fixture(input.action);
          break;
        case "wait":
          value = await backend.fixture("wait", {
            metric: input.metric,
            target: input.target,
            waitMs: input.waitMs,
          });
          break;
        case "rpc":
        case "inspect": {
          if (controlSessions >= 1024) return refuse();
          controlSessions++;
          const session = decode(NativeSession, await backend.issue(15000));
          value =
            input.action === "inspect"
              ? await backend.rpc("Library.get", { key: "owner" }, session)
              : await backend.rpc(input.tag, input.payload, session);
          break;
        }

        default:
          return refuse();
      }

      return json(response, 200, { ok: true, value });
    }),
  );

  for (const server of [https, control]) {
    server.headersTimeout = 5000;
    server.requestTimeout = 10000;
    server.maxHeadersCount = 40;
    server.maxConnections = 64;
    server.on("clientError", (_, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });
  }

  const close = async () => {
    state.revoke();

    for (const stream of streams) stream();
    await Promise.all(
      [https, control].map(
        (server) =>
          new Promise((done) => {
            server.close(done);
            server.closeAllConnections();
          }),
      ),
    );
  };

  try {
    https.listen(httpsPort, "127.0.0.1");
    await once(https, "listening");
    control.listen(controlPort, "127.0.0.1");
    await once(control, "listening");
  } catch (error) {
    await close();
    throw error;
  }

  return { https, control, state, close };
}

async function launchBackend(stateDir, signal) {
  mkdirSync(stateDir, { recursive: true });

  const child = spawn(
    process.execPath,
    [join(root, "scripts/testing/library-http/host.mjs"), stateDir],
    {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: dirname(process.execPath) + ":/usr/bin:/bin",
        LANG: "C.UTF-8",
        CI: "1",
        NO_COLOR: "1",
        TMPDIR: stateDir,
      },
    },
  );

  const closed = once(child, "close");
  const ready = Promise.withResolvers();
  const aborted = () => ready.reject(Error("Startup interrupted"));

  signal.addEventListener("abort", aborted, { once: true });

  if (signal.aborted) aborted();

  let buffer = "",
    direct,
    engineVerified = false,
    stderrBytes = 0;

  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
  }); // No credential-bearing backend diagnostics are copied.
  child.stdout.on("data", (chunk) => {
    buffer += chunk;

    if (buffer.length > 262144) {
      ready.reject(Error("Backend event limit"));

      return;
    }

    let end;

    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let event;

      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      if (event.event === "direct-ready") direct = new URL(event.url);

      if (event.event === "engine-files-unchanged") engineVerified = event.unchanged === true;

      if (event.event === "ready" && direct)
        ready.resolve({ upstream: direct, hash: event.hash, version: event.version });
    }
  });
  child.on("error", ready.reject);
  closed.then(
    () => ready.reject(Error("Backend exited before readiness")),
    (error) => ready.reject(error),
  );

  const killGroup = (signal) => {
    const pid = decode(Schema.Int.check(Schema.isGreaterThan(0)), child.pid);
    process.kill(-pid, signal);
  };

  const stop = async () => {
    try {
      if (child.exitCode === null && !child.signalCode) child.kill("SIGTERM");
      const [code, signal] = await deadline(closed, 10000, "backend scoped shutdown");

      if (code !== 0 || signal !== null || !engineVerified)
        throw Error("Backend finalizer proof failed");

      try {
        killGroup(0);
        throw Error("Backend process group remains");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }

      return { engineVerified, stderrBytes, processGroupClean: true };
    } catch (error) {
      try {
        killGroup("SIGKILL");
      } catch (killError) {
        if (killError.code !== "ESRCH") throw new AggregateError([error, killError]);
      }

      await deadline(closed, 5000, "backend forced shutdown");
      throw error;
    } finally {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }
  };

  try {
    return { ...(await deadline(ready.promise, 60000, "native Domain host")), stop, closed };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    signal.removeEventListener("abort", aborted);
  }
}

async function main() {
  const output = join(root, ".context/library-desktop/local-fixture");
  const tls = certificates();
  const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");

  if (process.argv[2] === "--certificates") {
    emit({ event: "certificates", ...tls });

    return;
  }

  if (process.argv.length > 2) throw Error("Usage: fixture.mjs [--certificates]");
  const run = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const stopped = Promise.withResolvers();
  const controller = new AbortController();

  const stop = () => {
    controller.abort();
    stopped.resolve();
  };

  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  let host;
  let server;

  try {
    host = await launchBackend(
      join(root, ".context/library-http-check", `desktop-${run}`),
      controller.signal,
    );

    if (controller.signal.aborted) return;
    const backend = nativeTransport(host.upstream);
    await backend.fixture("initialize");

    if (controller.signal.aborted) return;
    server = await servers({ backend, upstream: host.upstream, tls, emit });
    emit({
      event: "ready",
      application: APPLICATION,
      issuer: ISSUER,
      control: CONTROL,
      caPath: tls.caPath,
      bundleHash: host.hash,
      version: host.version,
      pid: process.pid,
    });
    await Promise.race([
      stopped.promise,
      host.closed.then(() => {
        throw Error("Native host exited unexpectedly");
      }),
    ]);
  } finally {
    const evidence = server?.state.evidence();

    try {
      await server?.close();
    } finally {
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);

      if (host) {
        const cleanup = await host.stop();
        mkdirSync(join(output, "runs", run), { recursive: true });
        writeFileSync(
          join(output, "runs", run, "evidence.json"),
          JSON.stringify({ bundleHash: host.hash, evidence, cleanup }, null, 2),
        );
        emit({ event: "stopped", ...cleanup });
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    process.stderr.write("Local HTTPS fixture failed (details redacted)\n");
    process.exitCode = 1;
  });
}
