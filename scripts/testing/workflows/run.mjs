// Owned native integration controller. No assertions poll or retry; waits target persisted milestones.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

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

const CallbackStatus = Schema.Struct({
  scheduledAt: Schema.Number,
  retryAt: Schema.NullOr(Schema.Number),
  attempts: Schema.Number,
  parked: Schema.Boolean,
  progress: Schema.NullOr(Schema.Number),
});

const Manifest = Schema.Struct({
  id: Schema.String,
  at: Schema.Number,
  tables: Schema.Array(Schema.Struct({ table: Schema.String, rows: Schema.Number })),
});

const Part = Schema.Struct({
  table: Schema.String,
  row: Schema.Number,
  part: Schema.Number,
  chunk: Schema.String,
});

const caseName = process.argv[2] ?? "full";

if (!["full", "failure"].includes(caseName)) throw Error("Usage: run.mjs [full|failure]");

const stateDir = join(
  root,
  ".context/workflow-check",
  `${caseName}-${Date.now()}-${randomUUID().slice(0, 8)}`,
);

mkdirSync(stateDir, { recursive: true });

const results = [];
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

  if (process.env.WORKFLOW_CHECK_MUTANT)
    env.WORKFLOW_CHECK_MUTANT = process.env.WORKFLOW_CHECK_MUTANT;

  const child = spawn(process.execPath, [join(directory, "host.mjs"), stateDir], {
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

let base, typedId;

async function api(action, fields = {}, ms = 15000) {
  const url = new URL(base);
  assert.equal(url.hostname, "127.0.0.1");
  let response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...fields }),
      signal: AbortSignal.timeout(ms),
    });
  } catch (error) {
    throw Error(`Request deadline/failure: ${action} ${JSON.stringify(fields)}`, { cause: error });
  }

  const body = await response.text();
  assert.equal(response.status, 200, `${action} response: ${body.slice(0, 1000)}`);

  return decodeJson(Schema.Json, body);
}

const admin = (id, key, ...args) => api("admin", { id, key, args });
const wait = (key, n = 1, ms = 15000) => api("wait", { key, n }, ms);

function pass(name, evidence) {
  const entry = { name, evidence };
  results.push(entry);
  console.log("PASS " + JSON.stringify(entry));
}

async function capture(id, name) {
  const manifestText = await admin(id, "adminCapture", name);

  const manifest = decodeJson(Manifest, manifestText),
    rows = {};

  assert.deepEqual(
    manifest.tables.map(({ table }) => table).sort(),
    [
      "workflow_execution",
      "workflow_activity",
      "workflow_deferred",
      "workflow_clock",
      "workflow_meta",
      "workflow_progress",
      "alchemy_alarm_callbacks",
      "alchemy_alarm_schema",
      "alchemy_scheduled_events",
    ].sort(),
    "capture must include every durable workflow and alarm bookkeeping table",
  );

  for (const table of manifest.tables) {
    rows[table.table] = [];

    for (let row = 1; row <= table.rows; row++) {
      let joined = "",
        part = 0,
        last = false;

      while (!last) {
        assert.ok(part < 1024, "bounded export must terminate");
        const value = await admin(id, "adminReadPart", name, table.table, row, part);
        const envelope = decodeJson(Part, value.body);
        assert.equal(envelope.table, table.table);
        assert.equal(envelope.row, row);
        assert.equal(envelope.part, part);
        assert.ok(envelope.chunk.length <= 32768, "export character bound");
        joined += envelope.chunk;
        last = value.last;
        part++;
      }

      rows[table.table].push({ value: decodeJson(Schema.Json, joined), parts: part, text: joined });
    }
  }

  return { manifestText, rows };
}

