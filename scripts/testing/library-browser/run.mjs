// Local production-asset browser proof; authentication is the explicit native fixture.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import { dirname, extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { Schema } from "effect";

const root = resolve(import.meta.dirname, "../../..");

const directory = join(
  root,
  ".context/library-browser-check",
  `${Date.now()}-${randomUUID().slice(0, 8)}`,
);

mkdirSync(directory, { recursive: true });

const nativeDirectory = join(
  root,
  ".context/library-http-check",
  `browser-${Date.now()}-${randomUUID().slice(0, 8)}`,
);

mkdirSync(nativeDirectory, { recursive: true });

const dist = join(root, "apps/web/dist");

assert.ok(
  readFileSync(join(dist, "library.html"), "utf8").includes("/assets/library-"),
  "Build the shared production frontend first",
);

const results = [];
const events = [];
const errors = [];
let browser;
let server;
let upstream;
let failure;
let hostOutput = "";
let hostErrors = "";
const pending = new Map();

const deadline = (promise, ms, label) => {
  let timer;

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`${label}: ${ms}ms deadline`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

const host = spawn(
  process.execPath,
  [join(root, "scripts/testing/library-http/host.mjs"), nativeDirectory],
  {
    cwd: root,
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      LANG: "C.UTF-8",
      CI: "1",
      NO_COLOR: "1",
      TMPDIR: nativeDirectory,
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

const closed = once(host, "close");
let buffer = "";

host.stdout.on("data", (chunk) => {
  hostOutput += chunk;
  buffer += chunk;
  let end;

  while ((end = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);

    try {
      const event = JSON.parse(line);
      events.push(event);
      pending.get(event.event)?.(event);
      pending.delete(event.event);
    } catch {
      /* ordinary runtime text is retained in host.log */
    }
  }
});

host.stderr.on("data", (chunk) => {
  hostErrors += chunk;
});

const wait = (name) =>
  events.find((event) => event.event === name) ??
  new Promise((resolve) => pending.set(name, resolve));

const fixture = async (action, extra = {}) => {
  const response = await fetch(new URL("/fixture", upstream), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...extra }),
    signal: AbortSignal.timeout(15000),
  });

  const reply = await response.json();
  assert.equal(reply.ok, true, reply.error);

  return reply.value;
};

const assertGroupClosed = () => {
  try {
    process.kill(-host.pid, 0);
  } catch (error) {
    if (!Schema.is(Schema.Struct({ code: Schema.Literal("ESRCH") }))(error)) throw error;
    events.push({ event: "process-group-clean", pid: host.pid });

    return;
  }

  throw Error("Owned process group still exists after scoped host shutdown");
};

