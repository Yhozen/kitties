import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
// Dedicated Ubuntu test container with this repository mounted at /work only.
// The fixture and daemon are separate from all real Kitties/Boat desktops.
const base = "http://localhost:1337";
const work = ".context/desktop-motion";
fs.mkdirSync(work, { recursive: true });
execFileSync("bun", ["guest/kittyd/tests/build-viewer-fixture.ts"]);
const harness = fs.readFileSync(".context/desktop-benchmark/viewer.js", "utf8");
const container = process.env.KITTYD_TEST_CONTAINER || "kitties-desktop-build";
assert(/^kitties-desktop-[a-z0-9-]+$/.test(container));
const kittyId = "browser-" + crypto.randomUUID(),
  token = crypto.randomUUID() + crypto.randomUUID();
const tokenHash = await crypto.subtle
  .digest("SHA-256", new TextEncoder().encode(token))
  .then((b) => Buffer.from(b).toString("hex"));
const config = {
  kittyId,
  remoteId: "bx_browser_fixture",
  generation: 1,
  tokenVersion: 1,
  tokenHash,
};
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
const configPath = work + "/" + kittyId + ".json";
fs.writeFileSync(
  configPath,
  JSON.stringify({
    ...config,
    token,
    url: `ws://localhost:1338/guest/${kittyId}/control`,
    database: `/tmp/${kittyId}.db`,
    display: ":97",
  }),
  { mode: 0o600 },
);
const guest = spawn(
  "docker",
  [
    "exec",
    "-e",
    "KITTYD_CONFIG=/work/" + configPath,
    "-e",
    "KITTYD_FIXTURE=/work/guest/kittyd/tests/desktop-motion.py",
    container,
    "xvfb-run",
    "--server-num=97",
    "-s",
    "-screen 0 1280x800x24",
    "bash",
    "/work/guest/kittyd/tests/run-benchmark-guest.sh",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
const guestLog = fs.createWriteStream(work + "/guest.log");
guest.stdout.pipe(guestLog);
guest.stderr.pipe(guestLog);
const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessPermissionPolicy",
  ],
});
const reports = [];
try {
  for (let i = 0; i < 100; i++) {
    if ((await (await fetch(`${base}/v1/kitties/${kittyId}/desktop`)).json()).guestConnected) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const delays = process.argv.includes("--reverse") ? [350, 200, 100, 0] : [0, 100, 200, 350];
  for (const rttMs of delays) {
    const context = await browser.newContext({ viewport: { width: 1350, height: 1050 } });
    await context.addInitScript(() => {
      window.motion = {
        ages: [],
        visibleAges: [],
        intervals: [],
        lastPaint: 0,
        lastStamp: 0,
        bytes: 0,
        keys: 0,
        measuring: false,
      };
      setInterval(() => {
        const state = window.motion;
        if (state.measuring && state.lastStamp) {
          const age = ((Date.now() >>> 0) - state.lastStamp) >>> 0;
          if (age < 5000) state.visibleAges.push(age);
        }
      }, 16);
      // oxlint-disable-next-line typescript/unbound-method -- apply restores this below.
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        draw.apply(this, args);
        if (this.canvas.width !== 1280 || !window.motion.measuring) return;
        let stamp = 0;
        const row = this.getImageData(40, 156, 32 * 24, 1).data;
        for (let bit = 0; bit < 32; bit++)
          if (row[(bit * 24 + 12) * 4] > 127) stamp = (stamp | (1 << bit)) >>> 0;
        const age = ((Date.now() >>> 0) - stamp) >>> 0,
          state = window.motion,
          now = performance.now();
        if (stamp === state.lastStamp || age > 5000) return;
        state.lastStamp = stamp;
        state.ages.push(age);
        if (state.lastPaint) state.intervals.push(now - state.lastPaint);
        state.lastPaint = now;
      };
    });
    const page = await context.newPage();
    let frames = 0,
      keys = 0,
      bytes = 0,
      measuring = false,
      closed = false;
    const timers = new Set();
    const later = (action) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!closed) action();
      }, rttMs / 2);
      timers.add(timer);
    };
    await page.routeWebSocket("**/desktop/video", (peer) => {
      const server = peer.connectToServer();
      server.onMessage((message) => {
        if (typeof message !== "string" && measuring) {
          frames++;
          bytes += message.length;
          if (message[5] & 1) keys++;
        }
        later(() => peer.send(message));
      });
      peer.onMessage((message) => later(() => server.send(message)));
    });
    await page.route("**/desktop-fixture**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<body style="background:#111821;color:white"><script type="module" src="/viewer-fixture.js"></script></body>',
      }),
    );
    await page.route("**/viewer-fixture.js", (route) =>
      route.fulfill({ contentType: "application/javascript", body: harness }),
    );
    await page.goto(`${base}/desktop-fixture?id=${kittyId}&lang=en`);
    await page.getByText("Live video", { exact: true }).waitFor({ timeout: 15000 });
    await page.waitForTimeout(2500);
    measuring = true;
    await page.evaluate(() => {
      window.motion.measuring = true;
    });
    await page.waitForTimeout(8000);
    const stats = await page.evaluate(() => {
      window.motion.measuring = false;
      return window.motion;
    });
    measuring = false;
    assert(stats.ages.length > 10, "video stopped presenting");
    assert(stats.visibleAges.length > 100, "insufficient visible-age samples");
    const percentile = (values, fraction) =>
      Math.round(values.sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)] * 10) /
      10;
    const report = {
      rttMs,
      sampleSeconds: 8,
      drawn: stats.ages.length,
      fps: stats.ages.length / 8,
      visibleAgeP95Ms: percentile(stats.visibleAges, 0.95),
      frameAgeP50Ms: percentile(stats.ages, 0.5),
      frameAgeP95Ms: percentile(stats.ages, 0.95),
      updateGapP95Ms: percentile(stats.intervals, 0.95),
      updateGapMaxMs: Math.round(Math.max(...stats.intervals)),
      deliveredFrames: frames,
      keyframes: keys,
      bytes,
    };
    reports.push(report);
    console.log(JSON.stringify(report));
    if (rttMs === 200) await page.screenshot({ path: work + "/motion-200ms.png" });
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    await context.close();
    await new Promise((r) => setTimeout(r, 500));
  }
  const report = {
    date: new Date().toISOString(),
    scope:
      "Real voxl + kittyd + local workerd + actual Preact viewer in Chrome; synthetic Xvfb continuous updates. Playwright delays video and acknowledgement delivery equally. No network bandwidth/loss constraint; no model time.",
    reports,
  };
  const label = process.env.KITTIES_MOTION_LABEL ?? "baseline";
  assert(/^[a-z0-9-]+$/.test(label));
  fs.writeFileSync(`${work}/${label}.json`, JSON.stringify(report, null, 2) + "\n");
} finally {
  await browser.close();
  // Only this synthetic daemon and display. The test never touches Boat or user state.
  if (fs.existsSync(configPath + ".pid")) {
    const pid = fs.readFileSync(configPath + ".pid", "utf8").trim();
    assert(/^[0-9]+$/.test(pid));
    await new Promise((resolve) => {
      const p = spawn("docker", ["exec", container, "kill", "-TERM", pid]);
      p.on("close", resolve);
    });
  }
  guest.kill();
  fs.rmSync(configPath, { force: true });
}
