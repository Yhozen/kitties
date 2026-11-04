import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
execFileSync("bun", ["guest/kittyd/tests/build-viewer-fixture.ts"]);
const code = readFileSync(".context/desktop-benchmark/viewer.js", "utf8");
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  for (const test of ["silent-picture", "missing-receipt", "timely-receipt"]) {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      Object.defineProperty(window, "VideoDecoder", { value: undefined });
    });
    const page = await context.newPage();
    const errors = [],
      inputs = [];
    let connections = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) =>
      route.fulfill({
        contentType: route.request().url().endsWith("viewer.js")
          ? "application/javascript"
          : "text/html",
        body: route.request().url().endsWith("viewer.js")
          ? code
          : '<script type="module" src="/viewer.js"></script>',
      }),
    );
    await page.routeWebSocket("**/desktop/control", (peer) => {
      connections++;
      peer.send(JSON.stringify({ type: "connected", generation: 3, epoch: 7 }));
      peer.onMessage((message) => {
        if (message === "ping") return;
        const body = JSON.parse(message);
        if (body.type === "grant")
          peer.send(
            JSON.stringify({
              type: "grant",
              receipt: { nonce: "fixture", generation: 3, epoch: 7 },
            }),
          );
        if (body.type === "input") {
          inputs.push(body);
          if (test === "timely-receipt")
            peer.send(
              JSON.stringify({ type: "ack", intentId: body.intentId, status: "completed" }),
            );
        }
      });
    });
    await page.routeWebSocket("**/desktop/frames", async (peer) => {
      if (test === "silent-picture") return;
      const image = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 16;
        canvas.getContext("2d").fillRect(0, 0, 16, 16);
        return canvas.toDataURL("image/jpeg").split(",")[1];
      });
      const frame = Buffer.concat([Buffer.alloc(8), Buffer.from(image, "base64")]);
      frame.writeUInt32BE(3);
      frame.writeUInt32BE(1, 4);
      peer.send(frame);
    });
    await page.goto("http://localhost:17777/fixture?id=static&lang=en");
    await page.waitForFunction(() => document.querySelector("canvas"));
    if (test === "silent-picture") {
      assert.notEqual(await page.locator("header strong").innerText(), "Conectado");
      await page.waitForTimeout(7000);
      assert(connections >= 2, "missing first JPEG reconnects");
    } else {
      await page.getByText("Conectado", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Tomar control", exact: true }).click();
      await page.getByRole("button", { name: "Devolver control", exact: true }).waitFor();
      for (let i = 0; i < 3; i++) await page.locator("canvas").click({ position: { x: 4, y: 4 } });
      await page.waitForTimeout(14000);
      if (test === "missing-receipt") {
        assert.equal(inputs.length, 1, "uncertain and queued inputs never replay");
        assert(connections >= 2);
        await page.getByRole("button", { name: "Tomar control", exact: true }).waitFor();
        assert(!/entradas pendientes/.test(await page.locator("header").innerText()));
      } else {
        assert.equal(inputs.length, 3);
        assert.equal(connections, 1, "receipt cancels input deadline");
      }
    }
    assert.deepEqual(errors, []);
    console.log(test + " passed");
    await context.close();
  }
} finally {
  await browser.close();
}