try {
  if (process.platform !== "linux")
    throw Error(
      "Native SIGKILL proof currently requires Linux /proc; this command does not claim macOS/Windows coverage",
    );
  host = launch();
  base = (await host.event("ready")).url;
  assert.equal(host.lines.find((line) => line.event === "local-state").id, "local");
  typedId = await api("start", { id: "typed-failure", mode: "failure" });
  assert.equal(await api("result", { id: typedId }, 10000), "typed-handler-reached");
  assert.equal((await api("ledger", { key: "typed-failure-failed" })).n, 1);
  assert.equal((await api("ledger", { key: "typed-failure-handled" })).n, 1);
  pass("typed activity failure reaches handler under SuspendOnFailure", {
    typedId,
    failed: 1,
    handled: 1,
  });

  if (caseName === "full") {
    await api("callback-start", { mode: "progress" });
    await wait("callback-progress-status", 11);

    for (let step = 0; step <= 10; step++) {
      const status = decodeJson(
        CallbackStatus,
        (await api("ledger", { key: "callback-progress-" + step })).body,
      );

      assert.equal(status.parked, false);
      assert.ok(status.attempts <= 1);
      assert.equal(status.progress, step === 10 ? 10 : step + 1);
    }

    pass("committed callback progress resets retry budget beyond maxAttempts", {
      callbacks: 11,
      maxAttempts: 2,
    });
    await api("callback-start", { mode: "stuck" });
    const parked = decodeJson(CallbackStatus, (await wait("callback-parked")).body);
    assert.equal(parked.parked, true);
    assert.equal(parked.attempts, 2);
    assert.ok(parked.retryAt - parked.scheduledAt >= 3599000);
    assert.equal((await api("ledger", { key: "callback-call-stuck" })).n, 2);
    const persisted = await api("callback-status");
    assert.equal(persisted.parked, true);
    assert.equal(persisted.attempts, 2);

    const clockId = await api("start", { id: "durable-clocks", mode: "progress" });
    assert.equal(await api("result", { id: clockId }), "ten-durable-clocks-completed");

    for (let step = 0; step < 10; step++)
      assert.equal((await api("ledger", { key: "durable-clocks-step-" + step })).n, 1);
    const clocks = await admin(clockId, "adminSummary");
    assert.equal(clocks.execution[0].completed, 1);
    assert.ok(clocks.progress[0].seq >= 10);
    pass("workflow passes ten native durable clock wakes", { clockId, progress: clocks.progress });

    const restartId = await api("start", { id: "restart", mode: "restart" });
    await wait("restart-ready");
    const before = await capture(restartId, "before-restart");

    const activity = before.rows.workflow_activity.find((row) =>
      row.text.includes("x".repeat(70000)),
    );

    assert.ok(activity, "large immutable activity journal must be captured");
    assert.equal(activity.parts, 3);
    const started = await admin(restartId, "adminSummary");
    const startedAt = started.meta.find((row) => row.key === "started_at")?.value;
    assert.ok(Number.isSafeInteger(startedAt) && startedAt > 0);
    assert.equal(
      started.meta.find((row) => row.key === "completed_at"),
      undefined,
    );
    pass("capture includes durable started metadata and bounded large journal export", {
      restartId,
      startedAt,
      parts: activity.parts,
    });

    const children = readFileSync(`/proc/${host.child.pid}/task/${host.child.pid}/children`, "utf8")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    const workerds = children.filter(
      (pid) => basename(readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0]) === "workerd",
    );

    assert.equal(workerds.length, 1, "kill only the single owned native workerd child");
    const restarted = host.event("workerd-restarted", 20000, true);
    process.kill(Number(workerds[0]), "SIGKILL");
    await restarted;
    assert.deepEqual(
      await api("callback-status"),
      parked,
      "parked retry accounting must survive workerd death",
    );
    await api("callback-start", { mode: "resumed" });

    const resumed = decodeJson(
      Schema.Struct({ call: Schema.Number, status: CallbackStatus }),
      (await wait("callback-resumed")).body,
    );

    assert.equal(resumed.status.parked, false);
    assert.equal(resumed.status.attempts, 1);
    pass("no-progress callback parks durably and external schedule resumes it", {
      parked,
      resumed,
    });

    assert.deepEqual(await capture(restartId, "before-restart"), before);
    assert.equal((await api("ledger", { key: "restart-before" })).n, 1);
    await api("resume", { id: restartId });
    await api("signal", { id: restartId });
    assert.equal(await api("result", { id: restartId }), "resumed:operator-value");
    assert.equal((await api("ledger", { key: "restart-before" })).n, 1);
    assert.equal((await api("ledger", { key: "restart-after" })).n, 1);
    const done = await admin(restartId, "adminSummary");
    const completedAt = done.meta.find((row) => row.key === "completed_at")?.value;
    assert.ok(Number.isSafeInteger(completedAt) && completedAt >= startedAt);
    assert.deepEqual(await capture(restartId, "before-restart"), before);
    const after = await capture(restartId, "after-completion");
    assert.notDeepEqual(after.rows.workflow_execution, before.rows.workflow_execution);
    assert.ok(after.rows.workflow_execution.some((row) => row.value.result !== null));
    pass("SIGKILL native workerd, resume once, retain immutable capture and completion metadata", {
      killedPid: workerds[0],
      completedAt,
    });

    assert.equal(await admin(restartId, "adminPurge", completedAt + 1), true);
    const purged = await admin(restartId, "adminSummary");
    assert.equal(purged.activities.length, 0);
    assert.equal(purged.execution[0].completed, 1);
    assert.equal(await api("start", { id: "restart", mode: "restart" }), restartId);
    assert.equal(await api("result", { id: restartId }), "resumed:operator-value");
    assert.equal((await api("ledger", { key: "restart-before" })).n, 1);
    assert.equal((await api("ledger", { key: "restart-after" })).n, 1);
    assert.equal(purged.meta.find((row) => row.key === "started_at").value, startedAt);
    assert.equal(purged.meta.find((row) => row.key === "completed_at").value, completedAt);
    pass("purge removes journal but duplicate execution retains result and identity", {
      restartId,
      activities: purged.activities.length,
    });

    await stop();
    host = launch();
    base = (await host.event("ready")).url;
    assert.equal(await api("start", { id: "restart", mode: "restart" }), restartId);
    assert.equal(await api("result", { id: restartId }), "resumed:operator-value");
    assert.equal((await api("ledger", { key: "restart-before" })).n, 1);
    assert.equal((await api("ledger", { key: "restart-after" })).n, 1);
    assert.deepEqual((await admin(restartId, "adminSummary")).meta, purged.meta);
    pass("entire host restart preserves SQLite tombstone, ledger and timestamps", { restartId });
  }
} catch (error) {
  failure = { error: String(error), stack: error.stack };
  process.exitCode = 1;
  console.error(error);

  if (typedId && process.env.WORKFLOW_CHECK_MUTANT) {
    try {
      const failed = await api("ledger", { key: "typed-failure-failed" });
      const handled = await api("ledger", { key: "typed-failure-handled" });
      results.push({ name: "mutant diagnostic", evidence: { failed, handled } });
      console.log("MUTANT_DIAGNOSTIC " + JSON.stringify({ failed, handled }));
    } catch (diagnosticError) {
      results.push({ name: "mutant diagnostic unavailable", evidence: String(diagnosticError) });
    }
  }
} finally {
  try {
    await stop();
  } catch (error) {
    failure ??= { error: String(error), stack: error.stack };
    process.exitCode = 1;
    console.error(error);
  }

  if (!failure)
    console.log(`PASS ${results.length} native integration cases; evidence ${stateDir}`);

  writeFileSync(
    join(stateDir, "results.json"),
    JSON.stringify({ verdict: failure ? "FAIL" : "PASS", failure, events, results }, null, 2),
  );
}
