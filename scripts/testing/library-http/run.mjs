// Owned native integration controller. No assertions poll or retry; waits target persisted milestones.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { LibraryApi } from "../../../packages/domain/src/LibraryApi.api.ts";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../../..");
const decodeJson = (schema, text) => Schema.decodeUnknownSync(Schema.fromJsonString(schema))(text);

const Event = Schema.Struct({
  event: Schema.String,
  id: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  pid: Schema.optional(Schema.Number),
  hash: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  storeVersion: Schema.optional(Schema.Number),
  engineFiles: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  mutant: Schema.optional(Schema.NullOr(Schema.String)),
  unchanged: Schema.optional(Schema.Boolean),
});

const mode = process.argv[2] ?? "full";

if (!["full", "signal"].includes(mode)) throw Error("Usage: run.mjs [full|signal]");

const stateDir = join(
  root,
  ".context/library-http-check",
  `${mode}-${Date.now()}-${randomUUID().slice(0, 8)}`,
);

mkdirSync(stateDir, { recursive: true });

const results = [];
const failedCases = [];
let failure = null;
const events = [];
let host;

const deadline = (promise, ms, label) => {
  let timer;

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`Deadline ${ms}ms: ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

function launch() {
  // Deliberate allowlist: no Cloudflare/API/production credentials enter host or workerd env.
  const env = {
    PATH: dirname(process.execPath) + ":/usr/bin:/bin",
    LANG: "C.UTF-8",
    CI: "1",
    NO_COLOR: "1",
    TMPDIR: stateDir,
  };

  const child = spawn(process.execPath, [join(directory, "host.mjs"), stateDir, mode], {
    cwd: root,
    env,
    // Linux gives this host its own session/process group. The pinned runtime's
    // workerd spawn inherits it, so forced cleanup cannot signal another run.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const lines = [],
    pending = new Set();

  let buffer = "",
    stderr = "";

  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    buffer += chunk;
    let end;

    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Event))(line);

      if (Option.isNone(parsed)) continue;
      const value = parsed.value;
      lines.push(value);
      events.push(value);

      for (const waiter of pending)
        if (value.event === waiter.event) {
          pending.delete(waiter);
          waiter.resolve(value);
        }
    }
  });
  const closed = once(child, "close");
  child.on("close", (code, signal) => {
    writeFileSync(join(stateDir, `host-${child.pid}.stderr.log`), stderr);

    for (const waiter of pending)
      waiter.reject(
        Error(`Host exit ${code}/${signal} before ${waiter.event}: ${stderr.slice(-1800)}`),
      );
    pending.clear();
  });

  return {
    child,
    lines,
    closed,
    event: (event, ms = 30000, fresh = false) =>
      deadline(
        new Promise((resolve, reject) => {
          const existing = !fresh && lines.find((line) => line.event === event);

          if (existing) resolve(existing);
          else pending.add({ event, resolve, reject });
        }),
        ms,
        event,
      ),
  };
}

const cancelController = () => {
  failure ??= { error: "Controller interrupted" };
  process.exitCode = 1;

  for (const client of clients) client.abort();

  if (host?.child.exitCode === null && !host.child.signalCode) host.child.kill("SIGTERM");
};

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, cancelController);

async function stop() {
  if (!host) return;

  try {
    if (host.child.exitCode === null && !host.child.signalCode) host.child.kill("SIGTERM");
    const [code, signal] = await deadline(host.closed, 10000, "host scoped shutdown");
    assert.equal(code, 0, "host must finish all scoped finalizers successfully");
    assert.equal(signal, null, "host must exit normally");
    assert.deepEqual(
      host.lines
        .filter((line) => line.event === "engine-files-unchanged")
        .map((line) => line.unchanged),
      [true],
      "host must report installed engine byte identity after finalizers",
    );

    try {
      process.kill(-host.child.pid, 0);
      throw Error("Owned process group still exists after scoped host shutdown");
    } catch (error) {
      if (!Schema.is(Schema.Struct({ code: Schema.Literal("ESRCH") }))(error)) throw error;
      events.push({ event: "process-group-clean", pid: host.child.pid });
    }
  } catch (error) {
    try {
      try {
        process.kill(-host.child.pid, "SIGKILL");
      } catch (killError) {
        if (!Schema.is(Schema.Struct({ code: Schema.Literal("ESRCH") }))(killError))
          throw new AggregateError([error, killError], "Owned host group cleanup failed");
      }

      await deadline(host.closed, 5000, "forced host group cleanup");
    } finally {
      // A broken pipe must not keep the controller alive after a reported failure.
      host.child.stdout.destroy();
      host.child.stderr.destroy();
      host.child.unref();
    }

    throw error;
  }
}

let base;
const clients = new Set();
const nativeClients = new Set();
const json = (text) => decodeJson(Schema.Json, text);
const Session = Schema.Struct({ key: Schema.String, expiresAt: Schema.Number });

const Stats = Schema.Struct({
  started: Schema.Number,
  closed: Schema.Number,
  live: Schema.Number,
  reads: Schema.Number,
  sends: Schema.Number,
  scopes: Schema.Number,
  scopesClosed: Schema.Number,
  requests: Schema.Number,
  requestsClosed: Schema.Number,
  waiters: Schema.Number,
});

async function fixture(action, fields = {}) {
  const response = await fetch(new URL("/fixture", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...fields }),
    signal: AbortSignal.timeout(15000),
  });

  const text = await response.text();
  assert.equal(response.status, 200, text);

  const result = decodeJson(
    Schema.Struct({
      ok: Schema.Boolean,
      value: Schema.optional(Schema.Json),
      error: Schema.optional(Schema.String),
    }),
    text,
  );

  assert.equal(result.ok, true, result.error);

  return result.value;
}

const stats = async () => Schema.decodeUnknownSync(Stats)(await fixture("stats"));

const wait = async (metric, target, waitMs = 10000) =>
  Schema.decodeUnknownSync(Stats)(await fixture("wait", { metric, target, waitMs }));

const issue = async (ttlMs = 30000) =>
  Schema.decodeUnknownSync(Session)(await fixture("issue", { ttlMs }));

const headers = (session) => ({
  "content-type": "application/x-ndjson",
  "x-local-session": session.key,
  authorization: "Bearer local-fixture-only",
  "x-kitties-library-epoch": "1",
});

const browserHeaders = (session) => ({ ...headers(session), origin: new URL(base).origin });

// Official Domain client over the official node:http adapter: unlike Node's
// global fetch it sends no browser Fetch Metadata on native bearer requests.
/**
 * @template A, E
 * @param {{key: string, expiresAt: number}} session
 * @param {(client: Effect.Success<typeof LibraryApi.client>) => Effect.Effect<A, E>} use
 */
const official = (session, use) => {
  const transport = Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;

      return HttpClient.mapRequest(client, HttpClientRequest.setHeaders(headers(session)));
    }),
  ).pipe(Layer.provide(NodeHttpClient.layerNodeHttp));

  return Effect.gen(function* () {
    const client = yield* LibraryApi.clientHttp(new URL("/v1/library/rpc", base).href);

    return yield* use(client);
  }).pipe(Effect.scoped, Effect.provide(transport));
};

/**
 * @template A, E
 * @param {{key: string, expiresAt: number}} session
 * @param {(client: Effect.Success<typeof LibraryApi.client>) => Effect.Effect<A, E>} use
 */
const call = (session, use) =>
  Effect.runPromise(official(session, use).pipe(Effect.timeout("10 seconds")));

async function nativeWatch(session) {
  const initial = Promise.withResolvers();

  const fiber = Effect.runFork(
    official(session, (client) =>
      client.Library.watch("owner").pipe(
        Stream.runForEach((snapshot) => Effect.sync(() => initial.resolve(snapshot))),
      ),
    ),
  );

  nativeClients.add(fiber);
  const exit = Effect.runPromise(Fiber.await(fiber));
  exit.then(
    (result) =>
      initial.reject(
        Error(`Native stream ended before initial snapshot: ${JSON.stringify(result)}`),
      ),
    (error) => initial.reject(error),
  );
  const first = await deadline(initial.promise, 10000, "official native client first snapshot");

  return {
    first,
    stop: async () => {
      await deadline(
        Effect.runPromise(Fiber.interrupt(fiber)),
        4000,
        "official native client interruption",
      );
      nativeClients.delete(fiber);
    },
  };
}

const RequestFrame = Schema.TaggedStruct("Request", {
  id: Schema.String,
  tag: Schema.String,
  payload: Schema.Json,
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
});

const frame = (tag, payload, id = "one") =>
  JSON.stringify(RequestFrame.make({ id, tag, payload, headers: [] })) + "\n";

async function rpc(body, session) {
  const response = await fetch(new URL("/v1/library/rpc", base), {
    method: "POST",
    headers: browserHeaders(session),
    body,
    signal: AbortSignal.timeout(10000),
  });

  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.equal(response.headers.get("content-type"), "application/x-ndjson");

  return text.trim().split("\n").filter(Boolean).map(json);
}

async function handshake(session) {
  const response = await fetch(new URL("/v1/library/session", base), {
    headers: browserHeaders(session),
    signal: AbortSignal.timeout(10000),
  });

  return { status: response.status, value: json(await response.text()) };
}

async function watch(session, id) {
  const abort = new AbortController();
  clients.add(abort);

  const response = await fetch(new URL("/v1/library/rpc", base), {
    method: "POST",
    headers: browserHeaders(session),
    body: frame("Library.watch", { key: "owner" }, id),
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/x-ndjson");
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";

  while (!text.includes("\n")) {
    const item = await deadline(reader.read(), 10000, "initial watch snapshot");
    assert.equal(item.done, false, "watch must deliver initial state");
    text += decoder.decode(item.value, { stream: true });
  }

  const first = json(text.slice(0, text.indexOf("\n")));
  assert.equal(
    Schema.decodeUnknownSync(Schema.Struct({ _tag: Schema.String }))(first)._tag,
    "Chunk",
  );

  return {
    abort,
    first,
    drain: async () => {
      try {
        for (;;) {
          const item = await reader.read();

          if (item.done) return "end";
        }
      } catch (error) {
        return String(error);
      } finally {
        clients.delete(abort);
      }
    },
  };
}

async function check(name, run) {
  try {
    await run();
  } catch (error) {
    const evidence = { name, error: String(error), counts: await stats() };
    failedCases.push(evidence);
    console.error("FAIL " + JSON.stringify(evidence));
  }
}

function pass(name, evidence) {
  results.push({ name, evidence });
  console.log("PASS " + JSON.stringify({ name, evidence }));
}

try {
  if (process.platform !== "linux")
    throw Error("Owned process-group cleanup currently verified on Linux only");
  host = launch();
  base = (await host.event("ready", 60000)).url;
  assert.ok(base);
  assert.equal(new URL(base).hostname, "127.0.0.1");
  assert.equal(host.lines.find((line) => line.event === "local-state").id, "local");
  const signalBase = (await host.event("signal-direct-ready")).url;
  const controlAbort = new AbortController();

  const controlResponse = await fetch(new URL("/watch", signalBase), {
    signal: controlAbort.signal,
  });

  const controlReader = controlResponse.body.getReader();
  assert.equal((await controlReader.read()).done, false);
  controlAbort.abort();
  await assert.rejects(controlReader.read());

  const controlSignal = await fetch(new URL("/wait", signalBase), {
    signal: AbortSignal.timeout(6000),
  });

  const idleControl = json(await controlSignal.text());
  assert.ok(controlAbort.signal.aborted);
  await fetch(new URL("/release", signalBase), { signal: AbortSignal.timeout(6000) }).then(
    (response) => response.text(),
  );

  const writtenSignal = await fetch(new URL("/wait", signalBase), {
    signal: AbortSignal.timeout(6000),
  });

  const afterWrite = json(await writtenSignal.text());
  pass("plain workerd disconnect control records idle and explicitly released output", {
    idle: idleControl,
    afterWrite,
  });

  if (mode === "signal") {
    const idle = Schema.decodeUnknownSync(
      Schema.Struct({ aborted: Schema.Number, cancelled: Schema.Number }),
    )(idleControl);

    assert.ok(
      idle.aborted + idle.cancelled > 0,
      "Pinned workerd did not signal an idle downstream abort; after-write evidence retained",
    );
  } else {
    await fixture("initialize");
    const session = await issue();
    assert.deepEqual(await handshake(session), {
      status: 200,
      value: { libraryId: "owner", epoch: 1, expiresAt: session.expiresAt },
    });
    pass("production HTTP handshake reads actual ready RecoveryDO and finalized Library", {
      epoch: 1,
      auth: "explicit loopback fixture, no Cloudflare Access claim",
    });

    const proposal = frame("ProposeSkill", {
      target: "owner",
      input: { name: "Original", body: "Keep" },
      commandId: "library:1:owned-session:0",
    });

    const expected = json(
      '[{"_tag":"Exit","requestId":"one","exit":{"_tag":"Success","value":{"reply":{"skillId":"kitties-skill-0000000000000001","proposalRevision":2},"stream":"Library/owner","version":2}}}]',
    );

    const expectedReceipt = json(
      '{"reply":{"skillId":"kitties-skill-0000000000000001","proposalRevision":2},"stream":"Library/owner","version":2}',
    );

    const nativeProposal = (client) =>
      client.ProposeSkill(
        "owner",
        { name: "Original", body: "Keep" },
        { commandId: "library:1:owned-session:0" },
      );

    assert.deepEqual(await rpc(proposal, session), expected);
    assert.deepEqual(await call(session, nativeProposal), expectedReceipt);
    assert.deepEqual(await call(session, nativeProposal), expectedReceipt);
    assert.deepEqual(await rpc(proposal, session), expected);
    assert.deepEqual(
      await rpc(proposal, session),
      expected,
      "byte-identical uncertain retry retains receipt",
    );
    assert.deepEqual(
      await rpc(proposal.replace("Original", "Changed"), session),
      expected,
      "cached receipt remains original",
    );
    const catalogue = await rpc(frame("Library.get", { key: "owner" }), session);

    const state = Schema.decodeUnknownSync(
      Schema.Struct({
        exit: Schema.Struct({
          value: Schema.Struct({
            active: Schema.Array(Schema.Struct({ name: Schema.String })),
            highWater: Schema.Number,
            catalogueRevision: Schema.Number,
          }),
        }),
      }),
    )(catalogue[0]).exit.value;

    assert.deepEqual(state, { active: [{ name: "Original" }], highWater: 1, catalogueRevision: 2 });
    pass("official NDJSON command and duplicate native receipt retain one allocation", {
      reply: expected,
      catalogue: state,
    });

    const missing = await rpc(
      frame("AcceptSkill", {
        target: "owner",
        input: { skillId: "missing", expectedProposalRevision: 1 },
        commandId: "library:1:missing",
      }),
      session,
    );

    assert.deepEqual(
      missing,
      json(
        '[{"_tag":"Exit","requestId":"one","exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"SkillMissing","skillId":"missing"}}]}}]',
      ),
    );
    const beforeDenied = await stats();
    const denied = await rpc(frame("Library.get", { key: "other" }), session);

    const expectedDenied = json(
      '[{"_tag":"Exit","requestId":"one","exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"LibraryUnauthorized"}}]}}]',
    );

    assert.deepEqual(denied, expectedDenied);
    assert.equal((await stats()).reads, beforeDenied.reads);
    pass("typed business rejection and owner denial preserve official error frames", {
      missing,
      denied,
    });

    assert.deepEqual(
      await call(session, (client) =>
        client
          .AcceptSkill(
            "owner",
            { skillId: "missing", expectedProposalRevision: 1 },
            { commandId: "library:1:native-missing" },
          )
          .pipe(
            Effect.map(() => "unexpected acceptance"),
            Effect.catchTag("SkillMissing", (error) =>
              Effect.succeed({ tag: error._tag, skillId: error.skillId }),
            ),
          ),
      ),
      { tag: "SkillMissing", skillId: "missing" },
    );
    pass("official native Domain client decodes a typed business rejection", {
      tag: "SkillMissing",
      skillId: "missing",
    });

    const beforeAmbiguous = await stats();

    const ambiguous = await rpc(
      proposal.replace('"target":"owner"', '"target":"owner","key":"other/skill"'),
      session,
    );

    assert.ok(JSON.stringify(ambiguous).includes("Expected no excess property"));
    const afterAmbiguous = await stats();
    assert.equal(
      afterAmbiguous.sends,
      beforeAmbiguous.sends,
      "strict decoder rejects before cached-receipt lookup",
    );
    assert.equal(afterAmbiguous.reads, beforeAmbiguous.reads);
    pass("ambiguous raw selector rejected before native handler or receipt lookup", {
      ambiguous,
      sends: afterAmbiguous.sends,
    });

    const expired = await issue(-1);
    assert.equal((await handshake(expired)).status, 403);
    const old = await issue(2500);
    const beforeWatch = await stats();
    const oldWatch = await watch(old, "old-watch");
    const fresh = await issue(20000);
    assert.equal((await handshake(fresh)).status, 200);
    const freshWatch = await watch(fresh, "fresh-watch");
    assert.equal((await stats()).live, 2);
    const oldEnd = await deadline(oldWatch.drain(), 8000, "idle session expiry body termination");
    const oneRemaining = await wait("closed", beforeWatch.closed + 1);
    assert.ok(Date.now() >= old.expiresAt);
    assert.equal(
      oneRemaining.live,
      1,
      "reauthentication cannot extend the old watch or close the fresh watch",
    );
    assert.equal((await handshake(old)).status, 403);
    pass("idle body expiry closes old scope while reauthenticated watch remains live", {
      oldEnd,
      oldExpiresAt: old.expiresAt,
      live: oneRemaining.live,
    });

    await check("browser fetch abort releases remote idle subscription promptly", async () => {
      const beforeAbort = await stats();
      const abortDrain = freshWatch.drain();
      freshWatch.abort.abort();
      await deadline(abortDrain, 4000, "client abort read termination");
      const aborted = await wait("closed", beforeAbort.closed + 1, 1000);
      await wait("requestsClosed", beforeAbort.requestsClosed + 1);
      await wait("scopesClosed", beforeAbort.scopesClosed + 1);
      assert.equal(aborted.live, beforeAbort.live - 1);
      assert.ok(Date.now() < fresh.expiresAt, "disconnect must tear down before session deadline");
      pass("actual fetch abort closes native watch, child scope and server request scope", {
        freshExpiresAt: fresh.expiresAt,
        closedAt: Date.now(),
        counts: await stats(),
      });
    });

    await check(
      "official native client abort releases remote idle subscription promptly",
      async () => {
        const nativeBaseline = await stats();
        const nativeSession = await issue();
        const ownedNative = await nativeWatch(nativeSession);
        const beforeNativeStop = await stats();

        assert.equal(beforeNativeStop.live, nativeBaseline.live + 1);
        await ownedNative.stop();
        assert.equal(
          (await wait("closed", beforeNativeStop.closed + 1, 1000)).live,
          nativeBaseline.live,
        );
        await wait("requestsClosed", beforeNativeStop.requestsClosed + 1);
        assert.ok(Date.now() < nativeSession.expiresAt);
        pass(
          "official native HTTP client scope cancellation tears down remote watch before expiry",
          {
            first: ownedNative.first,
          },
        );
      },
    );

    const reconnected = await watch(await issue(), "reconnected-watch");
    const beforeReconnectAbort = await stats();
    assert.ok(beforeReconnectAbort.live >= 1);
    reconnected.abort.abort();
    await deadline(reconnected.drain(), 4000, "reconnected client cleanup");

    pass("new authenticated HTTP watch reconnects after local cancellation and expiry", {
      first: reconnected.first,
    });

    await fixture("freeze");
    const fenced = await rpc(proposal, session);
    assert.deepEqual(fenced, expectedDenied);
    assert.equal((await handshake(session)).status, 409);
    pass("non-restored control fences a previously cached command receipt", { fenced });

    if (failedCases.length > 0) {
      failure = { error: `${failedCases.length} native lifecycle gate(s) failed` };
      process.exitCode = 1;
    }
  }
} catch (error) {
  failure = { error: String(error), stack: error.stack };
  process.exitCode = 1;
  console.error(error);
} finally {
  for (const client of clients) client.abort();

  for (const fiber of nativeClients) {
    try {
      await deadline(Effect.runPromise(Fiber.interrupt(fiber)), 4000, "native client cleanup");
    } catch (error) {
      failure ??= { error: String(error), stack: error.stack };
      process.exitCode = 1;
    }
  }

  try {
    await stop();
  } catch (error) {
    failure ??= { error: String(error), stack: error.stack };
    process.exitCode = 1;
    console.error(error);
  }

  for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, cancelController);

  writeFileSync(
    join(stateDir, "results.json"),
    JSON.stringify(
      { verdict: failure ? "FAIL" : "PASS", failure, events, results, failedCases },
      null,
      2,
    ),
  );

  if (!failure) console.log(`PASS ${results.length} native HTTP cases; evidence ${stateDir}`);
}
