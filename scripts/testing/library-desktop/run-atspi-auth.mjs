// Explicit local issuer + real packaged UI. No callback injection or JS evaluation.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import * as Schema from "effect/Schema";

const binary = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const helper = process.env.KITTIES_ACCESSIBILITY_HELPER;
const cases = [];
const observations = [];

const Event = Schema.Struct({
  event: Schema.String,
  at: Schema.Int,
  tag: Schema.optional(Schema.String),
  requestId: Schema.optional(Schema.Union([Schema.String, Schema.Int])),
  commandId: Schema.optional(Schema.String),
  inputSha256: Schema.optional(Schema.String),
  stream: Schema.optional(Schema.String),
  version: Schema.optional(Schema.Int),
  reply: Schema.optional(Schema.Json),
  expiresAt: Schema.optional(Schema.Int),
  error: Schema.optional(Schema.String),
});

let app;
let closed;
let failure = null;
let appLog = "";
let browserAttempt = 0;

const os = (...args) =>
  execFileSync(helper, args, { encoding: "utf8", timeout: 12000, maxBuffer: 1024 * 1024 });

const until = async (observe, label) => {
  const end = Date.now() + 25000;

  while (Date.now() < end) {
    const value = await observe();

    if (value !== undefined) return value;
    await new Promise((resume) => setTimeout(resume, 100));
  }

  throw Error(`Milestone not reached: ${label}`);
};

const fixtureRequest = (path, input) =>
  new Promise((resolveReply, reject) => {
    const headers = {};

    if (input !== undefined) headers["content-type"] = "application/json";

    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: 9444,
        path,
        method: input === undefined ? "GET" : "POST",
        headers,
      },
      (response) => {
        let text = "";

        response.on("data", (chunk) => {
          text += chunk;

          if (text.length > 1024 * 1024) request.destroy(Error("Fixture response exceeds bound"));
        });
        response.on("error", reject);
        response.on("end", () => resolveReply({ status: response.statusCode, text }));
      },
    );

    request.setTimeout(15000, () => request.destroy(Error("Fixture request deadline")));
    request.on("error", reject);
    request.end(input === undefined ? undefined : JSON.stringify(input));
  });

const control = async (input) => {
  const response = await fixtureRequest("/control", input);
  assert.equal(response.status, 200, "explicit local fixture control must succeed");

  return Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json })),
  )(response.text).value;
};

const evidence = async () => {
  const response = await fixtureRequest("/evidence");

  assert.equal(response.status, 200);

  return Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        counters: Schema.Record(Schema.String, Schema.Int),
        totalIssued: Schema.Int,
        events: Schema.Array(Event),
      }),
    ),
  )(response.text);
};

const treeAt = async (phase, ready, screenshot = true) => {
  const tree = await until(() => {
    const value = os("tree");

    return ready(value) ? value : undefined;
  }, phase);

  writeFileSync(join(output, `${phase}.txt`), tree);

  if (screenshot)
    await until(
      () => (Number(os("shot", join(output, `${phase}.png`))) > 64 ? true : undefined),
      `${phase}: painted controls`,
    );

  return tree;
};

const enabled = (tree, name) =>
  tree.split(`[push button] ${name}\n`)[1]?.trimStart().startsWith("ENABLED") === true;

const open = () => {
  app = spawn(binary, [], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  app.stdout.on("data", (chunk) => {
    appLog += chunk;
  });
  app.stderr.on("data", (chunk) => {
    appLog += chunk;
  });
  closed = new Promise((resolveClose, rejectClose) => {
    app.once("close", (code, signal) => resolveClose({ code, signal }));
    app.once("error", rejectClose);
  });
};

const close = async () => {
  if (app === undefined) return;

  const stopping = app;
  let timer;

  let problem =
    stopping.exitCode === null && stopping.signalCode === null
      ? undefined
      : Error("Packaged application exited unexpectedly");

  stopping.kill("SIGTERM");

  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("Packaged application stop deadline")), 5000);
      }),
    ]);
  } catch (cause) {
    problem ??= cause;
  } finally {
    clearTimeout(timer);
  }

  try {
    process.kill(-stopping.pid, "SIGKILL");
  } catch (cause) {
    if (Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }))(cause).code !== "ESRCH")
      problem ??= cause;
  }

  app = undefined;

  if (problem !== undefined) throw problem;
};

