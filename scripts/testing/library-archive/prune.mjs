import assert from "node:assert/strict";
import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import * as Match from "effect/Match";

/** @type {Data.TaggedEnum.Constructor<import('../../../apps/gateway/src/library-object-admin.ts').LibraryAdminRequest>} */
const Admin = Data.taggedEnum();
const AGE = 30 * 86400000;
const captureId = "prune-capture";
const pruneId = "prune-operation";

/** Fresh local R2 namespaces isolate irreversible negative cases from the successful prune. */
export async function runPrune({
  api,
  good,
  inventory,
  pass,
  start,
  stop,
  isolate,
  setPolicyTime,
}) {
  const callbackCompletions = [];

  const sameBuffers = (actual, expected) => {
    const buffers = (entries) =>
      entries.map((entry) => ({
        nativeId: entry.nativeId,
        localImages: entry.localImages,
        localRows: entry.localRows,
        localParts: entry.localParts,
        selectedDigest: entry.selectedDigest,
        otherCaptureDigest: entry.otherCaptureDigest,
      }));

    assert.deepEqual(buffers(actual), buffers(expected));

    for (const [index, current] of actual.entries()) {
      const previous = expected[index];

      if (
        previous.callbacks > current.callbacks &&
        previous.alarm !== null &&
        current.alarm === null
      )
        callbackCompletions.push({
          nativeId: current.nativeId,
          callbacksBefore: previous.callbacks,
          callbacksAfter: current.callbacks,
        });
    }
  };

  const protectedSteps = async (members, kind) => {
    let steps = 0;

    for (const ref of members) {
      const observations = (await good("step-observations", { nativeId: ref.nativeId })).filter(
        (entry) => entry.kind === kind,
      );

      assert.ok(observations.length > 0);

      for (const observation of observations) {
        assert.equal(
          observation.after.digest,
          observation.before.digest,
          `native KV/scheduler/guard changed during ${kind}: ${ref.nativeId}`,
        );
        assert.equal(observation.after.alarm, observation.before.alarm);
        steps += 1;
      }
    }

    return steps;
  };

  const snapshots = async (members) => {
    const values = [];

    for (const ref of members) {
      const value = await good("snapshot", { ref, captureId });
      assert.match(value.protectedDigest, /^[a-f0-9]{64}$/);
      assert.match(value.otherCaptureDigest, /^[a-f0-9]{64}$/);
      assert.match(value.selectedDigest, /^[a-f0-9]{64}$/);
      values.push({ nativeId: ref.nativeId, ...value });
    }

    return values;
  };

  const requestFor = (status) => ({
    pruneId,
    archiveId: captureId,
    captureId,
    codeDigest: "a".repeat(64),
    manifestDigest: status.commit.receipt.plainSha256,
  });

  const pruneRequest = { operationId: pruneId, archiveId: captureId, captureId };

  const seed = async (name, complete = true) => {
    await isolate(name);
    await good("initialize");

    const first = await good("propose", {
      epoch: 1,
      id: "seed",
      name: "Prune seed",
      body: "Retained after guarded cleanup",
    });

    const accepted = await good("accept", {
      epoch: 1,
      id: "accept-seed",
      skillId: first.reply.skillId,
      revision: first.reply.proposalRevision,
    });

    assert.equal(
      (
        await good(
          "detail",
          {
            epoch: 1,
            skillId: first.reply.skillId,
            atLeast: accepted,
          },
          75000,
        )
      ).value.status,
      "accepted",
    );
    const set = await good("capture", { operationId: captureId }, 125000);
    const members = await inventory("capture-inventory", { operationId: captureId });

    const status = complete
      ? await good("archive", { operationId: captureId }, 125000)
      : await good("archive-begin", { archiveId: captureId, captureId });

    if (complete) {
      assert.equal(status.phase, "committed");
      assert.equal(status.expiresAt, status.oldestUploadedAt + 90 * 86400000);
    }

    return { first, accepted, set, members, status };
  };

  const nativeRefusedBeforeFreeze = async (suffix) => {
    const library = await good("status");
    const global = await good("global");

    const refused = await api("native-restore", {
      operationId: `blocked-native-${suffix}`,
      captureId,
    });

    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "fenced");
    assert.deepEqual(await good("status"), library);
    assert.deepEqual(await good("global"), global);
  };

  {
    const fixture = await seed("incomplete", false);
    await setPolicyTime(fixture.set.capturedAt + AGE);
    const before = await snapshots(fixture.members);

    const failed = await api("prune-verify", {
      request: {
        pruneId,
        archiveId: captureId,
        captureId,
        codeDigest: "a".repeat(64),
        manifestDigest: "0".repeat(64),
      },
    });

    assert.equal(failed.ok, false);
    assert.equal(failed.reason, "incomplete");
    assert.equal(await good("prune-plan", { pruneId }), null);
    sameBuffers(await snapshots(fixture.members), before);
    pass("incomplete retained upload cannot reserve or delete native capture buffers", {
      objects: before.length,
    });
  }

  {
    const fixture = await seed("alias-pin");
    const alias = "same-capture-alias";
    await good("archive-alias", { archiveId: alias, captureId }, 125000);
    const pin = await good("archive-pin", { archiveId: alias, restoreId: "held-alias-restore" });
    assert.equal(pin.completed, false);
    await setPolicyTime(fixture.set.capturedAt + AGE);
    const before = await snapshots(fixture.members);
    const failed = await api("prune-verify", { request: requestFor(fixture.status) });
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, "conflict");
    assert.equal(await good("prune-plan", { pruneId }), null);
    sameBuffers(await snapshots(fixture.members), before);
    pass("active restore pin on another archive alias blocks capture-wide reservation", {
      alias,
      pin,
    });
  }

  for (const fault of [
    { name: "missing-manifest", mode: "missing", kind: "Manifest" },
    { name: "corrupt-manifest", mode: "corrupt", kind: "Manifest" },
    { name: "corrupt-page", mode: "corrupt", kind: "Page" },
    { name: "corrupt-part", mode: "corrupt", kind: "Part" },
  ]) {
    const fixture = await seed(fault.name);

    const suffix = Match.value(fault.kind).pipe(
      Match.when("Manifest", () => "manifest.json"),
      Match.when("Page", () => "metadata/0.json"),
      Match.orElse(() => `parts/${fixture.members[0].ordinal}/1/0.json`),
    );

    const key = `exports/library-v1/${captureId}/${suffix}`;
    await good("archive-fault", { archiveId: captureId, key, mode: fault.mode });
    await setPolicyTime(fixture.set.capturedAt + AGE);
    const before = await snapshots(fixture.members);
    const request = requestFor(fixture.status);
    const failure = await api("prune-verify", { request });
    assert.equal(failure.ok, false);
    assert.equal(failure.reason, fault.mode === "missing" ? "incomplete" : "conflict");
    const progress = await good("prune-status", { pruneId });
    assert.equal(progress.phase, "verifying");
    assert.equal(progress.cursor._tag, fault.kind);
    assert.equal(progress.expiresAt, fixture.status.expiresAt);
    assert.equal((await good("prune-plan", { pruneId })).phase, "reserved");
    await nativeRefusedBeforeFreeze(fault.name);
    sameBuffers(await snapshots(fixture.members), before);
    await stop();
    await start();
    assert.deepEqual(await good("prune-status", { pruneId }), progress);
    const repeated = await api("prune-verify", { request });
    assert.equal(repeated.ok, false);
    assert.equal(repeated.reason, failure.reason);
    assert.deepEqual(await good("prune-status", { pruneId }), progress);
    sameBuffers(await snapshots(fixture.members), before);
    pass(
      `${fault.name} keeps a durable reservation and failed-item cursor without deleting local data`,
      {
        sequence: progress.sequence,
        cursor: progress.cursor,
        objects: before.length,
        originalExpiresAt: progress.expiresAt,
      },
    );
  }

  const fixture = await seed("positive");

  const later = await good("propose", {
    epoch: 1,
    id: "later",
    name: "Later",
    body: "Live state must survive capture pruning",
  });

  await good("detail", { epoch: 1, skillId: later.reply.skillId, atLeast: later }, 75000);
  await good("capture", { operationId: "untouched-capture" }, 125000);
  const protectedMembers = await inventory("inventory", { lineage: "library-1" });
  const live = await good("state", { epoch: 1 });
  await setPolicyTime(fixture.set.capturedAt + AGE - 1);
  const request = requestFor(fixture.status);
  const young = await api("prune-verify", { request });
  assert.equal(young.ok, false);
  assert.equal(young.reason, "conflict");
  assert.equal(await good("prune-plan", { pruneId }), null);
  await setPolicyTime(fixture.set.capturedAt + AGE);
  const globalBefore = await good("global");
  const startedAt = Date.now();
  assert.equal(await good("permit", { startedAt }), true);
  const before = await snapshots(protectedMembers);
  assert.ok(
    before
      .filter((entry) => fixture.members.some((ref) => ref.nativeId === entry.nativeId))
      .every((entry) => entry.localImages === 1 && entry.localRows > 0 && entry.localParts >= 0),
  );
  let verification;
  const batches = [];

  for (let call = 0; call < 128; call++) {
    const metrics = await good("metrics");
    verification = await good("prune-verify", { request });
    const reads = (await good("metrics")).remoteGet - metrics.remoteGet;
    assert.ok(reads > 0 && reads <= 8);
    batches.push(reads);
    assert.equal(verification.expiresAt, fixture.status.expiresAt);

    if (call === 0) {
      assert.equal(
        verification.phase,
        "verifying",
        "fixture exceeds a single bounded verification batch",
      );
      await nativeRefusedBeforeFreeze("reserved");

      const early = await good("admin", {
        ref: fixture.members[0],
        request: Admin.PruneCaptureStep({ pruneId, captureId }),
      });

      assert.equal(early._tag, "Rejected");
      sameBuffers(await snapshots(protectedMembers), before);
    }

    if (verification.phase === "verified") break;
  }

  assert.equal(verification.phase, "verified");
  assert.equal(verification.reservedAt, fixture.set.capturedAt + AGE);
  assert.equal(
    batches.reduce((sum, reads) => sum + reads, 0),
    verification.sequence,
  );
  await good("arm", { boundary: "prune-step" });

  const inFlight = api("prune", pruneRequest, 125000).then(
    (reply) => ({ reply }),
    () => ({ connectionLost: true }),
  );

  const lost = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
    await good("wait", { boundary: "prune-step" }),
  );

  assert.equal(lost.pruneId, pruneId);
  assert.equal(lost.done, true);
  assert.ok(lost.removedRows > 0);
  await stop(true);
  await inFlight;
  await start();
  await good("arm", { boundary: null });
  const plan = await good("prune", pruneRequest, 125000);
  assert.equal(plan.phase, "complete");
  assert.equal((await good("prune-status", { pruneId })).phase, "complete");
  const replies = await good("prune-replies", { pruneId, nativeId: lost.nativeId });
  assert.ok(replies.count >= 2);
  assert.deepEqual(replies.first, lost.receipt);
  assert.deepEqual(replies.last, lost.receipt);
  const after = await snapshots(protectedMembers);

  for (const [index, selected] of after.entries()) {
    assert.equal(selected.localImages, 0);
    assert.equal(selected.localRows, 0);
    assert.equal(selected.localParts, 0);
    assert.equal(selected.otherCaptureDigest, before[index].otherCaptureDigest);

    if (before[index].localImages > 0)
      assert.notEqual(selected.selectedDigest, before[index].selectedDigest);
    else assert.equal(selected.selectedDigest, before[index].selectedDigest);
  }

  assert.deepEqual(await good("state", { epoch: 1 }), live);
  const protectedPruneSteps = await protectedSteps(fixture.members, "prune");
  assert.deepEqual(
    await good("raw-receipt", { epoch: 1, commandEpoch: 1, id: "seed" }),
    fixture.first,
  );
  assert.deepEqual(await good("global"), globalBefore);
  assert.equal(await good("permit", { startedAt }), true);
  assert.deepEqual(await good("prune", pruneRequest, 125000), plan);
  assert.deepEqual(await good("archive", { operationId: captureId }, 125000), fixture.status);
  const changedExport = await api("archive-mismatch", { operationId: captureId });
  assert.equal(changedExport.ok, false);
  assert.equal(changedExport.reason, "conflict");
  assert.deepEqual(await good("state", { epoch: 1 }), live);
  await nativeRefusedBeforeFreeze("completed");

  const restored = await good(
    "retained-restore",
    {
      operationId: "post-prune-restore",
      archiveId: captureId,
    },
    125000,
  );

  assert.equal(restored.phase, "ready");
  assert.equal(restored.epoch, 2);
  assert.deepEqual(
    await good("raw-receipt", { epoch: 2, commandEpoch: 1, id: "seed" }),
    fixture.first,
  );
  assert.equal(
    (
      await good(
        "detail",
        {
          epoch: 2,
          skillId: fixture.first.reply.skillId,
          atLeast: fixture.accepted,
        },
        75000,
      )
    ).value.body,
    "Retained after guarded cleanup",
  );
  pass(
    "production guarded prune survives lost step acknowledgement and retained restore after exact cleanup",
    {
      objects: before.length,
      verifiedReadsPerCall: batches,
      originalExpiresAt: plan.expiresAt,
      eligibilityAt: plan.reservedAt,
      lostReceiptReplayed: replies.count,
      protectedPruneSteps,
      selectedBuffersBefore: before
        .filter((entry) => fixture.members.some((ref) => ref.nativeId === entry.nativeId))
        .map(({ nativeId, localImages, localRows, localParts }) => ({
          nativeId,
          localImages,
          localRows,
          localParts,
        })),
      liveStateReceiptsAndOtherCapturesUnchanged: true,
      protectedSnapshotsUnchangedAroundAdminEffect: true,
      restoredEpoch: restored.epoch,
    },
  );

  const expired = await seed("expired-partial");
  await setPolicyTime(expired.set.capturedAt + AGE);
  const expiredRequest = requestFor(expired.status);
  let expiredVerification;

  for (let call = 0; call < 128; call++) {
    expiredVerification = await good("prune-verify", { request: expiredRequest });

    if (expiredVerification.phase === "verified") break;
  }

  assert.equal(expiredVerification.phase, "verified");
  const expiryGlobal = await good("global");
  const expiryStartedAt = Date.now();
  assert.equal(await good("permit", { startedAt: expiryStartedAt }), true);
  await good("arm", { boundary: "prune-step" });

  const partial = api("prune", pruneRequest, 125000).then(
    (reply) => ({ reply }),
    () => ({ connectionLost: true }),
  );

  const partialStep = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
    await good("wait", { boundary: "prune-step" }),
  );

  assert.ok(partialStep.removedRows > 0);
  await stop(true);
  await partial;
  await start();
  await good("arm", { boundary: null });
  const remaining = await snapshots(expired.members);
  assert.ok(remaining.some((entry) => entry.localImages === 0));
  assert.ok(remaining.some((entry) => entry.localImages > 0));
  await setPolicyTime(expired.status.expiresAt);
  const tooLate = await api("prune", pruneRequest, 125000);
  assert.equal(tooLate.ok, false);
  assert.equal(tooLate.reason, "expired");
  sameBuffers(await snapshots(expired.members), remaining);
  await good("arm", { boundary: "prune-stop" });

  const stopping = api("prune-abandon", pruneRequest, 125000).then(
    (reply) => ({ reply }),
    () => ({ connectionLost: true }),
  );

  const stopMilestone = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
    await good("wait", { boundary: "prune-stop" }),
  );

  assert.equal(stopMilestone.pruneId, pruneId);
  const stopPlan = await good("prune-plan", { pruneId });
  assert.equal(stopPlan.phase, "stopping");
  assert.equal(stopPlan.stoppingAt, stopMilestone.authorization.stoppingAt);
  await stop(true);
  await stopping;
  await start();
  await good("arm", { boundary: null });
  assert.deepEqual(await good("prune-plan", { pruneId }), stopPlan);
  const abandoned = await good("prune-abandon", pruneRequest, 125000);
  assert.equal(abandoned.phase, "abandoned");
  assert.equal((await good("prune-status", { pruneId })).phase, "abandoned");
  assert.equal(abandoned.stoppingAt, stopPlan.stoppingAt);
  const protectedStopSteps = await protectedSteps(expired.members, "stop");
  sameBuffers(await snapshots(expired.members), remaining);

  for (const ref of expired.members) {
    const refused = await good("admin", {
      ref,
      request: Admin.PruneCaptureStep({ pruneId, captureId }),
    });

    assert.equal(refused._tag, "Rejected");
  }

  await nativeRefusedBeforeFreeze("abandoned");
  const exportRefusal = await api("grant-export", { captureId, grantId: "after-abandon-export" });
  assert.equal(exportRefusal.ok, false);
  const realBefore = Date.now();
  const freshCapture = await good("capture", { operationId: "after-abandon-capture" }, 125000);
  assert.ok(
    freshCapture.capturedAt >= realBefore && freshCapture.capturedAt <= Date.now(),
    "named prune clock must not replace the native capture timestamp clock",
  );
  assert.equal(freshCapture.sourceLineage, "library-1");
  const afterFreshCapture = await snapshots(expired.members);
  assert.deepEqual(
    afterFreshCapture.map((entry) => entry.selectedDigest),
    remaining.map((entry) => entry.selectedDigest),
  );
  assert.deepEqual(await good("global"), expiryGlobal);
  assert.equal(await good("permit", { startedAt: expiryStartedAt }), true);
  assert.deepEqual(await good("prune-abandon", pruneRequest, 125000), abandoned);
  pass(
    "expired partial prune abandons through fresh stop acknowledgements without deleting remaining buffers",
    {
      objects: expired.members.length,
      stoppingAt: abandoned.stoppingAt,
      remainingObjects: remaining.filter((entry) => entry.localImages > 0).length,
      oldNativeAndExportPermanentlyRefused: true,
      freshCapture: freshCapture.id,
      workflowEpoch: expiryGlobal.epoch,
      protectedStopSteps,
      observedNativeCallbackCompletions: callbackCompletions,
    },
  );
  await stop();
}
