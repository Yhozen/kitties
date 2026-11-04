// Actual Preact component + Chrome file selection, drop, download and cancellation.
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
const require = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
execFileSync("bun", [
  "guest/kittyd/tests/build-viewer-fixture.ts",
  "apps/web/e2e-next/files-fixture.tsx",
  "files.js",
]);
const code = readFileSync(".context/desktop-benchmark/files.js", "utf8");
const css = readFileSync("apps/web/src/next.css", "utf8");
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({
  acceptDownloads: true,
  viewport: { width: 1100, height: 800 },
});
const page = await context.newPage(),
  errors = [],
  passed = [];
page.on("pageerror", (error) => errors.push(error.message));
const data = Buffer.alloc(6 * 1024 * 1024);
for (let i = 0; i < data.length; i++) data[i] = i % 256;
let uploads = 0,
  mode = "ok",
  finishSlow;
const entries = [];
try {
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/files.js")
      return route.fulfill({ contentType: "application/javascript", body: code });
    if (url.pathname === "/v1/artifacts")
      return json([{ id: "library", name: "Planning notes.txt", size: 14, updatedAt: 1 }]);
    if (url.pathname.endsWith("/files/download"))
      return route.fulfill({
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(data.length),
        },
        body: data,
      });
    if (url.pathname.endsWith("/files/from-library")) {
      assert.equal(url.searchParams.get("artifact"), "library");
      assert.equal(url.searchParams.get("generation"), "3");
      return json({}, 201);
    }
    if (url.pathname.endsWith("/files")) {
      if (request.method() === "GET")
        return json({ path: "", generation: 3, files: entries, truncated: false });
      uploads++;
      if (mode === "slow")
        await new Promise((resolve) => {
          finishSlow = resolve;
        });
      if (mode === "error") return json({ code: "COMPUTER_CHANGED" }, 409);
      if (request.postDataBuffer()?.length === data.length)
        assert(request.postDataBuffer().equals(data));
      assert.equal(url.searchParams.get("generation"), "3");
      entries.push({
        name: url.searchParams.get("name"),
        path: url.searchParams.get("name"),
        size: Number(request.headers()["x-file-size"]),
        directory: false,
        modifiedAt: new Date().toISOString(),
      });
      return json({}, 201);
    }
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><style>body{background:#121419;color:#e5e7eb;font:16px system-ui;padding:24px}button{background:#272b33;color:inherit;border:1px solid #555;border-radius:8px;padding:8px 14px;cursor:pointer}button:disabled{opacity:.5}small{color:#aaa}progress{accent-color:#87b8a1}#app{max-width:960px;margin:auto}${css}</style><div id="app"></div><script type="module" src="/files.js"></script>`,
    });
  });
  await page.goto("http://localhost:17777/fixture?lang=en");
  await page.getByText("No shared files yet.").waitFor();
  await page.locator("input[type=file]").setInputFiles({
    name: "Binary sample.bin",
    mimeType: "application/octet-stream",
    buffer: data,
  });
  await page.getByText("Transfer complete.", { exact: true }).waitFor();
  assert.equal(uploads, 1);
  passed.push("6 MiB binary upload with real XMLHttpRequest");
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), "Binary sample.bin");
  assert(readFileSync(await download.path()).equals(data));
  passed.push("byte-identical download with original filename");
  await page.getByText("Send a Library file to this desktop", { exact: true }).click();
  await page.getByRole("button", { name: "Send to desktop", exact: true }).click();
  await page.getByText("Transfer complete.", { exact: true }).waitFor();
  passed.push("Library-to-desktop action carries generation");
  await page.locator(".desktop-files").evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File(["drop"], "Dropped.txt"));
    el.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
  });
  await page.getByText("Dropped.txt", { exact: true }).waitFor();
  assert.equal(uploads, 2);
  passed.push("drag and drop upload");
  mode = "error";
  await page
    .locator("input[type=file]")
    .setInputFiles({ name: "stale.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  await page.getByRole("alert").filter({ hasText: "The computer changed." }).waitFor();
  await page.waitForTimeout(200);
  assert.equal(uploads, 3);
  passed.push("stale generation error persists through refresh; no replay");
  mode = "slow";
  await page
    .locator("input[type=file]")
    .setInputFiles({ name: "cancel.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  await page.getByRole("button", { name: "Cancel transfer" }).click();
  await page.getByRole("alert").filter({ hasText: "Transfer stopped." }).waitFor();
  finishSlow?.();
  await page.waitForTimeout(200);
  assert.equal(uploads, 4);
  passed.push("cancel stops client and explains uncertain delivery");
  mode = "ok";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("Binary sample.bin", { exact: true }).waitFor();
  mkdirSync(".context/desktop-files", { recursive: true });
  await page.screenshot({ path: ".context/desktop-files/shared-files.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  passed.push("mobile width without horizontal overflow");
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    status: "passed",
    scope: "Actual Preact component and headless Chrome; HTTP provider responses mocked",
    checks: passed,
  };
  writeFileSync(".context/desktop-files/browser.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  finishSlow?.();
  await browser.close();
}
