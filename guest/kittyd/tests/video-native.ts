// Run under Xvfb in Ubuntu with the built voxl installed at /usr/local/lib/kittyd/voxl.
// Exercises the real loopback capture and the actual guest relay; no desktop secrets.
import { strict as assert } from "node:assert";
import { startVideo } from "../src/video.ts";
import { videoHeader } from "@kitties/protocol/video";

const server = Bun.serve({
  port: 0,
  fetch(request, server) {
    assert.equal(request.headers.get("Authorization"), "Bearer fixture-channel-token");
    assert.equal(request.headers.get("X-Kitty-Epoch"), "7");
    if (server.upgrade(request)) return;
    return new Response(null, { status: 400 });
  },
  websocket: {
    message(socket, data) {
      if (typeof data === "string") {
        if (data === "ping") socket.send("pong");
        return;
      }
      const header = videoHeader(new Uint8Array(data));
      assert(header);
      assert.equal(header.generation, 3);
      frames++;
      if (header.key) keys++;
      if (frames === 1) {
        assert(header.key, "first forwarded frame must be independently decodable");
        // Arbitrary commands are ignored rather than proxied to voxl.
        socket.send(JSON.stringify({ type: "input", action: "type", text: "not permitted" }));
        setTimeout(() => socket.send(JSON.stringify({ type: "keyframe" })), 600);
      }
      if (keys >= 2) done();
    },
  },
});
let frames = 0,
  keys = 0,
  finish: () => void;
const complete = new Promise<void>((resolve) => {
  finish = resolve;
});
function done() {
  finish();
}
let ended = false;
const stop = startVideo({
  url: `ws://127.0.0.1:${server.port}/video`,
  headers: { Authorization: "Bearer fixture-channel-token", "X-Kitty-Epoch": "7" },
  generation: 3,
  env: process.env,
  ended: () => {
    ended = true;
  },
});
try {
  const deadline = setTimeout(() => {
    console.error("video relay timed out");
    process.exit(1);
  }, 15000);
  await complete;
  clearTimeout(deadline);
  const unauthenticated = await fetch("http://127.0.0.1:19223/screenshot");
  assert.equal(unauthenticated.status, 401);
  assert(!ended);
  console.log(
    JSON.stringify({
      status: "passed",
      frames,
      keys,
      checks: [
        "real H264 capture",
        "generation envelope",
        "keyframe recovery",
        "private loopback authentication",
      ],
    }),
  );
} finally {
  stop();
  await server.stop(true);
}
