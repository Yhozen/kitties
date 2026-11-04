// Real guest channel and WebSockets, with one static capture and a delayed
// media handshake. No display or user computer is needed for this regression.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.argv.includes("--guest")) {
  const spawn = Bun.spawn;
  Bun.spawn = ((command: string[], options: Record<string, unknown>) => {
    assert.equal(command[0], "/usr/local/lib/kittyd/kitty-grab");
    return spawn(
      [process.execPath, "-e", 'process.stdout.write("FRAME 3\\nabc");setInterval(()=>{},1000)'],
      options,
    );
  }) as typeof Bun.spawn;
  await import("../src/channel.ts");
} else {
  const work = await mkdtemp(join(tmpdir(), "kittyd-jpeg-startup-"));
  let received: (bytes: ArrayBuffer) => void;
  const frame = new Promise<ArrayBuffer>((resolve) => (received = resolve));
  const server = Bun.serve<{ media: boolean }>({
    port: 0,
    async fetch(request, server) {
      const media = new URL(request.url).pathname.endsWith("/frames");
      if (media) await Bun.sleep(500);
      if (server.upgrade(request, { data: { media } })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(peer) {
        if (!peer.data.media)
          peer.send(JSON.stringify({ type: "welcome", epoch: 7, viewers: 1, reconcile: [] }));
      },
      message(peer, message) {
        if (peer.data.media && typeof message !== "string")
          received!(new Uint8Array(message).buffer);
      },
    },
  });
  await writeFile(
    join(work, "config.json"),
    JSON.stringify({
      url: `ws://localhost:${server.port}/guest/static/control`,
      token: "fixture",
      kittyId: "static",
      remoteId: "fixture",
      generation: 3,
      tokenVersion: 1,
      database: join(work, "receipts.db"),
    }),
  );
  const guest = Bun.spawn([process.execPath, import.meta.path, "--guest"], {
    env: { ...process.env, KITTYD_CONFIG: join(work, "config.json") },
    stdout: "ignore",
    stderr: "inherit",
  });
  try {
    const bytes = await Promise.race([
      frame,
      Bun.sleep(3000).then(() => {
        throw Error("Static desktop never delivered its first picture");
      }),
    ]);
    assert.equal(new DataView(bytes).getUint32(0), 3);
    assert.equal(new TextDecoder().decode(new Uint8Array(bytes).slice(8)), "abc");
    console.log("Static JPEG arrives after delayed media handshake without another screen change");
  } finally {
    guest.kill();
    await guest.exited;
    await server.stop(true);
    await rm(work, { recursive: true, force: true });
  }
}
