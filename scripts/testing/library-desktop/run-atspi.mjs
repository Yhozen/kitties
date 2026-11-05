// OS input/accessibility controller for the real packaged, incognito application.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as Schema from "effect/Schema";

const binary = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const development = process.argv[4] === "development";
const desktop = "/research/inputs/workspace/apps/desktop";
const helper = process.env.KITTIES_ACCESSIBILITY_HELPER;
const store = join(process.env.XDG_DATA_HOME, "app.kitties.desktop/device-preferences.v1.json");
const expected = { preferences: { version: 1, language: "es", theme: "light" } };
const cases = [];
const developmentRequests = [];
let app;
let appClosed;
let failure = null;
let appLog = "";

const os = (...args) =>
  execFileSync(helper, args, { encoding: "utf8", timeout: 12000, maxBuffer: 1024 * 1024 });

const until = async (observe, label) => {
  const end = Date.now() + (development ? 180000 : 20000);

  while (Date.now() < end) {
    const value = observe();

    if (value !== undefined) return value;
    await new Promise((resume) => setTimeout(resume, 100));
  }

  throw Error(`Milestone not reached: ${label}`);
};

const open = () => {
  app = development
    ? spawn(
        process.execPath,
        ["node_modules/@tauri-apps/cli/tauri.js", "dev", "--no-watch", "--", "--locked"],
        {
          cwd: desktop,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      )
    : spawn(binary, [], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  app.stdout.on("data", (chunk) => {
    appLog += chunk;
  });
  app.stderr.on("data", (chunk) => {
    appLog += chunk;
  });
  appClosed = new Promise((resolveClose, rejectClose) => {
    app.once("close", (code, signal) => resolveClose({ code, signal }));
    app.once("error", rejectClose);
  });
};

const close = async () => {
  if (app === undefined) return;

  const closing = app;
  let timeout;

  let closeFailure =
    closing.exitCode === null && closing.signalCode === null
      ? undefined
      : Error("Packaged process terminated before the requested stop");

  // The official development CLI owns a Cargo/native child. Stop only this
  // dedicated group so its signal handler cannot wait forever for a live GUI.
  if (development) process.kill(-closing.pid, "SIGTERM");
  else closing.kill("SIGTERM");

  try {
    await Promise.race([
      appClosed,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(Error("Packaged process did not stop")), 5000);
      }),
    ]);
  } catch (cause) {
    closeFailure = cause;
  } finally {
    clearTimeout(timeout);
  }

  try {
    process.kill(-closing.pid, "SIGKILL");
  } catch (cause) {
    if (Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }))(cause).code !== "ESRCH")
      closeFailure ??= cause;
  }

  app = undefined;

  if (closeFailure !== undefined) throw closeFailure;
};

const selected = (tree, name) => {
  const lines = tree.split("\n");
  const index = lines.findIndex((line) => line.trim() === `[menu item] ${name}`);

  return index !== -1 && lines[index + 1]?.trim() === "SELECTED";
};

const treeAt = async (phase, milestone) => {
  const tree = await until(() => {
    const current = os("tree");

    return milestone(current) ? current : undefined;
  }, phase);

  writeFileSync(join(output, `${phase}.txt`), tree);
  await until(() => {
    const colours = Number(os("shot", join(output, `${phase}.png`)));

    return colours > 64 ? true : undefined;
  }, `${phase}: actual painted text and controls`);

  return tree;
};

