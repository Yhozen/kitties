// A native storage/lifecycle check, separate from ordinary Vitest and cloud deployment.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Data from "effect/Data";
import { ArchiveResponse } from "./protocol.ts";
import { runPrune } from "./prune.mjs";
import { runScheduled } from "./scheduled.mjs";
import { decodeLibraryValue } from "../../../apps/gateway/src/library-image.ts";

/** @type {Data.TaggedEnum.Constructor<import('../../../apps/gateway/src/library-object-admin.ts').LibraryAdminRequest>} */
const Admin = Data.taggedEnum();

/** @type {Data.TaggedEnum.Constructor<import('../../../apps/gateway/src/library-recovery-records.ts').LibraryRestoreSource>} */
const Source = Data.taggedEnum();

const directory = import.meta.dirname;
const root = resolve(directory, "../../..");
const mode = process.argv[2] ?? "all";
const mutant = process.env.LIBRARY_ARCHIVE_MUTANT;

if (!["bundle", "capture", "all", "prune", "scheduled"].includes(mode))
  throw Error("Usage: run.mjs [bundle|capture|all|prune|scheduled]");

if (mutant !== undefined && mutant !== "destructive-capture") throw Error("Unknown archive mutant");

const output = join(
  root,
  ".context/library-archive-check",
  `${Date.now()}-${randomUUID().slice(0, 8)}`,
);

mkdirSync(output, { recursive: true });

let stateDirectory = output;

const hostPath = join(directory, "host.mjs");
const events = [];
const results = [];
const cleanup = [];
let host;
let base;

const Event = Schema.Struct({
  event: Schema.String,
  url: Schema.optional(Schema.String),
  unchanged: Schema.optional(Schema.Boolean),
  hash: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  mutant: Schema.optional(Schema.NullOr(Schema.String)),
  mutationCount: Schema.optional(Schema.Number),
  coordinatorSha256: Schema.optional(Schema.String),
});

const decodeJson = (schema, text) => Schema.decodeUnknownSync(Schema.fromJsonString(schema))(text);

