import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import * as Data from "effect/Data";

/** @type {Data.TaggedEnum.Constructor<import('../../../apps/gateway/src/library-capture-prune-records.ts').LibraryCapturePruneCandidate>} */
const Candidate = Data.taggedEnum();

const AGE = 30 * 86400000;

/** Real capture/archive setup; the production Activity program will own scheduled work. */
export async function seedScheduledArchive({ good, inventory }) {
  const captureId = "scheduled-pinned";
  await good("initialize");

  const proposed = await good("propose", {
    epoch: 1,
    id: "scheduled-seed",
    name: "Scheduled pruning",
    body: "Retain the live Library while scheduled cleanup removes only capture buffers",
  });

  const accepted = await good("accept", {
    epoch: 1,
    id: "scheduled-accept",
    skillId: proposed.reply.skillId,
    revision: proposed.reply.proposalRevision,
  });

  const detail = await good(
    "detail",
    { epoch: 1, skillId: proposed.reply.skillId, atLeast: accepted },
    75000,
  );

  assert.equal(detail.value.status, "accepted");
  const set = await good("capture", { operationId: captureId }, 125000);
  const members = await inventory("capture-inventory", { operationId: captureId });
  const archive = await good("archive", { operationId: captureId }, 125000);
  assert.equal(archive.phase, "committed");
  assert.equal(archive.header.set.id, captureId);

  return { captureId, proposed, accepted, set, members, archive };
}

