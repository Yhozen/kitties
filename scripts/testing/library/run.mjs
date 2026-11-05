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
import * as Data from "effect/Data";

/** @type {Data.TaggedEnum.Constructor<import('../../../apps/gateway/src/library-object-admin.ts').LibraryAdminReply>} */
const Reply = Data.taggedEnum();

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

const caseName = process.argv[2] ?? "all";

if (!["all", "full", "home"].includes(caseName)) throw Error("Usage: run.mjs [all|full|home]");

const mutant = process.env.LIBRARY_CHECK_MUTANT;

if (mutant && !["activation-nonce", "retained-authorization"].includes(mutant))
  throw Error("Unknown Library bundle mutant");

const stateDir = join(
  root,
  ".context/library-check",
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

function launch(storageDirectory = stateDir) {
  // Deliberate allowlist: no Cloudflare/API/production credentials enter host or workerd env.
  const env = {
    PATH: dirname(process.execPath) + ":/usr/bin:/bin",
    LANG: "C.UTF-8",
    CI: "1",
    NO_COLOR: "1",
    TMPDIR: stateDir,
  };

  if (mutant) env.LIBRARY_CHECK_MUTANT = mutant;

  const child = spawn(process.execPath, [join(directory, "host.mjs"), storageDirectory], {
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

async function crash() {
  assert.ok(host);
  process.kill(-host.child.pid, "SIGKILL");
  const [code, signal] = await deadline(host.closed, 10000, "owned process group crash");
  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");
  host = undefined;
}

let base;

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

const good = async (action, fields = {}, ms = 20000) => {
  const result = await api(action, fields, ms);
  assert.equal(result.ok, true, `${action}: ${result.error}`);

  return result.value;
};

const admin = (ref, tag, fields = {}) => {
  const request = { _tag: tag, operationId: "capture", ...fields };

  if (tag === "ReadPart" && !Object.hasOwn(fields, "captureId")) request.captureId = "capture";

  return good("admin", {
    ref,
    request,
  });
};

const pass = (name, evidence) => {
  results.push({ name, evidence });
  console.log("PASS " + JSON.stringify({ name, evidence }));
};

async function inventory(lineage) {
  const found = [];
  let after = 0;

  for (let page = 0; page < 32; page++) {
    const rows = await good("inventory", { lineage, after });
    found.push(...rows);

    if (rows.length < 64) return found;
    after = rows.at(-1).ordinal;
  }

  throw Error("owned inventory exceeded test bound");
}

async function capture(ref, operationId = "capture") {
  let image;

  for (let step = 0; step < 256; step++) {
    const reply = await admin(ref, "CaptureStep", { operationId });
    assert.equal(reply._tag, "Progress");

    if (reply.value.done) {
      image = reply.value.image;
      break;
    }
  }

  assert.ok(image, "bounded capture completes");
  const parts = [];

  for (let row = 1; row <= image.kvCount + image.sqlCount + 1; row++) {
    let first = await admin(ref, "ReadPart", { operationId, captureId: operationId, row, part: 0 });
    assert.equal(first._tag, "Part");
    parts.push(first.value);

    for (let part = 1; part < first.value.parts; part++) {
      const reply = await admin(ref, "ReadPart", {
        operationId,
        captureId: operationId,
        row,
        part,
      });

      assert.equal(reply._tag, "Part");
      parts.push(reply.value);
    }
  }

  return { image, parts };
}

try {
  if (caseName !== "home") {
    host = launch();
    base = (await host.event("ready", 60000)).url;
    const initial = await good("initialize");
    assert.equal(initial.epoch, 1);
    await good("finalize");
    await good("finish");
    const first = await good("propose", { id: "one", name: "One", body: "First immutable body" });
    const firstDetail = await good("detail", { skillId: first.reply.skillId, atLeast: first });
    assert.equal(firstDetail.value.body, "First immutable body");
    const legacy = await api("descriptor");
    assert.equal(legacy.ok, false);
    assert.match(legacy.error, /LibraryRecoveryError/);
    await good("workflow-create", { id: "missing-recovery-input", missing: true });
    const missing = await good("wait", { key: "backfill-failed" });
    assert.match(missing, /DomainRecoveryInputMissing/);
    pass("native Workflow using provider backfill wrapper rejects missing scope before its body", {
      missingInputDenied: true,
    });
    const queuedId = "queued-before-restore";
    await good("workflow-create", { id: queuedId });
    const creation = JSON.parse(await good("wait", { key: "workflow-created" }));
    assert.equal(creation.lineage, "library-1");
    assert.equal(creation.epoch, 1);
    const pendingKey = "owner/kitties-skill-0000000000000002";
    await good("gate", { key: pendingKey });
    const pending = await good("propose", { id: "two", name: "Two", body: "Pending body" });
    assert.equal(pending.reply.skillId, "kitties-skill-0000000000000002");

    const discovered = await good("register", {
      className: "LibraryModel.SkillDetailViewV1",
      logicalName: "owner/discovered-before-invoke",
    });

    const sourceInventory = await inventory("library-1");
    assert.ok(sourceInventory.some((ref) => ref.nativeId === discovered.nativeId));
    assert.equal(
      sourceInventory.some((ref) => ref.logicalName === pendingKey),
      false,
    );
    pass("exact layout validation; registry discovers native identity before invocation", {
      objects: sourceInventory.length,
      pendingTargetAbsent: true,
      legacyUndefinedDenied: true,
    });
    await good("freeze");
    const images = [];

    for (const ref of sourceInventory) {
      const frozen = await admin(ref, "Freeze");
      assert.equal(frozen._tag, "Status");
      const before = frozen.value.before;
      assert.ok(before);
      await good("freeze-ack", { ordinal: ref.ordinal, before });

      try {
        await admin(ref, "Evict");
      } catch {
        /* native abort intentionally breaks this response */
      }

      const verified = await admin(ref, "VerifyFrozen", { before });
      assert.equal(verified._tag, "Status");
      assert.equal(verified.value.initialized, false);
      assert.equal(verified.value.held, true);
      assert.notEqual(verified.value.nonce, before);
      await good("freeze-ack", { ordinal: ref.ordinal, before, nonce: verified.value.nonce });
      const captured = await capture(ref);
      await good("image-record", { ordinal: ref.ordinal, image: captured.image });
      images.push({ ref, ...captured });
    }

    const source = images.find((item) => item.ref.className === "LibraryModel.LibraryAggregate");
    assert.ok(source);
    const sourceStatus = await admin(source.ref, "Status");
    assert.deepEqual(
      await admin(source.ref, "ReadAllocatorFloor"),
      Reply.AllocatorFloor({ value: 2 }),
    );
    assert.equal(sourceStatus.value.outboxPending, true);
    assert.equal(sourceStatus.value.outboxWake, true);
    const immutable = await capture(source.ref);
    assert.deepEqual(immutable.image, source.image);
    assert.deepEqual(immutable.parts, source.parts);
    await good("seal");
    await good("prepare");
    const destinations = [];
    let crashProved = false;

    for (const item of images) {
      const ref = await good("register", {
        className: item.ref.className,
        lineage: "library-2",
        logicalName: item.ref.logicalName,
      });

      const status = await admin(ref, "Status");
      assert.equal(status.value.initialized, false);
      assert.equal(status.value.held, true);
      assert.equal((await admin(ref, "BeginLoad", { image: item.image }))._tag, "Acknowledged");

      if (!crashProved) {
        assert.deepEqual(
          await admin(ref, "LoadPart", {
            value: { ...item.parts[0], chars: 8192, chunk: "\u0000".repeat(8192) },
          }),
          Reply.Rejected({ reason: "invalid" }),
        );
        assert.deepEqual(
          await admin(ref, "VerifyImage", {
            image: { ...item.image, digest: "0".repeat(64) },
          }),
          Reply.Rejected({ reason: "conflict" }),
        );
        const original = item.parts[0];
        assert.deepEqual(
          await admin(ref, "LoadPart", {
            value: {
              ...original,
              chunk: (original.chunk[0] === "x" ? "y" : "x") + original.chunk.slice(1),
            },
          }),
          Reply.Rejected({ reason: "conflict" }),
        );
        assert.equal((await admin(ref, "LoadPart", { value: original }))._tag, "Acknowledged");
        await crash();
        host = launch();
        base = (await host.event("ready", 60000)).url;
        const resumed = await admin(ref, "Status");
        assert.equal(resumed.value.initialized, false);
        assert.equal(resumed.value.held, true);
        crashProved = true;
        pass("native image bounds and digest mismatch fail; a partial load resumes after SIGKILL", {
          oversizedPartDenied: true,
          wrongManifestDenied: true,
          corruptPartDenied: true,
          stagingStayedFrozen: true,
        });
      }

      for (const value of item.parts) {
        assert.equal((await admin(ref, "LoadPart", { value }))._tag, "Acknowledged");
        assert.equal((await admin(ref, "LoadPart", { value }))._tag, "Acknowledged");
      }

      let verified;

      for (let step = 0; step < 256; step++) {
        verified = await admin(ref, "VerifyImage", { image: item.image });
        assert.equal(verified._tag, "Progress");

        if (verified.value.done) break;
      }

      assert.equal(verified.value.done, true);
      assert.deepEqual(verified.value.image, item.image);
      await good("loaded", { ordinal: item.ref.ordinal, after: ref.ordinal, image: item.image });
      destinations.push({ ref, image: item.image });
    }

    writeFileSync(join(stateDir, "images.json"), JSON.stringify(images, null, 2));
    pass(
      "native freeze/eviction seals immutable complete KV, callbacks and alarm; staging clones verify",
      { objects: images.length, sourceImage: source.image },
    );
    await good("activate");
    let activationCrashProved = false;

    for (const item of destinations) {
      const active = await admin(item.ref, "Activate");
      assert.equal(active._tag, "Status");
      const before = active.value.activating;
      assert.equal(Schema.is(Schema.String)(before), true);

      try {
        await admin(item.ref, "Evict");
      } catch {
        /* native abort intentionally breaks this response */
      }

      const verified = await admin(item.ref, "VerifyActive", { before });
      assert.equal(verified._tag, "Status");
      assert.equal(verified.value.initialized, true);

      if (!activationCrashProved) {
        await crash();
        host = launch();
        base = (await host.event("ready", 60000)).url;
        const retry = await admin(item.ref, "Activate");
        assert.equal(retry._tag, "Status");
        assert.equal(retry.value.activating, before);
        assert.notEqual(retry.value.nonce, before);
        const recovered = await admin(item.ref, "VerifyActive", { before: retry.value.activating });
        assert.equal(recovered._tag, "Status");
        assert.equal(recovered.value.initialized, true);
        activationCrashProved = true;
        pass("lost activation acknowledgement survives eviction and whole host SIGKILL", {
          durableActivationNonceRetained: true,
          proofUsesFreshConstructor: true,
        });
      }

      await good("active-ack", { ordinal: item.ref.ordinal });
    }

    const target = destinations.find(
      (item) => item.ref.className === "LibraryModel.LibraryAggregate",
    ).ref;

    const stillPending = await admin(target, "Status");
    assert.equal(stillPending.value.outboxPending, true);
    assert.equal(stillPending.value.outboxWake, true);
    assert.equal(
      (await inventory("library-2")).some((ref) => ref.logicalName === pendingKey),
      false,
    );
    // Clear the fixture gate while staging membership remains frozen: real destination refusal preserves its backstop.
    await good("gate", { key: null });

    const noNewMember = await api("register", {
      className: "LibraryModel.SkillDetailViewV1",
      lineage: "library-2",
      logicalName: pendingKey,
    });

    assert.equal(noNewMember.ok, false);
    pass("activation refuses uncaptured destination without losing pending outbox or callback", {
      pendingTargetAbsent: true,
      outboxPending: true,
      outboxWake: true,
    });
    const published = await good("publish");
    assert.equal(published.epoch, 2);
    const duplicate = await good("receipt", { epoch: 2 });
    assert.deepEqual(duplicate, first);
    const state = await good("state", { epoch: 2 });
    assert.equal(state.highWater, 2);

    const delivered = await good(
      "detail",
      { epoch: 2, skillId: pending.reply.skillId, atLeast: pending },
      25000,
    );

    assert.equal(delivered.value.body, "Pending body");

    const stale = await api("propose", {
      epoch: 1,
      id: "one",
      name: "Stale",
      body: "must not execute",
    });

    assert.equal(stale.ok, false);
    assert.match(stale.error, /LibraryAdmissionDenied/);
    await good("workflow-start", { id: queuedId });
    const rejection = await good("wait", { key: "backfill-rejected" });
    assert.match(rejection, /LibraryRecoveryError/);
    pass(
      "publication delivers copied pending event; stale epoch and creation-time old backfill are fenced",
      { skillId: pending.reply.skillId, epoch: published.epoch, duplicateReply: duplicate.reply },
    );
    await stop();
    host = launch();
    base = (await host.event("ready", 60000)).url;
    const restarted = await good("state", { epoch: 2 });
    assert.deepEqual(restarted, state);
    assert.equal(
      (await good("detail", { epoch: 2, skillId: pending.reply.skillId, atLeast: pending })).value
        .body,
      "Pending body",
    );

    pass(
      "whole host restart retains authoritative lineage, receipts, detail, frozen image and allocator",
      { epoch: 2, highWater: restarted.highWater },
    );

    // A second recovery selects a retained, retired lineage rather than the outgoing checkpoint.
    const rollback = "rollback";

    const outgoing = await good("propose", {
      epoch: 2,
      id: "three",
      name: "Newer than retained set",
      body: "Outgoing authority",
    });

    assert.equal(outgoing.reply.skillId, "kitties-skill-0000000000000003");
    const restored = await good("restore", { operationId: rollback, setId: "capture" }, 130000);
    assert.equal(restored.phase, "ready");
    assert.equal(restored.epoch, 3);
    assert.equal(restored.allocatorFloor, 3);
    const rolledBack = await good("state", { epoch: 3 });
    assert.equal(rolledBack.highWater, 3);
    assert.equal(
      rolledBack.active.some((entry) => entry.id === outgoing.reply.skillId),
      false,
    );
    assert.deepEqual(await good("receipt", { epoch: 3 }), first);
    assert.equal(
      (await good("detail", { epoch: 3, skillId: first.reply.skillId, atLeast: first })).value.body,
      "First immutable body",
    );

    const next = await good("propose", {
      epoch: 3,
      id: "four",
      name: "After rollback",
      body: "Fresh ID",
    });

    assert.equal(next.reply.skillId, "kitties-skill-0000000000000004");
    assert.deepEqual(
      await good("restore", { operationId: rollback, setId: "capture" }, 130000),
      restored,
    );
    assert.equal((await good("state", { epoch: 3 })).highWater, 4);

    assert.deepEqual(
      await admin(source.ref, "CaptureStep", { operationId: rollback }),
      Reply.Rejected({ reason: "fenced" }),
    );
    assert.deepEqual(
      await admin(source.ref, "ReadPart", {
        operationId: rollback,
        captureId: "capture",
        row: 1,
        part: 0,
      }),
      Reply.Rejected({ reason: "conflict" }),
    );
    pass(
      "production coordinator restores retained retired capture and preserves outgoing allocator floor",
      {
        operationId: rollback,
        captureId: "capture",
        sourceLineage: source.ref.lineage,
        oldSourceMutationsDenied: true,
        restoredEpoch: 3,
        outgoingFloor: 3,
        freshSkillId: next.reply.skillId,
      },
    );
    const unrelated = await good("global-begin", { id: "unrelated-home" });
    assert.equal(unrelated.mode, "recovering");
    const unrelatedStatus = await good("global-status");
    assert.equal(unrelatedStatus.epoch, unrelated.epoch);
    assert.equal(unrelatedStatus.operation_id, "unrelated-home");
    assert.deepEqual(
      await good("restore", { operationId: rollback, setId: "capture" }, 130000),
      restored,
    );
    assert.deepEqual(await good("global-status"), unrelatedStatus);
    assert.equal((await api("state", { epoch: 3 })).ok, false);
    await good("global-complete", { id: "unrelated-home" });
    const complete = await good("global-status");
    assert.equal(complete.mode, "ready");
    assert.equal(complete.epoch, unrelated.epoch);
    assert.deepEqual(
      await good("restore", { operationId: rollback, setId: "capture" }, 130000),
      restored,
    );
    assert.deepEqual(await good("global-status"), complete);
    assert.equal((await good("state", { epoch: 3 })).highWater, 4);
    pass("historical publication replay leaves unrelated Home recovery fence and epoch unchanged", {
      unrelatedOperation: "unrelated-home",
      epochPreserved: true,
      activeFencePreserved: true,
    });
  }

  if (caseName !== "full") {
    await stop();
    const homeStorage = join(stateDir, "home");
    mkdirSync(homeStorage, { recursive: true });
    host = launch(homeStorage);
    base = (await host.event("ready", 60000)).url;

    const legacyAccepted = {
      id: "legacy-accepted",
      name: "Legacy accepted",
      body: "Original accepted legacy body",
      status: "accepted",
      createdAt: 10,
      updatedAt: 123,
    };

    const legacyProposed = {
      id: "kitties-skill-0000000000000009",
      name: "Legacy proposed",
      body: "Legacy proposal body",
      status: "proposed",
    };

    await good("home-write", {
      kind: "kitty",
      id: "cat",
      body: JSON.stringify({ id: "cat", name: "Cat", soul: "Helpful", createdAt: 1 }),
    });
    await good("home-write", { id: legacyAccepted.id, body: JSON.stringify(legacyAccepted) });
    await good("home-turn", { id: "legacy-turn" });
    const legacyTurn = await good("home-read", { kind: "turn-config", id: "legacy-turn" });
    assert.deepEqual(
      JSON.parse(legacyTurn).skills.map((skill) => skill.body),
      [legacyAccepted.body],
    );
    await good("home-write", { id: legacyProposed.id, body: JSON.stringify(legacyProposed) });
    await good("gate", { key: "migration" });

    const interrupted = api("home-migrate", { id: "legacy-inventory" }, 130000).then(
      (response) => ({ response }),
      (error) => ({ error: String(error) }),
    );

    const paused = JSON.parse(await good("wait", { key: "migration-paused" }));
    assert.equal(paused.importedCount, 1);
    const importingTurn = await api("home-turn", { id: "during-import" });
    assert.equal(importingTurn.ok, false);
    assert.equal(await good("home-read", { kind: "turn-config", id: "during-import" }), null);
    assert.equal(
      (
        await api("home-write", {
          id: legacyAccepted.id,
          body: JSON.stringify({ ...legacyAccepted, body: "forbidden" }),
        })
      ).ok,
      false,
    );
    await crash();
    assert.notEqual((await interrupted).response?.ok, true);
    host = launch(homeStorage);
    base = (await host.event("ready", 60000)).url;
    await good("gate", { key: null });
    const durableProgress = await good("import-state");
    assert.equal(durableProgress.importProgress.importedCount, 1);
    const resumedStatus = await good("home-status");
    assert.equal(resumedStatus.frozen, true);
    assert.equal(resumedStatus.inventory.rowCount, 2);
    assert.equal(resumedStatus.authority.phase, "importing");
    const firstImported = durableProgress.active[0];

    const observed = await good(
      "import-detail",
      {
        skillId: firstImported.id,
        revision: 1,
      },
      80000,
    );

    assert.equal(observed.value.body, legacyProposed.body);
    const migrated = await good("home-migrate", { id: "legacy-inventory" }, 130000);
    assert.equal(migrated.importedCount, 2);
    assert.equal(migrated.fallbackCount, 1);
    assert.equal(migrated.allocatorFloor, 9);
    assert.equal(migrated.alreadyReady, false);
    const ready = await good("state");
    assert.equal(ready.highWater, 9);
    assert.deepEqual(
      new Map(ready.active.map((entry) => [entry.id, entry.status])),
      new Map([
        [legacyAccepted.id, "accepted"],
        [legacyProposed.id, "proposed"],
      ]),
    );
    assert.equal(
      (await api("home-write", { id: "new-old-writer", body: JSON.stringify(legacyAccepted) })).ok,
      false,
    );
    assert.equal((await api("home-remove", { id: legacyAccepted.id })).ok, false);
    assert.equal(
      (
        await api("home-insert", {
          id: "insert-bypass",
          body: JSON.stringify({ ...legacyAccepted, id: "insert-bypass" }),
        })
      ).ok,
      false,
    );
    assert.equal(await good("home-read", { id: "insert-bypass" }), null);
    pass(
      "production Home migration resumes after committed import SIGKILL and fences legacy writers",
      { importedCount: 2, fallbackCount: 1, allocatorFloor: 9, durableInterruptedCount: 1 },
    );

    const created = await good("propose", {
      id: "new-after-import",
      name: "New accepted",
      body: "New Domain accepted body",
    });

    assert.equal(created.reply.skillId, "kitties-skill-0000000000000010");
    await good("accept", {
      id: "accept-new",
      skillId: created.reply.skillId,
      revision: created.reply.proposalRevision,
    });
    await good("home-turn", { id: "domain-turn" });
    const domainTurn = await good("home-read", { kind: "turn-config", id: "domain-turn" });
    const domainConfig = JSON.parse(domainTurn);
    assert.equal(domainConfig.library.epoch, 1);
    assert.deepEqual(
      new Set(domainConfig.skills.map((skill) => skill.id)),
      new Set([legacyAccepted.id, created.reply.skillId]),
    );
    assert.equal(
      domainConfig.skills.find((skill) => skill.id === created.reply.skillId).body,
      "New Domain accepted body",
    );
    await good("remove", {
      id: "remove-new",
      skillId: created.reply.skillId,
      revision: created.reply.proposalRevision,
    });
    await good("home-turn", { id: "domain-turn", body: "retry after removal" });
    assert.equal(await good("home-read", { kind: "turn-config", id: "domain-turn" }), domainTurn);
    await good("home-turn", { id: "after-remove" });

    const afterRemove = JSON.parse(
      await good("home-read", { kind: "turn-config", id: "after-remove" }),
    );

    assert.deepEqual(
      afterRemove.skills.map((skill) => skill.id),
      [legacyAccepted.id],
    );
    await stop();
    host = launch(homeStorage);
    base = (await host.event("ready", 60000)).url;
    await good("home-turn", { id: "domain-turn" });
    await good("home-turn", { id: "legacy-turn" });
    assert.equal(await good("home-read", { kind: "turn-config", id: "domain-turn" }), domainTurn);
    assert.equal(await good("home-read", { kind: "turn-config", id: "legacy-turn" }), legacyTurn);
    assert.equal((await good("state")).highWater, 10);
    assert.equal((await good("home-migrate", { id: "legacy-inventory" })).alreadyReady, true);
    assert.equal((await api("home-remove", { id: legacyAccepted.id })).ok, false);
    writeFileSync(
      join(stateDir, "home-proof.json"),
      JSON.stringify({ migrated, domainConfig, afterRemove }, null, 2),
    );
    pass(
      "production Home turns capture new accepted Domain bodies and reuse saved turns after removal/restart",
      {
        freshId: created.reply.skillId,
        oldTurnBytesPreserved: true,
        newTurnOmitsRemovedSkill: true,
      },
    );
  }
} catch (error) {
  failure = { error: String(error), stack: error.stack };
  process.exitCode = 1;
  console.error(error);
} finally {
  try {
    await stop();
  } catch (error) {
    failure ??= { error: String(error), stack: error.stack };
    process.exitCode = 1;
    console.error(error);
  }

  writeFileSync(
    join(stateDir, "results.json"),
    JSON.stringify({ verdict: failure ? "FAIL" : "PASS", failure, events, results }, null, 2),
  );

  if (!failure)
    console.log(`PASS ${results.length} native Library recovery cases; evidence ${stateDir}`);
}