const browserDecision = async (allow, alreadyRequested = false) => {
  browserAttempt++;

  if (!alreadyRequested) os("action", "push button", "Sign in");
  await treeAt(
    `browser-${browserAttempt}-${allow ? "allow" : "deny"}`,
    (tree) => tree.includes("[push button] Authorize Kitties Desktop"),
    false,
  );
  os("action", "push button", allow ? "Authorize Kitties Desktop" : "Deny sign-in");
  await treeAt(
    `callback-${browserAttempt}-${allow ? "allowed" : "denied"}`,
    (tree) => tree.includes(allow ? "Sign-in received." : "Sign-in refused."),
    false,
  );
  // The browser that followed the callback still owns focus. Close its actual
  // window before screenshots, so callback query/code is never recorded visually.
  os("key", "ctrl+w");
};

const fill = (name, value) => {
  const field = os("tree")
    .split("\n")
    .map((line) => /^\s*\[(entry|text|embedded)\] (.*)$/.exec(line))
    .find((match) => match?.[2] === name);

  assert(field, `Actual accessible input ${name} must exist`);
  os("focus", field[1], name);
  os("key", "ctrl+a");
  os("type", value);
};

const fieldValue = (tree, name) => {
  const lines = tree.split("\n");

  const index = lines.findIndex((line) => {
    const match = /^\s*\[(entry|text|embedded)\] (.*)$/.exec(line);

    return match?.[2] === name;
  });

  assert(index >= 0, `Actual accessible field ${name} must exist`);

  return lines[index + 1]
    ?.trimStart()
    .replace(/^TEXT ?/, "")
    .trimEnd();
};

const draftValue = (tree) => ({
  name: fieldValue(tree, "Name"),
  body: fieldValue(tree, "Instructions"),
});

const eventAt = (event, predicate) =>
  until(
    async () =>
      (await evidence()).events.find((value) => value.event === event && predicate(value)),
    event,
  );

const receiptValue = (event) => ({
  stream: event.stream,
  version: event.version,
  reply: event.reply,
});

const LibrarySnapshot = Schema.Struct({
  active: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, status: Schema.String }),
  ),
  highWater: Schema.Int,
  catalogueRevision: Schema.Int,
});

const successfulValue = (frames) =>
  Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({
        _tag: Schema.Literal("Exit"),
        requestId: Schema.String,
        exit: Schema.Struct({ _tag: Schema.Literal("Success"), value: Schema.Json }),
      }),
    ),
  )(frames)[0].exit.value;

