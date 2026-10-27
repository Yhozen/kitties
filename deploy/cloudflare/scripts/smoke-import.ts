import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  DurableFiles,
  type BlobStore,
  type MetadataStorage,
} from "../src/state.ts";

const source = await mkdtemp(join(tmpdir(), "kitties-import-"));
await mkdir(join(source, "chats"));
for (let index = 0; index < 300; index++)
  await writeFile(
    join(source, "chats", `${index}.json`),
    JSON.stringify({ id: index, title: "Recovery fixture" }),
    { mode: 0o600 },
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
      const result = callback();
      db.exec("COMMIT");
      return result;
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
    const value = new Uint8Array(
      await new Response(
        body instanceof Uint8Array ? new Uint8Array(body) : body,
      ).arrayBuffer(),
    );
    assert.equal(
      createHash("sha256").update(value).digest("hex"),
      options.sha256,
    );
    objects.set(key, value);
  },
};
let files = new DurableFiles(storage, bucket, "import-acceptance");
const epoch = await files.advanceEpoch();
let failSecondBatch = true;
let batches = 0;
const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (request.url === "/v1/import/batch") {
      const body = JSON.parse(bytes.toString());
      if (failSecondBatch && body.index === 1) {
        response.writeHead(503).end();
        return;
      }
      batches++;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers))
      if (typeof value === "string") headers.set(name, value);
    const result = await files.handle(
      new Request(`http://state${request.url}`, {
        method: request.method,
        headers,
        ...(!["GET", "HEAD"].includes(request.method ?? "GET")
          ? { body: bytes }
          : {}),
      }),
      epoch,
    );
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    response.writeHead(500).end();
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const run = () =>
  new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(
      "go",
      ["run", "./cmd/kitties", "import-state", source],
      {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        env: {
          ...process.env,
          KITTIES_STATE_URL: `http://127.0.0.1:${address.port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
try {
  const first = await run();
  assert.notEqual(
    first.code,
    0,
    "The injected second-batch outage must fail the import",
  );
  assert.deepEqual(files.manifest(), { revision: 0, files: [] });
  assert.equal(batches, 1, first.output);
  files = new DurableFiles(storage, bucket, "import-acceptance");
  failSecondBatch = false;
  const second = await run();
  assert.equal(second.code, 0, second.output);
  assert.equal(
    batches,
    2,
    "The Go retry should resume after the previously accepted batch",
  );
  assert.equal(files.manifest().revision, 1);
  assert.equal(files.manifest().files.length, 300);
  assert(
    files
      .manifest()
      .files.every((file) => file.mode === 0o600 && file.parts.length === 1),
  );
  const third = await run();
  assert.notEqual(third.code, 0, "A populated target must reject import");
  console.log(
    "Go ↔ TypeScript staged import passed: 300 files, interrupted batch, empty authoritative manifest, DO restart, resumed import, and populated-target rejection.",
  );
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  await rm(source, { recursive: true, force: true });
}
