import type * as cf from "@cloudflare/workers-types";

// The caller is a verifier DO placed in western Europe. No operator credential is
// delivered to the guest, and the measurements are explicitly regional.
export async function benchmarkChannel(
  desktops: cf.DurableObjectNamespace,
  count: number,
  kittyId: string,
) {
  const response = await desktops
    .getByName(kittyId, { locationHint: "weur" })
    .fetch("https://desktop.internal/desktop/control", { headers: { Upgrade: "websocket" } });
  const ws = response.webSocket;
  if (!ws) throw Error(`Handshake failed: ${response.status}`);
  const buffered: Record<string, unknown>[] = [];
  let waiter:
    | { type: string; resolve: (body: any) => void; reject: (error: Error) => void }
    | undefined;
  ws.addEventListener("message", (event) => {
    const body = JSON.parse(String(event.data));
    if (
      waiter &&
      (body.type === "error" || (body.type === "control_revoked" && waiter.type === "ack"))
    ) {
      const current = waiter;
      waiter = undefined;
      current.reject(Error(`Channel: ${JSON.stringify(body)}`));
      return;
    }
    if (waiter && body.type === waiter.type) {
      const current = waiter;
      waiter = undefined;
      current.resolve(body);
    } else buffered.push(body);
  });
  const wait = (type: string): Promise<any> => {
    const index = buffered.findIndex((body) => body.type === type);
    if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiter = undefined;
        reject(Error(`Timeout: ${type}`));
      }, 10000);
      waiter = {
        type,
        reject,
        resolve: (body) => {
          clearTimeout(timer);
          resolve(body);
        },
      };
    });
  };
  ws.accept();
  try {
    const connection = await wait("connected");
    ws.send(JSON.stringify({ type: "grant" }));
    const { receipt } = await wait("grant");
    const samples: number[] = [];
    const execution: number[] = [];
    for (let index = 0; index < count; index++) {
      const at = Date.now();
      ws.send(
        JSON.stringify({
          type: "input",
          intentId: `eu-${at}-${index}`,
          nonce: receipt.nonce,
          generation: connection.generation,
          epoch: connection.epoch,
          deadline: at + 10000,
          action: "move",
          args: { x: 50 + (index % 100), y: 50 + (index % 100) },
        }),
      );
      const ack = await wait("ack");
      if (ack.status !== "completed") throw Error(`Action: ${ack.status}`);
      samples.push(Date.now() - at);
      if (ack.timings) execution.push(ack.timings.completedAt - ack.timings.startedAt);
    }
    ws.send(JSON.stringify({ type: "release", nonce: receipt.nonce }));
    await wait("control_revoked");
    samples.sort((a, b) => a - b);
    execution.sort((a, b) => a - b);
    return {
      date: new Date().toISOString(),
      runtime: "European verifier DO → KittyDO → real Boat kittyd",
      inputs: count,
      ackP50Ms: samples[Math.floor(count * 0.5)],
      ackP95Ms: samples[Math.floor(count * 0.95)],
      ackMaxMs: samples.at(-1),
      guestExecutionP95Ms: execution[Math.floor(execution.length * 0.95)],
      includes: "Regional channel measurement; excludes browser-to-European-edge network time.",
    };
  } finally {
    ws.close();
  }
}
