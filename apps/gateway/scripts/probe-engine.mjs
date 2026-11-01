import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const base = process.env.KITTIES_TEST_URL ?? "http://localhost:1337";
const tag = `probe-${Date.now()}`;
async function api(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(response.ok, `${response.status} ${path}: ${await response.clone().text()}`);
  return response.json();
}
const start = (id, overrides = {}) =>
  api("/v1/operator/probes", {
    id,
    steps: 3,
    delayMs: 20,
    wait: false,
    fail: false,
    ...overrides,
  });
async function poll(id, check) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const status = await api(`/v1/operator/probes/${id}`);
    if (check(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout waiting for ${id}`);
}
async function assertCalls(executionId, id, steps) {
  const calls = await api(`/v1/operator/probes/${executionId}/calls?id=${id}`);
  assert.equal(calls.length, steps);
  for (const call of calls)
    assert.equal(call.calls, 1, `step ${call.step} ran ${call.calls} times`);
}
const report = { date: new Date().toISOString(), base, cases: [] };
for (const steps of [3, 50, 200, 500]) {
  const id = `${tag}-steps-${steps}`;
  const startedAt = performance.now();
  const { executionId } = await start(id, { steps, wait: true });
  await poll(executionId, (status) => status._tag === "Running");
  // Poll the side-effect log until the workflow has reached its durable deferred.
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const calls = await api(`/v1/operator/probes/${executionId}/calls?id=${id}`);
    if (calls.length === steps) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const replayAt = performance.now();
  await api(`/v1/operator/probes/${executionId}/signal`, {});
  const status = await poll(executionId, (status) => status._tag === "Completed");
  assert.equal(status.result, steps);
  await assertCalls(executionId, id, steps);
  const duplicate = await start(id, { steps, wait: true });
  assert.equal(duplicate.executionId, executionId);
  await assertCalls(executionId, id, steps);
  report.cases.push({
    name: "clock-deferred-replay-dedupe",
    steps,
    replaySignalToResultMs: performance.now() - replayAt,
    totalMs: performance.now() - startedAt,
  });
}
{
  const id = `${tag}-failure`;
  const { executionId } = await start(id, { fail: true });
  const status = await poll(executionId, (status) => status._tag === "Failed");
  assert.equal(status.error, "PROBE_FAILURE");
  await start(id, { fail: true });
  await assertCalls(executionId, id, 1);
  report.cases.push({ name: "failed-activity-journaled", status: "pass" });
}
{
  const id = `${tag}-interrupt`;
  const { executionId } = await start(id, { wait: true });
  await poll(executionId, (status) => status._tag === "Running");
  await api(`/v1/operator/probes/${executionId}/interrupt`, {});
  await poll(executionId, (status) => status._tag === "Interrupted");
  report.cases.push({ name: "interrupt-durable-wait", status: "pass" });
}
{
  const crossOrigin = await fetch(`${base}/v1/operator/probes`, {
    method: "POST",
    headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(crossOrigin.status, 403);
  for (const path of ["/v1/unknown", "/guest/v1/session", "/hooks/v1/session"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "NOT_FOUND");
  }
  report.cases.push({ name: "owner-route-isolation", status: "pass" });
}
const file = process.env.KITTIES_TEST_REPORT;
if (file) await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
