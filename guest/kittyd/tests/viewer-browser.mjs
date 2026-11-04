// Browser acceptance for the real viewer. Requires Chrome, Bun, and a keyframe
// from video-native.ts run under a fresh synthetic Xvfb (KITTYD_VIDEO_FIXTURE).
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
const require = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const work = mkdtempSync(join(tmpdir(), "kitties-viewer-"));
const video = readFileSync(process.env.KITTYD_VIDEO_FIXTURE);
const seq = video.readUInt32BE(6);
assert.equal(video.readUInt32BE(0), 3);
execFileSync("bun", [
  "build",
  "apps/web/src/desktop-viewer.ts",
  "--target=browser",
  "--outfile",
  join(work, "viewer.js"),
]);
const code = readFileSync(join(work, "viewer.js"), "utf8");
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessPermissionPolicy",
  ],
});
const passed = [];
async function fixture(prepare) {
  const context = await browser.newContext();
  if (prepare) await context.addInitScript(prepare);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/viewer.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: code }),
  );
  await page.route("**/fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<canvas></canvas><script type="module">
    import {createDesktopViewer} from '/viewer.js';
    window.framesSeen=[]; window.disconnected=0;
    window.start=()=>{window.viewer=createDesktopViewer({base:'ws://localhost:17777/desktop',canvas:document.querySelector('canvas'),generation:3,epoch:7,onFrame:mode=>window.framesSeen.push(mode),onDisconnect:()=>window.disconnected++});};
  </script>`,
    }),
  );
  await page.goto("http://localhost:17777/fixture");
  await page.waitForFunction(() => typeof window.start === "function");
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 16, 16);
    return canvas.toDataURL("image/jpeg").split(",")[1];
  });
  const jpeg = Buffer.concat([Buffer.alloc(8), Buffer.from(image, "base64")]);
  jpeg.writeUInt32BE(3);
  jpeg.writeUInt32BE(42, 4);
  return { context, page, errors, jpeg };
}
try {
  {
    const { context, page, errors } = await fixture();
    const acks = [];
    await page.routeWebSocket("**/desktop/video", (socket) => {
      socket.onMessage((message) => {
        if (message !== "ping") acks.push(JSON.parse(String(message)));
      });
      socket.send(JSON.stringify({ type: "video_ready", generation: 3, epoch: 7 }));
      socket.send(video);
    });
    await page.evaluate(() => window.start());
    await page.waitForFunction(() => window.framesSeen[0] === "video");
    assert.deepEqual(
      await page.locator("canvas").evaluate((c) => [c.width, c.height]),
      [1280, 800],
    );
    await page.waitForTimeout(50);
    assert(acks.some((ack) => ack.type === "video_ack" && ack.seq === seq));
    assert(acks.every((ack) => ["video_ack", "keyframe"].includes(ack.type)));
    assert.deepEqual(errors, []);
    passed.push("real voxl H264 decoded, drawn and acknowledged");
    await context.close();
  }
  {
    const { context, page } = await fixture(() => {
      const NativeDecoder = window.VideoDecoder;
      window.VideoDecoder = class {
        state = "unconfigured";
        decodeQueueSize = 0;
        configure() {
          this.state = "configured";
        }
        decode() {
          this.decodeQueueSize++;
        }
        close() {
          this.state = "closed";
          window.VideoDecoder = NativeDecoder;
        }
      };
    });
    const messages = [];
    await page.routeWebSocket("**/desktop/video", (socket) => {
      socket.onMessage((message) => {
        if (message === "ping") return;
        const body = JSON.parse(String(message));
        messages.push(body);
        if (body.type === "keyframe") {
          const recovered = Buffer.from(video);
          recovered.writeUInt32BE(99, 6);
          socket.send(recovered);
        }
      });
      socket.send(JSON.stringify({ type: "video_ready", generation: 3, epoch: 7 }));
      for (let index = 1; index <= 7; index++) {
        const queued = Buffer.from(video);
        queued.writeUInt32BE(index, 6);
        socket.send(queued);
      }
    });
    await page.evaluate(() => window.start());
    await page.waitForFunction(() => window.framesSeen[0] === "video");
    await page.waitForTimeout(50);
    assert(messages.some((body) => body.type === "keyframe"));
    assert.deepEqual(
      messages.filter((body) => body.type === "video_ack").map((body) => body.seq),
      [99],
    );
    passed.push("decoder backlog resets and recovers on a real keyframe");
    await context.close();
  }
  for (const failure of [
    "missing-codec",
    "decoder-error",
    "startup-timeout",
    "video-unavailable",
  ]) {
    const { context, page, errors, jpeg } = await fixture(
      failure === "missing-codec"
        ? () => {
            Object.defineProperty(window, "VideoDecoder", { value: undefined });
          }
        : failure === "decoder-error"
          ? () => {
              window.VideoDecoder = class {
                state = "unconfigured";
                configure() {
                  throw Error("unsupported codec");
                }
                close() {
                  this.state = "closed";
                }
              };
            }
          : undefined,
    );
    const paths = [],
      acks = [];
    await page.routeWebSocket("**/desktop/*", (socket) => {
      paths.push(socket.url());
      socket.onMessage((message) => {
        if (message !== "ping") acks.push(JSON.parse(String(message)));
      });
      if (socket.url().endsWith("/frames")) socket.send(jpeg);
      else if (failure === "video-unavailable")
        socket.close({ code: 1003, reason: "fixture unavailable" });
      else {
        socket.send(JSON.stringify({ type: "video_ready", generation: 3, epoch: 7 }));
        if (failure === "decoder-error") socket.send(video);
      }
    });
    await page.evaluate(() => window.start());
    await page.waitForFunction(() => window.framesSeen[0] === "jpeg");
    assert.deepEqual(await page.locator("canvas").evaluate((c) => [c.width, c.height]), [16, 16]);
    const pixel = await page
      .locator("canvas")
      .evaluate((c) => Array.from(c.getContext("2d").getImageData(0, 0, 1, 1).data));
    assert(pixel[0] > 240 && pixel[1] < 10 && pixel[2] < 10);
    await page.waitForTimeout(50);
    assert(acks.some((ack) => ack.type === "frame_ack" && ack.seq === 42));
    assert.equal(paths.filter((path) => path.endsWith("/frames")).length, 1);
    assert.equal(await page.evaluate(() => window.disconnected), 0);
    assert.deepEqual(errors, []);
    passed.push(failure + " falls back to JPEG");
    await context.close();
  }
  for (const stale of ["generation", "epoch", "frame-generation"]) {
    const { context, page } = await fixture();
    await page.routeWebSocket("**/desktop/video", (socket) => {
      socket.send(
        JSON.stringify({
          type: "video_ready",
          generation: stale === "generation" ? 4 : 3,
          epoch: stale === "epoch" ? 8 : 7,
        }),
      );
      const packet = Buffer.from(video);
      if (stale === "frame-generation") packet.writeUInt32BE(4);
      socket.send(packet);
    });
    await page.evaluate(() => window.start());
    await page.waitForFunction(() => window.disconnected === 1);
    assert.deepEqual(await page.evaluate(() => window.framesSeen), []);
    passed.push(stale + " fence disconnects before rendering");
    await context.close();
  }
  {
    const { context, page, jpeg } = await fixture(() => {
      Object.defineProperty(window, "VideoDecoder", { value: undefined });
      const native = window.createImageBitmap;
      window.createImageBitmap = (...args) =>
        new Promise((resolve) => {
          window.finishBitmap = async () => resolve(await native(...args));
        });
    });
    await page.routeWebSocket("**/desktop/frames", (socket) => socket.send(jpeg));
    await page.evaluate(() => window.start());
    await page.waitForFunction(() => !!window.finishBitmap);
    await page.evaluate(async () => {
      window.viewer.close();
      await window.finishBitmap();
    });
    await page.waitForTimeout(50);
    assert.deepEqual(await page.evaluate(() => window.framesSeen), []);
    passed.push("late JPEG decode cannot paint a closed viewer");
    await context.close();
  }
  console.log(JSON.stringify({ status: "passed", browser: "Chrome", checks: passed }, null, 2));
} finally {
  await browser.close();
  rmSync(work, { recursive: true, force: true });
}