try {
  const status = await control({ action: "status" });
  assert.equal(Schema.decodeUnknownSync(Schema.Struct({ epoch: Schema.Int }))(status).epoch, 1);
  const baseline = await evidence();
  assert.equal(baseline.totalIssued, 0, "fixture must be fresh before actual browser proof");
  open();
  const initial = await treeAt("initial", (tree) => enabled(tree, "Sign in"));
  assert.equal(initial.includes("[push button] Propose skill"), false);
  await browserDecision(false);
  const denied = await treeAt("denied", (tree) => enabled(tree, "Sign in"));
  assert(denied.includes("[combo box] Language"));
  assert.equal((await evidence()).totalIssued, 0);
  cases.push("actual external private MiniBrowser denial returns through native one-use callback");
  await browserDecision(true);
  await treeAt("authenticated", (tree) => enabled(tree, "Propose skill"));
  assert.equal((await evidence()).totalIssued, 1);
  cases.push(
    "actual external browser S256 OAuth/native trust/handshake enables real shared Library",
  );

  fill("Name", "Packaged native skill");
  fill("Instructions", "Use the confirmed packaged instructions.");
  os("action", "push button", "Propose skill");
  await treeAt("proposed", (tree) => tree.includes("[push button] Review · Packaged native skill"));
  os("action", "push button", "Review · Packaged native skill");
  const detail = await treeAt("detail", (tree) => enabled(tree, "Accept"));
  assert(detail.includes("Use the confirmed packaged instructions."));
  os("action", "push button", "Accept");
  await treeAt("accepted", (tree) => tree.includes("TEXT Accepted"));
  const accepted = successfulValue(await control({ action: "inspect" }));
  assert(JSON.stringify(accepted).includes('"status":"accepted"'));
  observations.push({ phase: "accepted", library: accepted });
  cases.push("packaged shared propose/review/accept confirms actual persistent Domain state");

  const peer = successfulValue(
    await control({
      action: "rpc",
      tag: "ProposeSkill",
      payload: {
        target: "owner",
        input: {
          name: "Second client live skill",
          body: "Confirmed independent native watch body.",
        },
        commandId: "library:1:packaged-peer:0",
      },
    }),
  );

  observations.push({ phase: "peer", receipt: peer });
  await treeAt("live-peer", (tree) => tree.includes("Review · Second client live skill"));
  cases.push("existing packaged catalogue watch observes an independent real Domain command");

  os("action", "push button", "Review · Second client live skill");
  const peerDetail = await treeAt("peer-detail", (tree) => enabled(tree, "Accept"));
  assert(peerDetail.includes("Confirmed independent native watch body."));

  const peerReceipt = Schema.decodeUnknownSync(
    Schema.Struct({
      reply: Schema.Struct({ skillId: Schema.String, proposalRevision: Schema.Int }),
    }),
  )(peer);

  const peerAccepted = successfulValue(
    await control({
      action: "rpc",
      tag: "AcceptSkill",
      payload: {
        target: "owner",
        input: {
          skillId: peerReceipt.reply.skillId,
          expectedProposalRevision: peerReceipt.reply.proposalRevision,
        },
        commandId: "library:1:packaged-peer:1",
      },
    }),
  );

  observations.push({ phase: "peer-accepted", receipt: peerAccepted });

  const updatedPeerDetail = await treeAt(
    "peer-detail-live",
    (tree) => tree.includes("TEXT Accepted") && !tree.includes("[push button] Accept\n"),
  );

  assert(updatedPeerDetail.includes("Confirmed independent native watch body."));
  cases.push(
    "existing packaged keyed detail watch confirms remote accept and preserves immutable body",
  );
  os("action", "push button", "Review · Packaged native skill");
  await treeAt(
    "own-detail-again",
    (tree) =>
      enabled(tree, "Remove") && tree.includes("TEXT Use the confirmed packaged instructions."),
  );
  os("action", "push button", "Remove");
  await treeAt(
    "removed",
    (tree) =>
      !tree.includes("[push button] Review · Packaged native skill") &&
      tree.includes("TEXT Removed"),
  );
  const removed = successfulValue(await control({ action: "inspect" }));
  assert.equal(JSON.stringify(removed).includes('"name":"Packaged native skill"'), false);
  observations.push({ phase: "removed", library: removed });
  cases.push("packaged remove confirms actual Domain removal without optimistic success");

  const originalDraft = {
    name: "Packaged commit without reply",
    body: "Original pending command instructions.",
  };

  const editedDraft = {
    name: "Next untouched draft",
    body: "Retain this edited draft after retry.",
  };

  const beforeLoss = Schema.decodeUnknownSync(LibrarySnapshot)(
    successfulValue(await control({ action: "inspect" })),
  );

  assert.equal(beforeLoss.highWater, 2);
  assert.equal(beforeLoss.catalogueRevision, 6);
  fill("Name", originalDraft.name);
  fill("Instructions", originalDraft.body);
  await control({ action: "dropNextCommandReply", tag: "ProposeSkill", armMs: 15000 });
  os("action", "push button", "Propose skill");

  const dropped = await eventAt("reply-dropped", (event) => event.tag === "ProposeSkill");

  const originalCommand = await eventAt(
    "domain-command",
    (event) => event.commandId === dropped.commandId,
  );

  const originalReceipt = await eventAt(
    "domain-receipt",
    (event) => event.commandId === dropped.commandId,
  );

  const originalDigest = createHash("sha256")
    .update(JSON.stringify(originalDraft))
    .digest("base64url");

  assert.equal(originalCommand.inputSha256, originalDigest);
  assert.equal(dropped.inputSha256, originalDigest);
  assert.equal(originalReceipt.version, 7);
  assert.equal(originalReceipt.stream, "Library/owner");
  assert.deepEqual(originalReceipt.reply, {
    skillId: "kitties-skill-0000000000000003",
    proposalRevision: 7,
  });

  const unknown = await treeAt("unknown-after-commit", (tree) =>
    enabled(tree, "Retry same request"),
  );

  assert(unknown.includes("The result is unknown. Retry the same request"));
  assert.equal(enabled(unknown, "Propose skill"), false);
  assert.deepEqual(draftValue(unknown), originalDraft);

  const committed = Schema.decodeUnknownSync(LibrarySnapshot)(
    successfulValue(await control({ action: "inspect" })),
  );

  assert.equal(committed.highWater, 3);
  assert.equal(committed.catalogueRevision, 7);
  assert.equal(committed.active.filter((skill) => skill.name === originalDraft.name).length, 1);
  fill("Name", editedDraft.name);
  fill("Instructions", editedDraft.body);
  os("action", "push button", "Retry same request");

  const retryCommand = await eventAt(
    "domain-command",
    (event) =>
      event.commandId === dropped.commandId && event.requestId !== originalCommand.requestId,
  );

  const retryReceipt = await eventAt(
    "domain-receipt",
    (event) => event.commandId === dropped.commandId && event.requestId === retryCommand.requestId,
  );

  assert.equal(retryCommand.inputSha256, originalDigest);
  assert.deepEqual(receiptValue(retryReceipt), receiptValue(originalReceipt));

  const retried = await treeAt(
    "original-receipt-retried",
    (tree) =>
      tree.includes("Saved to your library.") && !tree.includes("[push button] Retry same request"),
  );

  assert.deepEqual(draftValue(retried), editedDraft);

  const afterRetry = Schema.decodeUnknownSync(LibrarySnapshot)(
    successfulValue(await control({ action: "inspect" })),
  );

  assert.deepEqual(afterRetry, committed);
  observations.push({
    phase: "unknown-retry",
    originalCommand,
    dropped,
    originalReceipt,
    retryCommand,
    retryReceipt,
    beforeLoss,
    committed,
    afterRetry,
  });
  cases.push(
    "real committed/lost reply stays Unknown; edited-draft retry preserves command ID/input/original receipt and one allocation",
  );

  await control({ action: "revokeAll" });
  const revoked = await treeAt("revoked", (tree) => !enabled(tree, "Propose skill"), false);

  assert.equal(enabled(revoked, "Propose skill"), false);

  // A closed stream may first report a network failure. Explicit Reconnect then
  // observes the server's401 and asks the host's named authentication capability.
  if (enabled(revoked, "Reconnect")) os("action", "push button", "Reconnect");

  await treeAt(
    "revocation-reauth-requested",
    (tree) => tree.includes("[push button] Authorize Kitties Desktop"),
    false,
  );
  await control({ action: "nextTokenLifetime", ttlSeconds: 3 });
  await browserDecision(true, true);
  await treeAt("short-token-connected", (tree) => enabled(tree, "Propose skill"));

  const expired = await treeAt(
    "expired",
    (tree) => tree.includes("[push button] Authorize Kitties Desktop"),
    false,
  );

  assert.equal(enabled(expired, "Propose skill"), false);
  cases.push("real expiry disables packaged command/watch availability");

  await browserDecision(true, true);
  const reconnected = await treeAt("reconnected", (tree) => enabled(tree, "Propose skill"));
  assert(reconnected.includes("Review · Second client live skill"));
  cases.push("same-owner/epoch browser reauthentication restores scoped client and watch");
  await close();
  open();
  const relaunched = await treeAt("relaunched", (tree) => enabled(tree, "Sign in"));
  assert.equal(relaunched.includes("[push button] Propose skill"), false);
  cases.push("new packaged process has no persisted native credentials");

  await browserDecision(true);
  await treeAt("before-freeze", (tree) => enabled(tree, "Propose skill"));
  os("action", "push button", `Review · ${originalDraft.name}`);
  await treeAt("before-freeze-detail", (tree) => enabled(tree, "Accept"));

  const refusedDraft = {
    name: "Refuse this frozen command",
    body: "Keep this exact draft after Domain denial.",
  };

  fill("Name", refusedDraft.name);
  fill("Instructions", refusedDraft.body);
  const beforeDenial = await evidence();
  const statsBeforeDenial = await control({ action: "stats" });
  const frozen = await control({ action: "freeze" });
  os("action", "push button", "Propose skill");

  const domainDenied = await eventAt(
    "domain-denied",
    (event) => event.tag === "ProposeSkill" && event.at >= beforeDenial.events.at(-1).at,
  );

  const refusedCommand = await eventAt(
    "domain-command",
    (event) => event.commandId === domainDenied.commandId,
  );

  const refusedDigest = createHash("sha256")
    .update(JSON.stringify(refusedDraft))
    .digest("base64url");

  assert.equal(refusedCommand.inputSha256, refusedDigest);
  assert.equal(domainDenied.requestId, refusedCommand.requestId);
  assert.equal(domainDenied.error, "LibraryUnauthorized");

  const priorToken = beforeDenial.events.filter((event) => event.event === "token-issued").at(-1);
  assert(priorToken);
  assert(
    priorToken.expiresAt > domainDenied.at,
    "Domain refused a command while its native bearer remained valid",
  );

  const fenced = await treeAt(
    "domain-command-denied",
    (tree) =>
      !enabled(tree, "Propose skill") && !enabled(tree, "Accept") && !enabled(tree, "Remove"),
    false,
  );

  assert.deepEqual(draftValue(fenced), refusedDraft);
  assert.equal(enabled(fenced, "Retry same request"), false);

  const statsAfterDenial = await control({ action: "stats" });
  assert.equal(
    Schema.decodeUnknownSync(Schema.Struct({ sends: Schema.Int }))(statsAfterDenial).sends,
    Schema.decodeUnknownSync(Schema.Struct({ sends: Schema.Int }))(statsBeforeDenial).sends,
    "middleware denial must precede the actual aggregate send/allocation",
  );
  observations.push({
    phase: "frozen-domain-denial",
    frozen,
    domainDenied,
    refusedCommand,
    priorToken,
    statsBeforeDenial,
    statsAfterDenial,
  });
  cases.push(
    "valid-token packaged Domain command is refused after real Recovery freeze; exact draft retained and all mutations fenced",
  );
} catch (cause) {
  failure = cause instanceof Error ? cause.message : String(cause);

  try {
    writeFileSync(join(output, "failure-tree.txt"), os("tree"));
  } catch {
    // Retain the original failing assertion if the process has already gone.
  }
} finally {
  try {
    await close();
  } catch (cause) {
    failure ??= `Cleanup: ${String(cause)}`;
  }

  writeFileSync(join(output, "app.log"), appLog);

  const result = {
    status: failure === null ? "PASS" : "FAIL",
    binary,
    binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
    cases,
    observations,
    failure,
    scope:
      "Explicit local issuer/real native Domain; no real Access, authority-cutover or prompt idle-body cancellation claim",
  };

  writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));

  if (failure !== null) process.exitCode = 1;
}
