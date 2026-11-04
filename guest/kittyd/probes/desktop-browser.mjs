import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
// Dedicated Ubuntu test container with this repository mounted at /work only.
// The fixture and daemon are separate from all real Kitties/Boat desktops.
const base = "http://localhost:1337";
const work = ".context/desktop-benchmark";
fs.mkdirSync(work, { recursive: true });
execFileSync("bun", ["guest/kittyd/tests/build-viewer-fixture.ts"]);
const harness = fs.readFileSync(work + "/viewer.js", "utf8");
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
  for (let i = 0; i < 50; i++) {
    const status = await (await fetch(`${base}/v1/kitties/${kittyId}/desktop`)).json();
    if (status.guestConnected) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const mode of process.argv.includes("--reverse") ? ["video", "jpeg"] : ["jpeg", "video"]) {
    const context = await browser.newContext({ viewport: { width: 1350, height: 1050 } });
    await context.addInitScript((mode) => {
      if (mode === "jpeg") Object.defineProperty(window, "VideoDecoder", { value: undefined });
      window.stats = { samples: [], frames: 0, bytes: 0, count: -1, pending: 0 };
      const NativeWS = window.WebSocket;
      window.WebSocket = class extends NativeWS {
        constructor(...args) {
          super(...args);
          if (/\/(frames|video)$/.test(String(args[0])))
            this.addEventListener("message", (e) => {
              if (e.data instanceof ArrayBuffer) window.stats.bytes += e.data.byteLength;
            });
        }
      };
      // The wrapper below explicitly restores the original context with apply.
      // oxlint-disable-next-line typescript/unbound-method
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        draw.apply(this, args);
        if (this.canvas.width !== 1280) return;
        const s = window.stats;
        let count = 0;
        for (let bit = 0; bit < 16; bit++)
          if (this.getImageData(52 + bit * 24, 136, 1, 1).data[0] > 127) count |= 1 << bit;
        s.frames++;
        if (s.count !== count && s.pending) {
          s.samples.push(performance.now() - s.pending);
          s.pending = 0;
        }
        s.count = count;
      };
      document.addEventListener(
        "click",
        (e) => {
          if (e.target instanceof HTMLCanvasElement) window.stats.pending = performance.now();
        },
        true,
      );
    }, mode);
    const page = await context.newPage();
    page.on("pageerror", (error) => console.log("fixture page error", error.message));
    page.on("console", (message) => {
      if (message.type() === "error") console.log("fixture console", message.text());
    });
    await page.route("**/desktop-fixture**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<html><body style="margin:24px;background:#0e141c;color:#ddd;font-family:system-ui"><script type="module" src="/viewer-fixture.js"></script></body></html>',
      }),
    );
    await page.route("**/viewer-fixture.js", (route) =>
      route.fulfill({ contentType: "application/javascript", body: harness }),
    );
    await page.goto(`${base}/desktop-fixture?id=${kittyId}&lang=en`);
    await page.waitForFunction(() => window.stats.frames > 0, { timeout: 15000 });
    await page.getByRole("button", { name: "Tomar control", exact: true }).click();
    await page.getByRole("button", { name: "Devolver control", exact: true }).waitFor();
    await page.evaluate(() => {
      window.stats.bytes = 0;
      window.stats.frames = 0;
    });
    for (let index = 0; index < 60; index++) {
      await page.locator("canvas").click({ position: { x: 900, y: 500 } });
      await page.waitForFunction((n) => window.stats.samples.length >= n, index + 1, {
        timeout: 5000,
      });
      await page.waitForTimeout(45 + (index % 5) * 13);
    }
    const stats = await page.evaluate(() => window.stats);
    const sorted = stats.samples.sort((a, b) => a - b);
    reports.push({
      mode,
      count: sorted.length,
      p50Ms: +sorted[29].toFixed(2),
      p95Ms: +sorted[56].toFixed(2),
      samplesMs: sorted.map((value) => +value.toFixed(2)),
      bytes: stats.bytes,
      frames: stats.frames,
    });
    await page.screenshot({ path: `${work}/desktop-${mode}.png` });
    await context.close();
    await new Promise((r) => setTimeout(r, 1000));
  }
  const report = {
    date: new Date().toISOString(),
    scope:
      "Chrome headless + local workerd + real kittyd + Ubuntu 24.04 Xvfb 1280x800. Same host; excludes public network and model time.",
    metric: "Browser click event to decoded canvas containing the changed fixture counter",
    reports,
  };
  fs.writeFileSync(
    work + "/result" + (process.argv.includes("--reverse") ? "-reverse" : "") + ".json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
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