/** Discovery and scheduling run only through the real server and production Activity service. */
export async function runScheduled({ good, inventory, pass, start, stop, setPolicyTime }) {
  await start();
  const pinned = await seedScheduledArchive({ good, inventory });
  const alias = "scheduled-pinned-alias";
  await good("archive-alias", { archiveId: alias, captureId: pinned.captureId }, 125000);
  const pin = await good("archive-pin", { archiveId: alias, restoreId: "scheduled-alias-pin" });
  assert.equal(pin.completed, false);
  const incompleteId = "scheduled-incomplete";
  await good("capture", { operationId: incompleteId }, 125000);
  await good("archive-begin", { archiveId: incompleteId, captureId: incompleteId });
  const captureId = "scheduled-selected";
  const set = await good("capture", { operationId: captureId }, 125000);
  const archive = await good("archive", { operationId: captureId }, 125000);
  const members = await inventory("capture-inventory", { operationId: captureId });
  const youngId = "scheduled-young";
  const youngSet = await good("capture", { operationId: youngId }, 125000);
  const youngArchive = await good("archive", { operationId: youngId }, 125000);
  assert.equal(archive.phase, "committed");
  assert.equal(youngArchive.phase, "committed");
  assert.ok(youngSet.capturedAt > set.capturedAt);

  const snapshot = async (selectedId) => {
    const values = [];

    for (const ref of members)
      values.push({
        nativeId: ref.nativeId,
        ...(await good("snapshot", { ref, captureId: selectedId })),
      });

    return values;
  };

  const buffers = (entries) =>
    entries.map(({ nativeId, localImages, localRows, localParts, selectedDigest }) => ({
      nativeId,
      localImages,
      localRows,
      localParts,
      selectedDigest,
    }));

  const candidates = () => good("prune-candidates", { request: { after: null } });

  const operationId = (selectedId) =>
    `prune-${createHash("sha256")
      .update(JSON.stringify(["library-capture-prune-v1", selectedId, selectedId]))
      .digest("hex")}`;

  const request = { operationId: operationId(captureId), captureId, archiveId: captureId };

  await setPolicyTime(set.capturedAt + AGE - 1);
  assert.deepEqual(await candidates(), { items: [], next: null });
  await setPolicyTime(set.capturedAt + AGE);

  assert.deepEqual(await candidates(), {
    items: [Candidate.New({ captureId, archiveId: captureId })],
    next: null,
  });

  const before = await snapshot(captureId);
  const pinnedBefore = buffers(await snapshot(pinned.captureId));
  const incompleteBefore = buffers(await snapshot(incompleteId));
  const youngBefore = buffers(await snapshot(youngId));
  const globalBefore = await good("global");
  const stateBefore = await good("state", { epoch: 1 });
  const startedAt = Date.now();
  assert.equal(await good("permit", { startedAt }), true);
  assert.equal((await good("metrics")).scheduledDiscovery, 0);
  pass(
    "actual server discovery selects one old committed archive and excludes alias-pinned, incomplete and young captures",
    {
      realCaptures: 4,
      selected: request,
      alias,
      policyTime: set.capturedAt + AGE,
      selectedAgeMs: AGE,
      youngAgeMs: set.capturedAt + AGE - youngSet.capturedAt,
    },
  );

  await good("arm", { boundary: "prune-step" });
  const executionId = await good("scheduled-start", { id: "scheduled-first" });

  const lost = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
    await good("wait", { boundary: "prune-step" }),
  );

  assert.equal(lost.pruneId, request.operationId);
  assert.equal(lost.done, true);
  assert.ok(lost.removedRows > 0);
  assert.equal(lost.receipt.authorization.request.captureId, captureId);
  assert.equal(lost.receipt.authorization.request.archiveId, captureId);
  assert.equal(
    lost.receipt.authorization.request.manifestDigest,
    archive.commit.receipt.plainSha256,
  );
  assert.equal((await good("metrics")).scheduledDiscovery, 1);
  // Clearing the persistent arm cannot release the already blocked successful reply.
  await good("arm", { boundary: null });
  await stop(true);
  await setPolicyTime(youngSet.capturedAt + AGE);

  assert.deepEqual(await candidates(), {
    items: [Candidate.Resume(request), Candidate.New({ captureId: youngId, archiveId: youngId })],
    next: null,
  });

  assert.equal(await good("scheduled-start", { id: "scheduled-first" }), executionId);
  await good("scheduled-resume", { id: executionId });
  const result = await good("scheduled-result", { id: executionId }, 125000);
  assert.deepEqual(result, {
    pages: 1,
    completed: 1,
    deferred: 0,
    blockedExpired: 0,
    refusals: [],
  });
  const plan = await good("prune-plan", { pruneId: request.operationId });
  assert.equal(plan.phase, "complete");
  assert.equal((await good("prune-status", { pruneId: request.operationId })).phase, "complete");

  const receipts = await good("prune-replies", {
    pruneId: request.operationId,
    nativeId: lost.nativeId,
  });

  assert.ok(receipts.count >= 2);
  assert.deepEqual(receipts.first, lost.receipt);
  assert.deepEqual(receipts.last, lost.receipt);
  assert.equal((await good("metrics")).scheduledDiscovery, 1);
  const after = await snapshot(captureId);

  for (const [index, entry] of after.entries()) {
    assert.equal(entry.localImages, 0);
    assert.equal(entry.localRows, 0);
    assert.equal(entry.localParts, 0);
    assert.equal(entry.otherCaptureDigest, before[index].otherCaptureDigest);
  }

  assert.deepEqual(buffers(await snapshot(youngId)), youngBefore);
  assert.deepEqual(buffers(await snapshot(pinned.captureId)), pinnedBefore);
  assert.deepEqual(buffers(await snapshot(incompleteId)), incompleteBefore);
  assert.deepEqual(await good("state", { epoch: 1 }), stateBefore);
  assert.deepEqual(await good("global"), globalBefore);
  assert.equal(await good("permit", { startedAt }), true);

  const metrics = await good("metrics");
  assert.equal(await good("scheduled-start", { id: "scheduled-first" }), executionId);
  assert.deepEqual(await good("scheduled-result", { id: executionId }, 125000), result);
  assert.deepEqual(await good("metrics"), metrics);
  assert.deepEqual(await good("prune-plan", { pruneId: request.operationId }), plan);
  pass(
    "native scheduled Workflow replays its journaled selection and original prune receipt after post-success ACK loss",
    {
      executionId,
      request,
      result,
      originalReceiptObserved: receipts.count,
      discoveryCallsIncludingReplay: metrics.scheduledDiscovery,
      youngCaptureBecameEligibleDuringRestartButStayedUnselected: true,
      selectedBuffersBefore: buffers(before),
    },
  );

  assert.deepEqual(await candidates(), {
    items: [Candidate.New({ captureId: youngId, archiveId: youngId })],
    next: null,
  });
  const nextExecution = await good("scheduled-start", { id: "scheduled-second" });
  const nextResult = await good("scheduled-result", { id: nextExecution }, 125000);
  assert.deepEqual(nextResult, {
    pages: 1,
    completed: 1,
    deferred: 0,
    blockedExpired: 0,
    refusals: [],
  });
  assert.equal((await good("metrics")).scheduledDiscovery, 2);
  const nextPlan = await good("prune-plan", { pruneId: operationId(youngId) });
  assert.equal(nextPlan.phase, "complete");

  for (const entry of await snapshot(youngId)) {
    assert.equal(entry.localImages, 0);
    assert.equal(entry.localRows, 0);
    assert.equal(entry.localParts, 0);
  }

  assert.deepEqual(await good("prune-plan", { pruneId: request.operationId }), plan);
  assert.deepEqual(buffers(await snapshot(pinned.captureId)), pinnedBefore);
  assert.deepEqual(buffers(await snapshot(incompleteId)), incompleteBefore);
  assert.deepEqual(await good("state", { epoch: 1 }), stateBefore);
  assert.deepEqual(await good("global"), globalBefore);
  assert.equal(await good("permit", { startedAt }), true);
  assert.deepEqual(await candidates(), { items: [], next: null });
  const emptyExecution = await good("scheduled-start", { id: "scheduled-empty" });
  const empty = await good("scheduled-result", { id: emptyExecution }, 125000);
  assert.deepEqual(empty, { pages: 1, completed: 0, deferred: 0, blockedExpired: 0, refusals: [] });
  assert.equal((await good("metrics")).scheduledDiscovery, 3);

  let protectedPruneSteps = 0;

  for (const ref of members) {
    const observations = await good("step-observations", { nativeId: ref.nativeId });
    assert.ok(observations.length >= 2);

    for (const observation of observations) {
      assert.equal(observation.after.digest, observation.before.digest);
      assert.equal(observation.after.alarm, observation.before.alarm);
      protectedPruneSteps += 1;
    }
  }

  assert.deepEqual(
    await good("raw-receipt", { epoch: 1, commandEpoch: 1, id: "scheduled-seed" }),
    pinned.proposed,
  );
  pass(
    "new scheduled invocations discover later eligibility and exclude completed captures without touching pinned or incomplete buffers",
    {
      laterRequest: nextPlan.request,
      laterResult: nextResult,
      emptyResult: empty,
      protectedPruneSteps,
      liveStateRawReceiptAndGlobalPermissionPreserved: true,
      protectedSnapshotScope:
        "immediately around original admin Effect within one RPC, outside semaphore and transaction",
    },
  );
  await stop();
}
