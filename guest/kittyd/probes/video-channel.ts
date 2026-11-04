// Local workerd integration: run the local stage on 1337/1338, then `bun probes/video-channel.ts`.
import { strict as assert } from "node:assert";
const base = "http://localhost:1337",
  ingress = "ws://localhost:1338";
const token = crypto.randomUUID() + crypto.randomUUID(),
  kittyId = "video-" + crypto.randomUUID();
const tokenHash = Array.from(
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
  (b) => b.toString(16).padStart(2, "0"),
).join("");
const config = { kittyId, remoteId: "bx_video_fixture", generation: 1, tokenVersion: 1, tokenHash };
assert.equal(
  (
    await fetch(base + "/v1/operator/desktop", {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify(config),
    })
  ).status,
  200,
);
const peers: Peer[] = [];
class Peer {
  ws: WebSocket;
  values: any[] = [];
  open: Promise<void>;
  closed: Promise<void>;
  waiters: Array<{ test: (value: any) => boolean; resolve: (value: any) => void }> = [];
  constructor(url: string, headers: Record<string, string>) {
    this.ws = new WebSocket(url, { headers });
    this.ws.binaryType = "arraybuffer";
    this.open = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(Error("handshake failed"));
    });
    this.closed = new Promise((resolve) => {
      this.ws.onclose = () => resolve();
    });
    this.ws.onmessage = (event) => {
      const value = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      const index = this.waiters.findIndex((w) => w.test(value));
      if (index >= 0) this.waiters.splice(index, 1)[0].resolve(value);
      else this.values.push(value);
    };
    peers.push(this);
  }
  async wait(test: (value: any) => boolean) {
    const index = this.values.findIndex(test);
    if (index >= 0) return this.values.splice(index, 1)[0];
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        new Promise((resolve) => this.waiters.push({ test, resolve })),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("message timeout: " + test.toString())), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  }
  send(value: unknown) {
    this.ws.send(JSON.stringify(value));
  }
}
const guestHeaders = {
  Authorization: `Bearer ${token}`,
  "X-Kitty-Remote": config.remoteId,
  "X-Kitty-Generation": "1",
  "X-Kitty-Token-Version": "1",
};
const route = (path: string) =>
  base.replace("http", "ws") + `/v1/kitties/${kittyId}/desktop/${path}`;
const binary = (value: unknown) => value instanceof ArrayBuffer;
const packet = (seq: number, key = false) => {
  const bytes = new Uint8Array(25),
    view = new DataView(bytes.buffer);
  view.setUint32(0, 1);
  bytes[4] = 1;
  bytes[5] = key ? 1 : 0;
  view.setUint32(6, seq);
  bytes[16] = 1;
  return bytes;
};
try {
  const guest = new Peer(`${ingress}/guest/${kittyId}/control`, guestHeaders);
  await guest.open;
  const { epoch } = await guest.wait((value) => value.type === "welcome");
  const mediaHeaders = { ...guestHeaders, "X-Kitty-Epoch": String(epoch) };
  const video = new Peer(`${ingress}/guest/${kittyId}/video`, mediaHeaders);
  await video.open;
  const fast = new Peer(route("video"), { Origin: base });
  await fast.open;
  await fast.wait((value) => value.type === "video_ready");
  const slow = new Peer(route("video"), { Origin: base });
  await slow.open;
  await slow.wait((value) => value.type === "video_ready");
  const status = await (await fetch(`${base}/v1/kitties/${kittyId}/desktop`)).json() as { viewers: number };
  assert.equal(status.viewers, 2, "video viewers must keep the desktop active");
  const foreign = new Peer(route("video"), { Origin: "https://unrelated.invalid" });
  await assert.rejects(foreign.open);
  for (let seq = 1; seq <= 9; seq++) {
    video.ws.send(packet(seq, seq === 1));
    const bytes = await fast.wait(binary);
    assert.equal(new DataView(bytes).getUint32(6), seq);
    fast.send({ type: "video_ack", seq });
  }
  assert.equal(slow.values.filter(binary).length, 8);
  video.values = video.values.filter((value) => value.type !== "keyframe");
  slow.send({ type: "video_ack", seq: 8 });
  await video.wait((value) => value.type === "keyframe");
  video.ws.send(packet(10));
  await fast.wait(binary);
  fast.send({ type: "video_ack", seq: 10 });
  video.ws.send(packet(11, true));
  const recovered = await slow.wait(
    (value) => binary(value) && new DataView(value).getUint32(6) === 11,
  );
  assert(recovered);
  // Video peers cannot acquire a grant or inject input.
  slow.send({ type: "grant" });
  slow.send({ type: "input", action: "click", args: { x: 1, y: 1 } });
  const owner = new Peer(route("control"), { Origin: base });
  await owner.open;
  await owner.wait((value) => value.type === "connected");
  owner.send({ type: "grant" });
  const { receipt } = await owner.wait((value) => value.type === "grant");
  owner.send({ type: "release", nonce: receipt.nonce });
  await owner.wait((value) => value.type === "control_revoked");
  owner.send({
    type: "input",
    intentId: crypto.randomUUID(),
    ...receipt,
    deadline: Date.now() + 10000,
    action: "click",
    args: { x: 1, y: 1 },
  });
  await owner.wait((value) => value.type === "error");
  assert(!guest.values.some((value) => value.type === "action"));
  const reconnect = new Peer(`${ingress}/guest/${kittyId}/control`, guestHeaders);
  await reconnect.open;
  const welcome = await reconnect.wait((value) => value.type === "welcome");
  assert(welcome.epoch > epoch);
  await Promise.all([video.closed, fast.closed, slow.closed]);
  const stale = new Peer(`${ingress}/guest/${kittyId}/video`, mediaHeaders);
  await assert.rejects(stale.open);
  console.log(
    JSON.stringify({
      status: "passed",
      scope: "local workerd, synthetic H264 packets",
      checks: [
        "video viewers prevent idle sleep",
        "foreign Origin rejected",
        "slow viewer isolation",
        "keyframe after dropped delta",
        "video cannot grant or input",
        "release rejects input",
        "epoch change closes video peers",
        "stale guest epoch rejected",
      ],
    }),
  );
} finally {
  for (const peer of peers) peer.ws.close();
}