try {
  if (development) {
    for (const [path, marker] of [
      ["/library.html", "/src/foldkit/library-host/entry.ts"],
      ["/@vite/client", "WebSocket"],
      ["/src/foldkit/library-host/entry.ts", "Runtime.makeApplication"],
    ]) {
      const response = await fetch(`http://localhost:5173${path}`, {
        signal: AbortSignal.timeout(5000),
      });

      assert.equal(response.status, 200, "actual Vite source request must succeed");
      const text = await response.text();
      assert(text.length <= 1024 * 1024);
      assert(text.includes(marker), `Vite source marker must exist: ${path}`);

      if (path === "/library.html") assert(text.includes('src="/@vite/client"'));
      developmentRequests.push({ path, sha256: createHash("sha256").update(text).digest("hex") });
    }
  }

  assert.equal(existsSync(store), false, "fresh profile must have no persisted preferences");
  open();
  const initial = await treeAt("initial", (tree) => tree.includes("Try connecting again."));
  assert(initial.includes("[document frame] Your skill library"));
  assert(initial.includes("[push button] Sign in"));
  assert(selected(initial, "English"));
  assert(selected(initial, "Dark"));
  assert.equal(existsSync(store), false, "load must not silently persist defaults");
  cases.push(
    "real native/shared Library boots without configuration and keeps preferences available",
  );

  os("action", "push button", "Sign in");

  const unavailable = await treeAt(
    "no-config",
    (tree) =>
      tree.includes("Try connecting again.") && /\[push button\] Sign in\n\s+ENABLED/.test(tree),
  );

  assert(unavailable.includes("[combo box] Language"));
  assert.equal(unavailable.includes("[textbox] Skill name"), false);
  cases.push("explicit sign-in stays fail-closed without compiled native configuration");

  os("focus", "combo box", "Language");
  os("key", "Home");
  os("key", "Down");
  os("key", "Escape");
  await until(
    () => (os("tree").includes("[combo box] Apariencia") ? true : undefined),
    "Spanish UI",
  );
  os("focus", "combo box", "Apariencia");
  os("key", "Home");
  os("key", "Down");
  os("key", "Escape");
  const preview = await treeAt("preview", (tree) => selected(tree, "Claro"));
  assert(selected(preview, "Español"));
  assert.equal(existsSync(store), false, "preview must not acknowledge or persist a save");
  os("action", "push button", "Guardar preferencias");

  const saved = await treeAt("saved", (tree) =>
    tree.includes("TEXT Preferencias guardadas en este dispositivo."),
  );

  assert(selected(saved, "Español"));
  assert(selected(saved, "Claro"));
  assert.deepEqual(
    Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(readFileSync(store, "utf8")),
    expected,
  );
  cases.push("OS-controlled shared UI explicitly saves es/light through native fixed-file IPC");
  await close();
  assert.deepEqual(JSON.parse(readFileSync(store, "utf8")), expected);
  open();

  const restored = await treeAt("relaunched", (tree) =>
    tree.includes("Tu biblioteca no está disponible. Intenta conectarte de nuevo."),
  );

  assert(restored.includes("[document frame] Tu biblioteca de habilidades"));
  assert(selected(restored, "Español"));
  assert(selected(restored, "Claro"));
  cases.push("new native process reloads saved preferences from the same private profile");

  if (development) {
    assert(appLog.includes("Running DevCommand"));
    assert(appLog.includes("--no-default-features"));
    assert.equal((appLog.match(/Running DevCommand/g) ?? []).length, 2);
    cases.push(
      "both launches run official CLI development builds against actual Vite source/HMR entry",
    );
  }
} catch (cause) {
  failure = cause instanceof Error ? cause.message : String(cause);
} finally {
  try {
    await close();
  } catch (cause) {
    failure ??= `Cleanup: ${String(cause)}`;
  }

  writeFileSync(join(output, "app.log"), appLog);

  const result = {
    status: failure === null ? "PASS" : "FAIL",
    mode: development ? "tauri-dev-no-watch" : "package",
    developmentRequests,
    binary,
    binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
    cases,
    failure,
    scope: development
      ? "Official tauri dev --no-watch with stock config/incognito and real localhost5173 Vite; OS UI/native IPC; no packaged/provider claim"
      : "Actual incognito package; OS accessibility/input; no live Access/provider or raw IPC denial claim",
  };

  writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));

  if (failure !== null) process.exitCode = 1;
}
