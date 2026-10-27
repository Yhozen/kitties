import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import {
  DurableFiles,
  type BlobStore,
  type MetadataStorage,
} from "../src/state.ts";

const envFile = process.env.KITTIES_SMOKE_ENV_FILE;
if (!envFile)
  throw new Error(
    "Set KITTIES_SMOKE_ENV_FILE to the local secret file for the read-only Boat account readiness check",
  );

const db = new DatabaseSync(":memory:");
const storage: MetadataStorage = {
  sql: {
    exec: <T extends Record<string, SqlStorageValue>>(
      query: string,
      ...bindings: SqlStorageValue[]
    ) => {
      const rows = db
        .prepare(query)
        .all(
          ...bindings.map((value) =>
            value instanceof ArrayBuffer ? new Uint8Array(value) : value,
          ),
        );
      return { toArray: () => rows as T[] };
    },
  },
  transactionSync: <T>(callback: () => T): T => {
    db.exec("BEGIN");
    try {
      const value = callback();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
  sync: async () => {},
};
const objects = new Map<string, Uint8Array<ArrayBuffer>>();
const bucket: BlobStore = {
  get: async (key) => {
    const value = objects.get(key);
    return value
      ? { size: value.length, body: new Response(value).body! }
      : null;
  },
  head: async (key) => {
    const value = objects.get(key);
    return value ? { size: value.length } : null;
  },
  put: async (key, body, options) => {
    const bytes = new Uint8Array(
      await new Response(
        body instanceof Uint8Array ? new Uint8Array(body) : body,
      ).arrayBuffer(),
    );
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      options.sha256,
    );
    objects.set(key, bytes);
  },
};
let files = new DurableFiles(storage, bucket, "cold-restart-test");
let epoch = await files.advanceEpoch();
const server = createServer(async (request, response) => {
  try {
    const body: Buffer[] = [];
    for await (const chunk of request) body.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers))
      if (typeof value === "string") headers.set(name, value);
    const input = new Request(`http://state${request.url}`, {
      method: request.method,
      headers,
      ...(!["GET", "HEAD"].includes(request.method ?? "GET")
        ? { body: new Uint8Array(Buffer.concat(body)) }
        : {}),
    });
    const result = await files.handle(input, epoch);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    response.writeHead(500).end();
  }
});
await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const name = `kitties-cold-restart-${process.pid}`;
const token = randomBytes(32).toString("hex");
const vaultKey = randomBytes(32).toString("base64");
const image = process.env.KITTIES_SMOKE_IMAGE ?? "kitties-cloudflare:verify";
const docker = (...args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
let base = "";
const start = async () => {
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--memory",
    "1g",
    "--memory-swap",
    "1g",
    "--cpus",
    "0.25",
    "--env-file",
    envFile,
    "--add-host",
    "kitties-state.internal:host-gateway",
    "-p",
    "127.0.0.1::7488",
    "-e",
    `KITTIES_STATE_URL=http://kitties-state.internal:${address.port}`,
    "-e",
    "KITTIES_CONFIG=/etc/kitties/default.yaml",
    "-e",
    "KITTIES_DATA_DIR=/var/lib/kitties",
    "-e",
    "KITTIES_LISTEN=0.0.0.0:7488",
    "-e",
    `KITTIES_TOKEN=${token}`,
    "-e",
    `KITTIES_VAULT_KEY=${vaultKey}`,
    "-e",
    "OPENAI_API_KEY=local-smoke-no-model-calls",
    image,
  );
  base = `http://${docker("port", name, "7488/tcp")}`;
  for (let count = 0; count < 120; count++) {
    try {
      if ((await fetch(`${base}/v1/health`)).ok) return;
    } catch {}
    if (docker("inspect", "--format", "{{.State.Running}}", name) !== "true") {
      const logs = spawnSync("docker", ["logs", name], { encoding: "utf8" });
      throw new Error(`Gateway exited: ${logs.stdout}${logs.stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Gateway did not become ready");
};
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert(response.ok, `${method} ${path}: HTTP ${response.status}`);
  return response.json();
};
try {
  await start();
  await api("PUT", "/v1/settings/providers/restore-check", {
    kind: "openai",
    model: "fixture-model",
    api_key_env: "OPENAI_API_KEY",
  });
  await api("PUT", "/v1/vault/restore-check", {
    value: "synthetic-persistence-fixture",
    kitties: [],
  });
  const before = files.manifest();
  assert(before.files.some((file) => file.path === "settings.json"));
  assert(before.files.some((file) => file.path === "vault.json"));
  const firstPeak = Number(
    docker("exec", name, "cat", "/sys/fs/cgroup/memory.peak"),
  );
  docker("rm", "-f", name);
  files = new DurableFiles(storage, bucket, "cold-restart-test");
  epoch = await files.advanceEpoch();
  await start();
  const settings = await api("GET", "/v1/settings");
  assert(JSON.stringify(settings).includes("restore-check"));
  const secrets = await api("GET", "/v1/vault");
  assert(JSON.stringify(secrets).includes("restore-check"));
  assert(files.manifest().revision >= before.revision);
  const restoredPeak = Number(
    docker("exec", name, "cat", "/sys/fs/cgroup/memory.peak"),
  );
  console.log(
    `Gateway cgroup peak: initial=${(firstPeak / 1024 / 1024).toFixed(1)} MiB, restored=${(restoredPeak / 1024 / 1024).toFixed(1)} MiB (1 GiB / 0.25 CPU limit).`,
  );
  console.log(
    "Cold restart passed: settings and encrypted vault restored into a fresh container/cache; no Boat VMs or model calls.",
  );
} finally {
  try {
    docker("rm", "-f", name);
  } catch {}
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
}