const deadline = (promise, ms, label) => {
  let timer;

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`Deadline: ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

const liveGroup = (group) =>
  readdirSync("/proc").flatMap((pid) => {
    if (!/^[0-9]+$/.test(pid)) return [];

    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");

      return fields[0] !== "Z" && Number(fields[2]) === group ? [Number(pid)] : [];
    } catch (error) {
      if (Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(error)) return [];
      throw error;
    }
  });

function launch(bundleOnly = false) {
  /** @type {NodeJS.ProcessEnv} */
  const childEnv = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    LANG: "C.UTF-8",
    CI: "1",
    NO_COLOR: "1",
    TMPDIR: output,
  };

  if (mutant !== undefined) childEnv.LIBRARY_ARCHIVE_MUTANT = mutant;

  const child = spawn(
    process.execPath,
    [hostPath, stateDirectory, ...(bundleOnly ? ["--bundle-only"] : [])],
    {
      cwd: root,
      detached: true,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const lines = [];
  const waiting = new Set();
  let buffer = "";
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    process.stdout.write(chunk);
    buffer += chunk;
    let end;

    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Event))(line);

      if (Option.isNone(parsed)) continue;
      lines.push(parsed.value);
      events.push(parsed.value);

      for (const waiter of waiting)
        if (waiter.name === parsed.value.event) {
          waiting.delete(waiter);
          waiter.resolve(parsed.value);
        }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });
  const closed = once(child, "close");
  child.on("close", (code, signal) => {
    writeFileSync(join(output, `host-${child.pid}.stdout.ndjson`), stdout);
    writeFileSync(join(output, `host-${child.pid}.stderr.log`), stderr);

    for (const waiter of waiting) waiter.reject(Error(`Host exited ${code}/${signal}`));
    waiting.clear();
  });

  return {
    child,
    bundleOnly,
    lines,
    closed,
    event: (name) =>
      deadline(
        new Promise((resolve, reject) => {
          const existing = lines.find((line) => line.event === name);

          if (existing) resolve(existing);
          else waiting.add({ name, resolve, reject });
        }),
        60000,
        `host ${name}`,
      ),
  };
}

function ownedSignal(signal) {
  assert.ok(host);
  const args = readFileSync(`/proc/${host.child.pid}/cmdline`, "utf8").split("\0");
  assert.equal(args[1], hostPath, "signal only the exact owned host executable");
  assert.equal(args[2], stateDirectory, "signal only this run's state directory");
  process.kill(-host.child.pid, signal);
}

async function stop(crash = false) {
  if (!host) return;
  const current = host;

  try {
    if (!current.bundleOnly && current.child.exitCode === null && current.child.signalCode === null)
      ownedSignal(crash ? "SIGKILL" : "SIGTERM");
    const [code, signal] = await deadline(current.closed, 15000, "owned process-group shutdown");

    if (crash) {
      assert.equal(code, null);
      assert.equal(signal, "SIGKILL");
    } else {
      assert.equal(code, 0);
      assert.equal(signal, null);
      assert.deepEqual(
        current.lines
          .filter((event) => event.event === "engine-files-unchanged")
          .map((event) => event.unchanged),
        [true],
      );
    }

    assert.deepEqual(liveGroup(current.child.pid), [], "all owned native children must stop");
    cleanup.push({
      pid: current.child.pid,
      crash,
      processGroupClean: true,
      engineVerified: crash ? null : true,
    });
  } catch (error) {
    const members = liveGroup(current.child.pid);

    if (members.length > 0) {
      // The group was allocated by this detached child. Membership is confined to its session.
      process.kill(-current.child.pid, "SIGKILL");
      await deadline(current.closed, 5000, "owned forced cleanup");
    }

    throw error;
  } finally {
    current.child.stdout.destroy();
    current.child.stderr.destroy();
    current.child.unref();
    host = undefined;
  }
}

async function api(action, fields = {}, ms = 20000) {
  const url = new URL(base);
  assert.equal(url.hostname, "127.0.0.1");

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...fields }),
    signal: AbortSignal.timeout(ms),
  });

  assert.equal(response.status, 200, `${action}: native fixture status`);

  return decodeJson(ArchiveResponse, await response.text());
}

const good = async (action, fields = {}, ms) => {
  const result = await api(action, fields, ms);
  assert.equal(result.ok, true, `${action}: reason=${result.reason ?? "unknown"}; ${result.error}`);

  return result.value;
};

const pass = (name, evidence) => {
  results.push({ name, evidence });
  console.log(`PASS ${JSON.stringify({ name, evidence })}`);
};

async function start() {
  host = launch();
  base = (await host.event("ready")).url;
}

async function inventory(action, fields) {
  const objects = [];
  let after = 0;

  for (let page = 0; page < 64; page++) {
    const rows = await good(action, { ...fields, after });

    if (rows.length === 0) return objects;

    for (const row of rows) {
      assert.ok(row.ordinal > after);
      objects.push(row);
      after = row.ordinal;
    }
  }

  throw Error("Fixture inventory exceeds its finite page budget");
}

async function interruptedCapture(boundary, nextBoundary, globalBefore, startedAt) {
  await good("arm", { boundary });

  const request = api("capture", { operationId: "capture-one" }, 125000).then(
    (value) => ({ reply: value }),
    () => ({ connectionLost: true }),
  );

  const milestone = decodeJson(Schema.Json, await good("wait", { boundary }));
  assert.equal(milestone.operationId, "capture-one");
  assert.deepEqual(await good("global"), globalBefore);
  assert.equal(await good("permit", { startedAt }), true);

  if (boundary === "capture") {
    const changedDigest = await api("capture-mismatch", { operationId: "capture-one" });

    assert.equal(changedDigest.ok, false);
    assert.equal(changedDigest.reason, "conflict");
  }

  if (boundary === "rearm") {
    const sealed = await inventory("capture-inventory", { operationId: "capture-one" });
    const object = sealed.find((ref) => ref.nativeId === milestone.nativeId);

    assert.ok(object);

    const premature = await good("admin", {
      ref: object,
      request: Admin.VerifyResumed({ operationId: "capture-one", before: milestone.resuming }),
    });

    assert.equal(
      premature._tag,
      "Rejected",
      "rearm without a fresh initialized constructor is unverified",
    );
  }

  const blocked = await api("state", { epoch: 1 });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /LibraryAdmissionDenied/);

  const denied = await api("propose", {
    epoch: 1,
    id: "paused",
    name: "Paused",
    body: "must not allocate",
  });

  assert.equal(denied.ok, false);
  assert.match(denied.error, /LibraryAdmissionDenied/);
  await stop(true);
  await request;
  await start();
  await good("arm", { boundary: nextBoundary });
  assert.deepEqual(await good("global"), globalBefore);
  assert.equal(await good("permit", { startedAt }), true);

  return milestone;
}

async function nativeImage(ref, captureId) {
  const image = await good("image", { captureId, ordinal: ref.ordinal });
  assert.ok(image !== null);
  const rowCount = image.kvCount + image.sqlCount + 1;
  assert.ok(rowCount <= 1024, "the small fixture must stay within its fixed image row budget");
  let alarm;
  let callbacks = 0;
  let outbox = false;

  for (let row = 1; row <= rowCount; row++) {
    const first = await good("admin", {
      ref,
      request: Admin.ExportPart({ grantId: "inspect-grant", captureId, row, part: 0 }),
    });

    assert.equal(first._tag, "Part");

    if (first.value.kind !== "alarm" && first.value.kind !== "alchemy_alarm_callbacks") continue;
    const pieces = [first.value.chunk];

    for (let part = 1; part < first.value.parts; part++) {
      const next = await good("admin", {
        ref,
        request: Admin.ExportPart({ grantId: "inspect-grant", captureId, row, part }),
      });

      assert.equal(next._tag, "Part");
      pieces.push(next.value.chunk);
    }

    const decoded = decodeLibraryValue(pieces.join(""));

    if (first.value.kind === "alarm") alarm = decoded;
    else {
      callbacks += 1;

      if (decoded.callback === "domain:outbox" && decoded.id === "drain") outbox = true;
    }
  }

  return { image, alarm, callbacks, outbox };
}

let failure;

try {
  if (mode === "scheduled") {
    await runScheduled({
      good,
      inventory,
      pass,
      start,
      stop,
      setPolicyTime: async (now) => {
        assert.ok(Number.isSafeInteger(now) && now >= 0);
        await stop();
        writeFileSync(join(stateDirectory, "fixture-prune-now"), JSON.stringify(now));
        await start();
      },
    });
  } else if (mode === "prune") {
    await runPrune({
      api,
      good,
      inventory,
      pass,
      start,
      stop,
      isolate: async (name) => {
        assert.match(name, /^[a-z0-9-]+$/);
        await stop();
        stateDirectory = join(output, name);
        mkdirSync(stateDirectory, { recursive: true });
        await start();
      },
      setPolicyTime: async (now) => {
        assert.ok(Number.isSafeInteger(now) && now >= 0);
        await stop();
        writeFileSync(join(stateDirectory, "fixture-prune-now"), JSON.stringify(now));
        await start();
      },
    });
  } else if (mode === "bundle") {
    host = launch(true);
    const bundle = await host.event("bundle");
    await stop();
    pass("official WorkerBundle compiles production capture with isolated native exports", {
      hash: bundle.hash,
    });
  } else {
    await start();
    const initialized = await good("initialize");
    assert.equal(initialized.epoch, 1);
    const startedAt = Date.now();
    assert.equal(await good("permit", { startedAt }), true);
    const globalBefore = await good("global");

    const first = await good("propose", {
      epoch: 1,
      id: "seed",
      name: "Seed",
      body: "Immutable archive seed",
    });

    const accepted = await good("accept", {
      epoch: 1,
      id: "accept-seed",
      skillId: first.reply.skillId,
      revision: first.reply.proposalRevision,
    });

    assert.equal(
      (await good("detail", { epoch: 1, skillId: first.reply.skillId, atLeast: accepted }, 75000))
        .value.status,
      "accepted",
    );
    await good("delivery-gate", { key: "owner/kitties-skill-0000000000000002" });

    const pending = await good("propose", {
      epoch: 1,
      id: "pending",
      name: "Pending",
      body: "Pending archive delivery",
    });

    assert.equal(pending.reply.skillId, "kitties-skill-0000000000000002");
    const original = await good("state", { epoch: 1 });
    const liveBefore = await inventory("inventory", { lineage: "library-1" });
    assert.ok(!liveBefore.some((ref) => ref.logicalName === `owner/${pending.reply.skillId}`));
    const captureCrash = await interruptedCapture("capture", "rearm", globalBefore, startedAt);
    const rearmCrash = await interruptedCapture("rearm", null, globalBefore, startedAt);
    assert.equal(rearmCrash.resuming, rearmCrash.nonce);
    const captured = await good("capture", { operationId: "capture-one" }, 125000);
    const ready = await good("status");
    assert.equal(ready.phase, "ready");
    assert.equal(ready.epoch, 1);
    assert.equal(ready.lineage, "library-1");
    assert.deepEqual(await good("global"), globalBefore);
    assert.equal(await good("permit", { startedAt }), true);
    const sealed = await inventory("capture-inventory", { operationId: "capture-one" });
    assert.equal(sealed.length, captured.objectCount);
    assert.deepEqual(
      sealed.map((ref) => ref.nativeId),
      liveBefore.map((ref) => ref.nativeId),
    );

    for (const ref of sealed) {
      const progress = await good("resume-progress", {
        operationId: "capture-one",
        ordinal: ref.ordinal,
      });

      assert.ok(progress !== null && progress.after !== null);
      assert.notEqual(progress.before, progress.after);
      const status = await good("admin", { ref, request: Admin.Status() });
      assert.equal(status._tag, "Status");
      assert.equal(status.value.initialized, true);
      assert.equal(status.value.mode, "active");
      assert.equal(status.value.held, false);
    }

    assert.deepEqual(await good("state", { epoch: 1 }), original);

    const duplicate = await good("propose", {
      epoch: 1,
      id: "seed",
      name: "Changed",
      body: "must return archived original",
    });

    assert.deepEqual(duplicate, first);
    await good("grant-export", { captureId: "capture-one", grantId: "inspect-grant" });
    const aggregate = sealed.find((ref) => ref.className === "LibraryModel.LibraryAggregate");
    assert.ok(aggregate);
    const immutable = await nativeImage(aggregate, "capture-one");
    Schema.decodeUnknownSync(Schema.Number)(immutable.alarm);
    assert.ok(immutable.alarm > 0);
    assert.equal(immutable.outbox, true);
    const rearmed = await good("inspect", { ref: aggregate, captureId: "capture-one" });
    assert.ok(rearmed.alarm !== null && rearmed.alarm > 0);
    assert.ok(rearmed.callbacks > 0);
    await good("delivery-gate", { key: null });
    assert.equal(
      (await good("detail", { epoch: 1, skillId: pending.reply.skillId, atLeast: pending }, 75000))
        .value.body,
      "Pending archive delivery",
    );
    pass(
      "same-ID capture/rearm restart preserves global workflow permission and all fresh native objects",
      {
        captureCrash,
        rearmCrash,
        objects: sealed.length,
        epoch: ready.epoch,
        workflowEpoch: globalBefore.epoch,
      },
    );
    pass("raw receipt, catalogue and pending native callback delivery survive capture", {
      highWater: original.highWater,
      receiptVersion: first.version,
      pendingVersion: pending.version,
      capturedAlarm: immutable.alarm,
      capturedCallbacks: immutable.callbacks,
      rearmedAlarm: rearmed.alarm,
    });

    if (mode === "all") {
      const grown = await good("propose", {
        epoch: 1,
        id: "after-capture",
        name: "After capture",
        body: "Must not enter the older archive",
      });

      assert.equal(grown.reply.skillId, "kitties-skill-0000000000000003");
      await good("detail", { epoch: 1, skillId: grown.reply.skillId, atLeast: grown }, 75000);
      const outgoing = await good("state", { epoch: 1 });
      const expanded = await inventory("inventory", { lineage: "library-1" });
      assert.ok(expanded.length > sealed.length);
      assert.deepEqual(
        await inventory("capture-inventory", { operationId: "capture-one" }),
        sealed,
      );

      await good("arm", { boundary: "upload" });

      const uploadRequest = api("archive", { operationId: "capture-one" }, 125000).then(
        (reply) => ({ reply }),
        () => ({ connectionLost: true }),
      );

      const uploadCrash = decodeJson(Schema.Json, await good("wait", { boundary: "upload" }));
      assert.equal(uploadCrash.encryptedEnvelope, true);
      assert.equal(uploadCrash.containsSeedPlaintext, false);
      assert.ok(uploadCrash.bytes > 0);
      assert.equal((await good("status")).phase, "ready");
      assert.deepEqual(await good("state", { epoch: 1 }), outgoing);
      assert.deepEqual(await good("global"), globalBefore);
      assert.equal(await good("permit", { startedAt }), true);
      await stop(true);
      await uploadRequest;
      await start();
      await good("arm", { boundary: null });
      assert.deepEqual(await good("archive-object", { key: uploadCrash.key }), uploadCrash);
      const archived = await good("archive", { operationId: "capture-one" }, 125000);
      assert.equal(archived.phase, "committed");
      assert.equal(archived.objectCount, sealed.length);
      assert.equal(archived.completeObjects, sealed.length);
      assert.equal(archived.commit.manifest.objectCount, sealed.length);
      assert.equal(archived.header.capturedAt, captured.capturedAt);
      assert.deepEqual(await good("archive-object", { key: uploadCrash.key }), uploadCrash);
      assert.deepEqual(await good("archive", { operationId: "capture-one" }, 125000), archived);
      assert.deepEqual(await good("state", { epoch: 1 }), outgoing);
      assert.deepEqual(await good("global"), globalBefore);
      assert.equal(await good("permit", { startedAt }), true);
      pass("same-ID encrypted R2 upload recovers its unacknowledged winner after host death", {
        winner: uploadCrash,
        capturedObjects: sealed.length,
        laterLiveObjects: expanded.length,
        archiveParts: archived.partCount,
        libraryTrafficReadyDuringUpload: true,
      });

      const mismatch = await api("retained-mismatch", {
        archiveId: "capture-one",
        restoreId: "retained-restore",
        captureId: "capture-one",
        source: aggregate,
        image: { ...immutable.image, digest: "0".repeat(64) },
      });

      assert.equal(mismatch.ok, false);
      assert.match(mismatch.error, /LibraryArchiveError/);
      assert.deepEqual(await good("state", { epoch: 1 }), outgoing);
      const heldPin = await good("restore-pin", { operationId: "retained-restore" });

      assert.deepEqual(heldPin, {
        id: "retained-restore",
        archiveId: "capture-one",
        kind: "restore",
        completed: false,
      });

      for (const ref of sealed) {
        const dropped = await good("drop-local-buffer", { ref, captureId: "capture-one" });
        assert.equal(dropped.localImages, 0);
        assert.equal(dropped.localRows, 0);
        assert.equal(dropped.localParts, 0);

        const absent = await good("admin", {
          ref,
          request: Admin.ExportPart({
            grantId: "capture-one",
            captureId: "capture-one",
            row: 1,
            part: 0,
          }),
        });

        assert.equal(absent._tag, "Rejected");
      }

      await stop();
      await start();
      const beforeRestore = await good("metrics");
      await good("arm", { boundary: "restore-intent" });

      const restoreRequest = api(
        "retained-restore",
        {
          operationId: "retained-restore",
          archiveId: "capture-one",
        },
        125000,
      ).then(
        (reply) => ({ reply }),
        () => ({ connectionLost: true }),
      );

      const intentMilestone = decodeJson(
        Schema.Json,
        await good("wait", { boundary: "restore-intent" }),
      );

      const expectedIntent = {
        setId: "capture-one",
        codeDigest: "a".repeat(64),
        source: Source.Retained({
          archiveId: "capture-one",
          manifestDigest: archived.commit.receipt.plainSha256,
        }),
      };

      assert.deepEqual(intentMilestone, { operationId: "retained-restore", ...expectedIntent });
      assert.equal(
        (await good("metrics")).remoteGet,
        beforeRestore.remoteGet,
        "production Operations must bind restore identity before the first retained object read",
      );
      assert.deepEqual(
        await good("restore-intent", { operationId: "retained-restore" }),
        expectedIntent,
      );

      const changedSource = await api("native-restore", {
        operationId: "retained-restore",
        captureId: "capture-one",
      });

      assert.equal(changedSource.ok, false);
      assert.equal(changedSource.reason, "conflict");
      assert.deepEqual(await good("restore-pin", { operationId: "retained-restore" }), heldPin);
      await stop(true);
      await restoreRequest;
      await start();
      await good("arm", { boundary: null });
      assert.deepEqual(
        await good("restore-intent", { operationId: "retained-restore" }),
        expectedIntent,
      );

      const restored = await good(
        "retained-restore",
        {
          operationId: "retained-restore",
          archiveId: "capture-one",
        },
        125000,
      );

      assert.equal(restored.phase, "ready");
      assert.equal(restored.epoch, 2);
      assert.equal(restored.lineage, "library-2");
      const completedPin = await good("restore-pin", { operationId: "retained-restore" });

      assert.deepEqual(completedPin, { ...heldPin, completed: true });

      const publishedSourceChange = await api("native-restore", {
        operationId: "retained-restore",
        captureId: "capture-one",
      });

      assert.equal(publishedSourceChange.ok, false);
      assert.equal(publishedSourceChange.reason, "conflict");
      assert.deepEqual(await good("status"), restored);
      assert.deepEqual(
        await good("restore-pin", { operationId: "retained-restore" }),
        completedPin,
      );
      const afterRestore = await good("metrics");
      assert.ok(afterRestore.remoteGet > beforeRestore.remoteGet);
      assert.equal(afterRestore.localRead, beforeRestore.localRead);
      const restoredState = await good("state", { epoch: 2 });
      assert.equal(
        restoredState.highWater,
        3,
        "outgoing allocator floor survives archive rollback",
      );
      assert.equal(restoredState.active.length, 2);
      assert.equal(
        restoredState.active.some((entry) => entry.id === grown.reply.skillId),
        false,
      );
      const rawReceipt = await good("raw-receipt", { epoch: 2, commandEpoch: 1, id: "seed" });
      assert.deepEqual(rawReceipt, first);

      const restoredDetail = await good(
        "detail",
        { epoch: 2, skillId: first.reply.skillId, atLeast: accepted },
        75000,
      );

      assert.equal(restoredDetail.value.body, "Immutable archive seed");
      assert.equal(restoredDetail.value.status, "accepted");
      assert.equal(
        (
          await good(
            "detail",
            { epoch: 2, skillId: pending.reply.skillId, atLeast: pending },
            75000,
          )
        ).value.body,
        "Pending archive delivery",
      );
      assert.deepEqual(
        await good(
          "retained-restore",
          { operationId: "retained-restore", archiveId: "capture-one" },
          125000,
        ),
        restored,
      );
      assert.deepEqual(await good("state", { epoch: 2 }), restoredState);

      const fresh = await good("propose", {
        epoch: 2,
        id: "fresh-after-archive",
        name: "Fresh",
        body: "No skill ID reuse",
      });

      assert.equal(fresh.reply.skillId, "kitties-skill-0000000000000004");
      const freshState = await good("state", { epoch: 2 });
      assert.deepEqual(
        await good(
          "retained-restore",
          { operationId: "retained-restore", archiveId: "capture-one" },
          125000,
        ),
        restored,
      );
      assert.deepEqual(await good("state", { epoch: 2 }), freshState);
      await stop();
      await start();
      assert.deepEqual(await good("state", { epoch: 2 }), freshState);
      assert.deepEqual(await good("raw-receipt", { epoch: 2, commandEpoch: 1, id: "seed" }), first);
      assert.deepEqual(
        await good("restore-pin", { operationId: "retained-restore" }),
        completedPin,
      );
      pass(
        "production retained restore survives loss of every local capture buffer and remains idempotent",
        {
          removedBuffers: sealed.length,
          mismatchRefused: true,
          epoch: restored.epoch,
          lineage: restored.lineage,
          restoredHighWater: restoredState.highWater,
          freshSkillId: fresh.reply.skillId,
          encryptedReads: afterRestore.remoteGet - beforeRestore.remoteGet,
          localReadAttempts: afterRestore.localRead - beforeRestore.localRead,
          completedPin,
          nativeSourceChangeRefusedBeforeAndAfterPublication: true,
        },
      );
    }

    await stop();
  }
} catch (error) {
  failure = error;
} finally {
  try {
    await stop();
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], "Proof and cleanup failed") : error;
  }

  writeFileSync(
    join(output, "results.json"),
    JSON.stringify(
      {
        verdict: failure ? "FAIL" : "PASS",
        mode,
        mutant: mutant ?? null,
        results,
        events,
        cleanup,
        error: failure?.stack ?? null,
      },
      null,
      2,
    ),
  );
}

if (failure) {
  console.error(failure);
  process.exitCode = 1;
} else console.log(`PASS ${results.length} archive ${mode} checks; evidence ${output}`);
