import fs from "node:fs";
import assert from "node:assert/strict";
const token = fs.readFileSync(
  process.env.KITTIES_TEST_TOKEN_FILE ?? ".context/verify-token",
  "utf8",
);
class Peer {
  ws: WebSocket;
  messages: any[] = [];
  waiters: { check: (x: any) => boolean; resolve: (x: any) => void }[] = [];
  constructor(url: string) {
    this.ws = new WebSocket(
      url.replace(
        "checks.kitties.rccpr.tech",
        process.env.KITTIES_TEST_IP ?? "checks.kitties.rccpr.tech",
      ),
      {
        tls: { serverName: "checks.kitties.rccpr.tech" },
        headers: {
          Host: "checks.kitties.rccpr.tech",
          Authorization: `Bearer ${token}`,
          "User-Agent": "Mozilla/5.0 (Kitties acceptance)",
        },
      },
    );
    this.ws.onmessage = (e) => {
      const value = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      const index = this.waiters.findIndex((w) => w.check(value));
      if (index >= 0) this.waiters.splice(index, 1)[0]!.resolve(value);
      else this.messages.push(value);
    };
    this.ws.onerror = (e) => console.log("socket error", String((e as any).message ?? e));
  }
  wait(check: (x: any) => boolean) {
    const index = this.messages.findIndex(check);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return Promise.race([
      new Promise<any>((resolve) => this.waiters.push({ check, resolve })),
      new Promise((_, reject) => setTimeout(() => reject(Error("Timeout")), 10000)),
    ]);
  }
  send(x: any) {
    this.ws.send(JSON.stringify(x));
  }
}
const owner = new Peer("wss://checks.kitties.rccpr.tech/desktop/control");
const connection = await owner.wait((x) => x.type === "connected");
console.log("owner connected", connection.generation, connection.epoch);
owner.send({ type: "grant" });
const { receipt } = await owner.wait((x) => x.type === "grant");
const samples: number[] = [];
const hops: Record<string, number[]> = {
  guestQueue: [],
  guestExecution: [],
  doToGuest: [],
  guestToDo: [],
  withinDo: [],
};
for (let i = 0; i < 200; i++) {
  const before = performance.now();
  owner.send({
    type: "input",
    intentId: `warm-${Date.now()}-${i}`,
    nonce: receipt.nonce,
    generation: connection.generation,
    epoch: connection.epoch,
    deadline: Date.now() + 10000,
    action: "move",
    args: { x: 50 + (i % 100), y: 50 + (i % 100) },
  });
  const ack = await owner.wait((x) => x.type === "ack");
  assert.equal(ack.status, "completed");
  samples.push(performance.now() - before);
  if (ack.timings) {
    const t = ack.timings;
    hops.guestQueue!.push(t.startedAt - t.receivedAt);
    hops.guestExecution!.push(t.completedAt - t.startedAt);
    hops.doToGuest!.push(t.receivedAt - t.doReceivedAt);
    hops.guestToDo!.push(t.doAckAt - t.completedAt);
    hops.withinDo!.push(t.doAckAt - t.doReceivedAt);
  }
  if (i % 50 === 49) console.log("inputs", i + 1);
}
const sorted = samples.sort((a, b) => a - b),
  report = {
    date: new Date().toISOString(),
    runtime: "Cloudflare KittyDO + Boat kittyd, browser-equivalent client in US workspace",
    inputs: 200,
    ackP50Ms: sorted[99],
    ackP95Ms: sorted[189],
    ackMaxMs: sorted.at(-1),
    includes: "US workspace to European DO, persistent guest channel and real xdotool mousemove",
    hops: Object.fromEntries(
      Object.entries(hops).map(([key, values]) => {
        values.sort((a, b) => a - b);
        return [
          key,
          {
            p50: values[Math.floor(values.length * 0.5)],
            p95: values[Math.floor(values.length * 0.95)],
            max: values.at(-1),
          },
        ];
      }),
    ),
  };
fs.writeFileSync("docs/effect/evidence/channel-boat.json", JSON.stringify(report, null, 2) + "\n");
console.log(report);
owner.send({ type: "release", nonce: receipt.nonce });
await owner.wait((x) => x.type === "control_revoked");
owner.ws.close();
process.exit();