try {
  const ready = await deadline(
    Promise.race([
      wait("ready"),
      closed.then(() => {
        throw Error(`Native host exited: ${hostErrors}`);
      }),
    ]),
    90000,
    "native host startup",
  );

  upstream = new URL(ready.url);
  assert.equal(upstream.hostname, "127.0.0.1");
  await fixture("initialize");
  const session = await fixture("issue", { ttlMs: 60000 });
  execFileSync(
    process.env.KITTIES_OPENSSL ?? "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
    ],
    { stdio: "ignore" },
  );

  const mime = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
  };

  let origin;
  server = createServer(
    {
      key: readFileSync(join(directory, "key.pem")),
      cert: readFileSync(join(directory, "cert.pem")),
    },
    async (request, response) => {
      const url = new URL(request.url, origin);

      if (url.pathname.startsWith("/v1/library/")) {
        // The loopback-only fixture receives its own origin after local TLS termination.
        // Access signature/Origin verification is covered separately; this is not provider authentication.
        const headers = { ...request.headers, host: upstream.host };

        if (headers.origin === origin) headers.origin = upstream.origin;

        const proxy = httpRequest(
          new URL(request.url, upstream),
          { method: request.method, headers },
          (reply) => {
            response.writeHead(reply.statusCode, reply.headers);
            reply.pipe(response);
            response.on("close", () => reply.destroy());
          },
        );

        proxy.on("error", () => {
          if (!response.headersSent) response.writeHead(502);
          response.end();
        });
        request.pipe(proxy);
        request.on("aborted", () => proxy.destroy());

        return;
      }

      const path = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);

      if (!path.startsWith(dist + "/")) {
        response.writeHead(404);
        response.end();

        return;
      }

      try {
        const bytes = await readFile(path);
        response.writeHead(200, {
          "content-type": mime[extname(path)] ?? "application/octet-stream",
          "cache-control": "no-store",
        });
        response.end(bytes);
      } catch {
        response.writeHead(404);
        response.end();
      }
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `https://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.KITTIES_BROWSER ?? "/opt/google/chrome/chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: "en-US",
    viewport: { width: 1200, height: 900 },
    extraHTTPHeaders: { "x-local-session": session.key },
  });

  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  page.setDefaultTimeout(15000);
  await page.goto(origin + "/library.html");
  await page
    .getByText("No skills yet. Propose your first instructions below.", { exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("kitties.device-preferences.v1")),
    null,
  );
  results.push("production assets boot the shared Foldkit screen without writing defaults");
  await page.getByLabel("Name", { exact: true }).fill("Browser instructions");
  await page
    .getByLabel("Instructions", { exact: true })
    .fill("Keep the original intent.\nReview before accepting.");
  await page.getByRole("button", { name: "Propose skill", exact: true }).click();
  await page.getByRole("button", { name: "Review · Browser instructions", exact: true }).click();
  await page.getByRole("button", { name: "Accept", exact: true }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await page
    .getByRole("region", { name: "Review instructions", exact: true })
    .getByText("Accepted", { exact: true })
    .waitFor();
  const second = await context.newPage();
  await second.goto(origin + "/library.html");
  await second
    .getByRole("button", { name: "Review · Browser instructions", exact: true })
    .waitFor();
  await page.screenshot({ path: join(directory, "desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await second
    .getByText("No skills yet. Propose your first instructions below.", { exact: true })
    .waitFor();
  results.push("proposal, receipt-gated detail, acceptance and removal update another browser tab");
  await page.getByLabel("Language", { exact: true }).selectOption("es");
  await page.getByRole("heading", { name: "Biblioteca", exact: true }).waitFor();
  await page.getByRole("button", { name: "Guardar preferencias", exact: true }).click();

  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("kitties.device-preferences.v1")),
  );

  assert.deepEqual(saved, { version: 1, language: "es", theme: "dark" });
  await page.reload();
  await page.getByRole("heading", { name: "Biblioteca", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  await page.keyboard.press("Tab");
  assert.notEqual(await page.evaluate(() => document.activeElement.tagName), "BODY");
  await page.screenshot({ path: join(directory, "mobile.png"), fullPage: true });
  results.push(
    "explicit preference save survives reload; Spanish mobile layout and keyboard focus work",
  );
  await second.goto(origin + "/");
  await second.getByRole("button", { name: "Cambiar tema", exact: true }).waitFor();
  assert.equal(await second.getByLabel("Language", { exact: true }).inputValue(), "es");
  assert.equal(await second.evaluate(() => document.documentElement.dataset.mode), "dark");
  await second.getByRole("button", { name: "Cambiar tema", exact: true }).click();
  await second.locator('html[data-mode="light"]').waitFor();
  await second.getByLabel("Language", { exact: true }).selectOption("pt");
  await second.waitForFunction(() => document.documentElement.lang === "pt");
  assert.deepEqual(
    await second.evaluate(() => JSON.parse(localStorage.getItem("kitties.device-preferences.v1"))),
    {
      version: 1,
      language: "pt",
      theme: "light",
    },
  );
  await page.reload();
  await page.getByRole("heading", { name: "Biblioteca", exact: true }).waitFor();
  assert.equal(await page.locator("main").getAttribute("lang"), "pt");
  assert.equal(await page.locator("main").getAttribute("data-theme"), "light");
  results.push(
    "legacy shell and Foldkit share acknowledged preferences without overwriting the other field",
  );
  await second.close();
  await context.close();
  const short = await fixture("issue", { ttlMs: 1600 });

  const expiryContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: "en-US",
    extraHTTPHeaders: { "x-local-session": short.key },
  });

  const expiring = await expiryContext.newPage();
  expiring.setDefaultTimeout(15000);
  await expiring.goto(origin + "/library.html");
  await expiring
    .getByText("No skills yet. Propose your first instructions below.", { exact: true })
    .waitFor();
  await expiring.getByLabel("Name", { exact: true }).fill("Retained draft");
  await expiring.getByRole("button", { name: "Sign in again", exact: true }).waitFor();
  assert.equal(await expiring.getByLabel("Name", { exact: true }).inputValue(), "Retained draft");
  const fresh = await fixture("issue", { ttlMs: 60000 });
  await expiryContext.setExtraHTTPHeaders({ "x-local-session": fresh.key });
  await expiring.getByRole("button", { name: "Sign in again", exact: true }).click();
  await expiring.getByText("Live library", { exact: true }).waitFor();
  assert.equal(await expiring.getByLabel("Name", { exact: true }).inputValue(), "Retained draft");
  results.push("idle session expiry disables editing and reconnect preserves the draft");
  assert.deepEqual(errors, []);
} catch (error) {
  failure = { error: String(error), stack: error.stack };
  process.exitCode = 1;
} finally {
  await browser?.close();
  server?.closeAllConnections();

  if (server?.listening) await new Promise((resolve) => server.close(resolve));

  if (host.exitCode === null && !host.signalCode) host.kill("SIGTERM");

  try {
    const [code, signal] = await deadline(closed, 15000, "native host shutdown");
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.equal(
      events.some((event) => event.event === "engine-files-unchanged" && event.unchanged),
      true,
    );

    assertGroupClosed();
  } catch (error) {
    try {
      process.kill(-host.pid, "SIGKILL");
    } catch {
      /* owned group already exited */
    }

    failure ??= { error: String(error), stack: error.stack };
    process.exitCode = 1;
  }

  writeFileSync(join(directory, "host.log"), hostOutput);
  writeFileSync(join(directory, "host.stderr.log"), hostErrors);
  writeFileSync(
    join(directory, "results.json"),
    JSON.stringify(
      { verdict: failure ? "FAIL" : "PASS", nativeDirectory, results, failure, errors, events },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ verdict: failure ? "FAIL" : "PASS", directory, results, failure }));
}
