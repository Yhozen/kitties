// Real packaged WebKit controller. Readiness waits observe lifecycle milestones;
// assertions execute once, against independent expected product/IPC results.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import * as Schema from "effect/Schema";

const binary = resolve(process.argv[2]);
const output = resolve(process.argv[3] ?? "/research/logs/feasibility-runtime");

mkdirSync(output, { recursive: true });

const observations = [];
const cases = [];
let failure = null;
let sessionId;
let driver;
let base;
let driverLog = "";
const Envelope = Schema.Struct({ value: Schema.Json });
const Session = Schema.Struct({ sessionId: Schema.String });
const Element = Schema.Struct({ "element-6066-11e4-a52e-4f735466cecf": Schema.String });

const Page = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
  ready: Schema.String,
  text: Schema.String,
  language: Schema.NullOr(Schema.String),
  theme: Schema.NullOr(Schema.String),
  preferencesStatus: Schema.String,
});

const Ipc = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.Json }),
]);

const deadline = async (promise, ms, label) => {
  let timer;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`Deadline: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));

const freePort = async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(server.address());
  const port = address.port;
  server.close();
  await once(server, "close");

  return port;
};

const request = async (method, path, body) => {
  const options = {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(25000),
  };

  if (body !== undefined) options.body = JSON.stringify(body);

  const response = await fetch(`${base}${path}`, options);

  const envelope = Schema.decodeUnknownSync(Schema.fromJsonString(Envelope))(await response.text());

  if (!response.ok)
    throw Error(`WebDriver ${method} ${path} refused: ${JSON.stringify(envelope.value)}`);

  return envelope.value;
};

const until = async (observe, label, ms = 15000) => {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const value = await observe();

    if (value !== undefined) return value;
    await pause(100);
  }

  throw Error(`Milestone not reached: ${label}`);
};

const script = (source, args = []) =>
  request("POST", `/session/${sessionId}/execute/sync`, { script: source, args });

const page = async () =>
  Schema.decodeUnknownSync(Page)(
    await script(`return {
  title:document.title, url:location.href, ready:document.readyState, text:document.body.innerText,
  language:document.querySelector('#library-host-language')?.value ?? null,
  theme:document.querySelector('#library-host-theme')?.value ?? null,
  preferencesStatus:document.querySelector('[aria-label="Preference status"],[aria-label="Estado de las preferencias"]')?.textContent ?? ''
};`),
  );

const settledPage = () =>
  until(async () => {
    const current = await page();

    return current.ready === "complete" &&
      current.language !== null &&
      (current.text.includes("Try connecting again.") ||
        current.text.includes("Intenta conectarte de nuevo."))
      ? current
      : undefined;
  }, "shared Library shell and terminal connection outcome");

const click = async (selector) => {
  const element = Schema.decodeUnknownSync(Element)(
    await request("POST", `/session/${sessionId}/element`, {
      using: "css selector",
      value: selector,
    }),
  );

  await request(
    "POST",
    `/session/${sessionId}/element/${element["element-6066-11e4-a52e-4f735466cecf"]}/click`,
    {},
  );
};

const ipc = async (command, args = {}) =>
  Schema.decodeUnknownSync(Ipc)(
    await request("POST", `/session/${sessionId}/execute/async`, {
      script: `const done=arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(value=>done({ok:true,value}),error=>done({ok:false,error}));`,
      args: [command, args],
    }),
  );

const open = async () => {
  const raw = await request("POST", "/session", {
    capabilities: { alwaysMatch: { "tauri:options": { application: binary } } },
  });

  sessionId = Schema.decodeUnknownSync(Session)(raw).sessionId;
  await request("POST", `/session/${sessionId}/timeouts`, {
    script: 10000,
    pageLoad: 15000,
    implicit: 0,
  });
};

const close = async () => {
  if (sessionId !== undefined) {
    const closing = sessionId;
    sessionId = undefined;
    await request("DELETE", `/session/${closing}`);
  }
};

const screenshot = async (name) => {
  const data = Schema.decodeUnknownSync(Schema.String)(
    await request("GET", `/session/${sessionId}/screenshot`),
  );

  writeFileSync(join(output, name), Buffer.from(data, "base64"));
};

try {
  const port = await freePort();
  const nativePort = await freePort();
  base = `http://127.0.0.1:${port}`;
  driver = spawn(
    "/research/tools/bin/tauri-driver",
    [
      "--port",
      String(port),
      "--native-port",
      String(nativePort),
      "--native-driver",
      "/usr/bin/WebKitWebDriver",
    ],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  driver.stdout.on("data", (chunk) => {
    driverLog += chunk;
  });
  driver.stderr.on("data", (chunk) => {
    driverLog += chunk;
  });
  await until(async () => {
    try {
      const value = await request("GET", "/status");

      return value === null ? undefined : value;
    } catch {
      return undefined;
    }
  }, "official native WebDriver listening");
  await open();
  const initial = await settledPage();
  observations.push({ phase: "initial", page: initial });
  assert.equal(initial.url, "tauri://localhost/library.html");
  assert.equal(initial.language, "en");
  assert.equal(initial.theme, "dark");
  assert(initial.text.includes("Your skill library"));
  assert(initial.text.includes("Your library is unavailable. Try connecting again."));
  assert.equal((await ipc("native_access_configuration")).ok, false);
  assert.deepEqual(await ipc("read_device_preferences"), { ok: true, value: { status: "absent" } });
  cases.push("packaged shared Library/no-config fail-closed shell");

  for (const [command, args] of [
    ["plugin:store|load", { path: "arbitrary.json" }],
    ["plugin:opener|open_url", { url: "https://example.invalid" }],
    [
      "plugin:http|fetch",
      {
        clientConfig: {
          method: "GET",
          url: "https://example.invalid/v1/library/session",
          headers: [],
          data: null,
        },
      },
    ],
  ]) {
    const result = await ipc(command, args);
    assert.equal(result.ok, false);
    assert(JSON.stringify(result).includes("not allowed"));
  }

  cases.push("real main WebView denies arbitrary Store/opener/HTTP IPC");
  await screenshot("initial.png");
  await click('#library-host-language option[value="es"]');
  await click('#library-host-theme option[value="light"]');
  await click('form button[type="submit"]');

  const saved = await until(async () => {
    const current = await page();

    return current.preferencesStatus.includes("guardadas") ||
      current.preferencesStatus.includes("No se pudieron") ||
      current.preferencesStatus.includes("agotó")
      ? current
      : undefined;
  }, "preference save terminal acknowledgement");

  assert.equal(saved.language, "es");
  assert.equal(saved.theme, "light");
  assert.equal(saved.preferencesStatus, "Preferencias guardadas en este dispositivo.");
  assert.deepEqual(await ipc("read_device_preferences"), {
    ok: true,
    value: { status: "found", preferences: { version: 1, language: "es", theme: "light" } },
  });

  const disk = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
    readFileSync(
      join(process.env.XDG_DATA_HOME, "app.kitties.desktop/device-preferences.v1.json"),
      "utf8",
    ),
  );

  assert.deepEqual(disk, { preferences: { version: 1, language: "es", theme: "light" } });
  observations.push({ phase: "saved", page: saved });
  await screenshot("saved.png");
  cases.push("shared UI explicitly saves preferences through real custom native IPC");
  await close();
  await open();
  const restored = await settledPage();
  assert.equal(restored.language, "es");
  assert.equal(restored.theme, "light");
  assert(restored.text.includes("Tu biblioteca de habilidades"));
  assert.deepEqual(await ipc("read_device_preferences"), {
    ok: true,
    value: { status: "found", preferences: { version: 1, language: "es", theme: "light" } },
  });
  observations.push({ phase: "relaunched", page: restored });
  await screenshot("relaunched.png");
  cases.push("packaged process restart reloads acknowledged native preferences");
} catch (cause) {
  failure = cause instanceof Error ? cause.message : String(cause);
} finally {
  try {
    await close();
  } catch (cause) {
    failure ??= `Session cleanup: ${String(cause)}`;
  }

  if (driver !== undefined) {
    const closed = once(driver, "close");
    driver.kill("SIGTERM");

    try {
      await deadline(closed, 5000, "owned driver close");
    } catch (cause) {
      try {
        process.kill(-driver.pid, "SIGKILL");
      } catch {}

      failure ??= String(cause);
      await deadline(closed, 3000, "owned driver forced close").catch(() => {});
    }
  }

  writeFileSync(join(output, "driver.log"), driverLog);

  const result = {
    status: failure === null ? "PASS" : "FAIL",
    binary,
    binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
    cases,
    observations,
    failure,
    scope:
      "Feasibility package/current shared assets; no live Access authentication or final source-ready claim",
  };

  writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));

  if (failure !== null) process.exitCode = 1;
}
