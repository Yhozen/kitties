import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const base = "http://localhost:1337",
  ingress = "ws://localhost:1338",
  token = crypto.randomUUID() + crypto.randomUUID();
const hash = Array.from(
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
  (b) => b.toString(16).padStart(2, "0"),
).join("");
const c = {
  kittyId: "channel-test",
  remoteId: "bx_fixture",
  generation: 1,
  tokenVersion: 1,
  tokenHash: hash,
};
const r = await fetch(base + "/v1/operator/desktop", {
  method: "POST",
  headers: { Origin: base, "Content-Type": "application/json" },
  body: JSON.stringify(c),
});
assert.equal(r.status, 200);
class Peer {
  ws: WebSocket;
  messages: any[] = [];
  waiters: { check: (x: any) => boolean; resolve: (x: any) => void }[] = [];
  constructor(url: string, headers: Record<string, string> = {}) {
    this.ws = new WebSocket(url, { headers });
    this.ws.onmessage = (e) => {
      const value = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      const index = this.waiters.findIndex((w) => w.check(value));
      if (index >= 0) this.waiters.splice(index, 1)[0]!.resolve(value);
      else this.messages.push(value);
    };
  }
  wait(check: (x: any) => boolean) {
    const index = this.messages.findIndex(check);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return Promise.race([
      new Promise<any>((resolve) => this.waiters.push({ check, resolve })),
      new Promise((_, reject) => setTimeout(() => reject(Error("Timeout")), 5000)),
    ]);
  }
  send(x: any) {
    this.ws.send(JSON.stringify(x));
  }
}
const headers = {
  Authorization: `Bearer ${token}`,
  "X-Kitty-Remote": c.remoteId,
  "X-Kitty-Generation": "1",
  "X-Kitty-Token-Version": "1",
};
const guest = new Peer(`${ingress}/guest/${c.kittyId}/control`, headers);
const welcome = await guest.wait((x) => x.type === "welcome");
const owner = new Peer(base.replace("http", "ws") + `/v1/kitties/${c.kittyId}/desktop/control`, {
  Origin: base,
});
await owner.wait((x) => x.type === "connected");
owner.send({ type: "grant" });
const { receipt } = await owner.wait((x) => x.type === "grant");
assert.equal(receipt.epoch, welcome.epoch);
let effects = 0;
guest.ws.addEventListener("message", (e) => {
  const b = JSON.parse(String(e.data));
  if (b.type === "action") {
    effects++;
    guest.send({
      type: "ack",
      intentId: b.intentId,
      generation: 1,
      epoch: welcome.epoch,
      status: "completed",
      result: "ok",
    });
  }
});
const samples: number[] = [];
for (let i = 0; i < 200; i++) {
  const before = performance.now();
  owner.send({
    type: "input",
    intentId: `input-${i}-${Date.now()}`,
    nonce: receipt.nonce,
    generation: 1,
    epoch: welcome.epoch,
    deadline: Date.now() + 10000,
    action: "click",
    args: { x: 20, y: 20 },
  });
  await owner.wait((x) => x.type === "ack");
  samples.push(performance.now() - before);
}
assert.equal(effects, 200);
owner.send({ type: "release", nonce: receipt.nonce });
await owner.wait((x) => x.type === "control_revoked");
owner.send({
  type: "input",
  intentId: "after-release",
  nonce: receipt.nonce,
  generation: 1,
  epoch: welcome.epoch,
  deadline: Date.now() + 10000,
  action: "click",
  args: { x: 1, y: 1 },
});
await owner.wait((x) => x.type === "error");
assert.equal(effects, 200);
for (const path of ["/v1/session", "/hooks/foo", "/guest/channel-test/owner"]) {
  const response = await fetch("http://localhost:1338" + path);
  assert.equal(response.status, 404);
}
const sorted = samples.sort((a, b) => a - b);
const report = {
  date: new Date().toISOString(),
  runtime: "local workerd + fake guest",
  inputs: 200,
  ackP50Ms: sorted[99],
  ackP95Ms: sorted[189],
  effectCount: effects,
  cases: [
    "owner grant and fenced input",
    "release rejects queued input",
    "guest ingress excludes owner APIs",
  ],
};
await writeFile("docs/effect/evidence/channel-local.json", JSON.stringify(report, null, 2) + "\n");
console.log(report);
owner.ws.close();
guest.ws.close();
process.exit();
