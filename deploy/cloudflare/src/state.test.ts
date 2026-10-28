import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DurableFiles, type BlobStore, type MetadataStorage } from "./state.ts";
import { decodeCommit, type Mutation } from "./protocol.ts";
import { containerRequest, gatewayRequest, sameOrigin } from "./http.ts";

class SQL implements MetadataStorage {
  private db = new DatabaseSync(":memory:");
  failSync = false;
  sql = {
    exec: <T extends Record<string, SqlStorageValue>>(
      query: string,
      ...bindings: SqlStorageValue[]
    ) => {
      const rows = this.db
        .prepare(query)
        .all(
          ...bindings.map((value) =>
            value instanceof ArrayBuffer ? new Uint8Array(value) : value,
          ),
        );
      return { toArray: () => rows.map((row) => ({ ...row })) as T[] };
    },
  };
  transactionSync<T>(callback: () => T): T {
    this.db.exec("BEGIN");
    try {
      const value = callback();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async sync() {
    if (this.failSync) throw new Error("Storage is unavailable");
  }
}

class Blobs implements BlobStore {
  objects = new Map<string, Uint8Array>();
  headGate: (() => Promise<void>) | undefined;
  async get(key: string) {
    const value = this.objects.get(key);
    return value
      ? {
          size: value.byteLength,
          body: new Response(new Uint8Array(value)).body!,
        }
      : null;
  }
  async head(key: string) {
    await this.headGate?.();
    const value = this.objects.get(key);
    return value ? { size: value.byteLength } : null;
  }
  async put(
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    options: { sha256: string },
  ) {
    const value = new Uint8Array(
      await new Response(
        body instanceof Uint8Array ? new Uint8Array(body) : body,
      ).arrayBuffer(),
    );
    assert.equal(
      createHash("sha256").update(value).digest("hex"),
      options.sha256,
    );
    this.objects.set(key, value);
  }
}

async function fixture() {
  const storage = new SQL();
  const bucket = new Blobs();
  const state = new DurableFiles(storage, bucket, "owner");
  const epoch = await state.advanceEpoch();
  const upload = async (text: string) => {
    const bytes = new TextEncoder().encode(text);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const response = await state.handle(
      new Request(`http://state/v1/blob/${sha256}`, {
        method: "PUT",
        headers: { "Content-Length": String(bytes.length) },
        body: bytes,
      }),
      epoch,
    );
    assert.equal(response.status, 204);
    return { sha256, size: bytes.length };
  };
  const commit = (
    id: string,
    baseRevision: number,
    mutations: Mutation[],
    useEpoch = epoch,
  ) =>
    state.handle(
      new Request("http://state/v1/commit", {
        method: "POST",
        body: JSON.stringify({ id, baseRevision, mutations }),
      }),
      useEpoch,
    );
  return { storage, bucket, state, epoch, upload, commit };
}

const first = "commit_0000000001";
const second = "commit_0000000002";

test("a retried commit never duplicates a journal append, including after a DO restart", async () => {
  const f = await fixture();
  const part = await f.upload("event\n");
  const mutation: Mutation = {
    op: "append",
    path: "journal.jsonl",
    mode: 0o600,
    parts: [part],
  };
  assert.equal((await f.commit(first, 0, [mutation])).status, 200);
  assert.equal((await f.commit(first, 0, [mutation])).status, 200);
  const restarted = new DurableFiles(f.storage, f.bucket, "owner");
  const retry = await restarted.handle(
    new Request("http://state/v1/commit", {
      method: "POST",
      body: JSON.stringify({
        id: first,
        baseRevision: 0,
        mutations: [mutation],
      }),
    }),
    f.epoch,
  );
  assert.deepEqual(await retry.json(), { revision: 1 });
  assert.deepEqual(restarted.manifest().files[0].parts, [part]);
  assert.equal(
    (await f.commit(first, 0, [{ ...mutation, path: "other" }])).status,
    409,
  );
});

test("a new epoch fences an in-flight writer before its SQLite commit", async () => {
  const f = await fixture();
  const part = await f.upload("private key");
  let arrived!: () => void;
  let proceed!: () => void;
  const entered = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  f.bucket.headGate = () => {
    arrived();
    return gate;
  };
  const commit = f.commit(first, 0, [
    { op: "put", path: "boat/id_ed25519", mode: 0o600, parts: [part] },
  ]);
  await entered;
  await f.state.advanceEpoch();
  proceed();
  assert.equal((await commit).status, 409);
  assert.deepEqual(f.state.manifest(), { revision: 0, files: [] });
});

test("missing blobs and concurrent revision conflicts cannot acknowledge lost state", async () => {
  const f = await fixture();
  const part = await f.upload("value");
  const mutation: Mutation = {
    op: "put",
    path: "settings.json",
    mode: 0o600,
    parts: [part],
  };
  const missing = await f.commit(first, 0, [
    { ...mutation, parts: [{ sha256: "a".repeat(64), size: 2 }] },
  ]);
  assert.equal(missing.status, 409);
  const results = await Promise.all([
    f.commit(first, 0, [mutation]),
    f.commit(second, 0, [mutation]),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(f.state.manifest().revision, 1);
});

test("rename batches are atomic and recursive deletion respects path boundaries", async () => {
  const f = await fixture();
  const part = await f.upload("saved");
  await f.commit(first, 0, [
    { op: "put", path: "chat/old", mode: 0o600, parts: [part] },
    { op: "put", path: "chat-other/keep", mode: 0o600, parts: [part] },
  ]);
  await f.commit(second, 1, [
    { op: "put", path: "chat/new", mode: 0o600, parts: [part] },
    { op: "delete", path: "chat/old" },
  ]);
  assert.deepEqual(
    f.state
      .manifest()
      .files.map((file) => file.path)
      .sort(),
    ["chat-other/keep", "chat/new"],
  );
  await f.commit("commit_0000000003", 2, [
    { op: "delete", path: "chat", recursive: true },
  ]);
  assert.deepEqual(
    f.state.manifest().files.map((file) => file.path),
    ["chat-other/keep"],
  );
});

test("storage acknowledgement failure is returned as failure, never success", async () => {
  const f = await fixture();
  const part = await f.upload("saved");
  f.storage.failSync = true;
  const result = await f.commit(first, 0, [
    { op: "put", path: "settings.json", mode: 0o600, parts: [part] },
  ]);
  assert.equal(result.status, 503);
  f.storage.failSync = false;
  assert.equal(
    (
      await f.commit(first, 0, [
        { op: "put", path: "settings.json", mode: 0o600, parts: [part] },
      ])
    ).status,
    200,
  );
});

test("storage failure diagnostics identify the stage without exposing state or provider messages", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const f = await fixture();
  const part = await f.upload("private state bytes");
  t.mock.method(f.bucket, "put", async () => {
    throw new Error("provider secret and private path");
  });
  const upload = await f.state.handle(
    new Request(`http://state/v1/blob/${part.sha256}`, {
      method: "PUT",
      headers: { "Content-Length": String(part.size) },
      body: "private state bytes",
    }),
    f.epoch,
  );
  assert.equal(upload.status, 503);
  f.storage.failSync = true;
  const commit = await f.commit(first, 0, [
    { op: "put", path: "private/settings.json", mode: 0o600, parts: [part] },
  ]);
  assert.equal(commit.status, 503);
  assert.deepEqual(
    log.mock.calls.map((call) => call.arguments),
    [
      [
        "Durable state request failed",
        { operation: "blob_upload", stage: "upload", name: "Error" },
      ],
      [
        "Durable state request failed",
        { operation: "commit", stage: "sync", name: "Error" },
      ],
    ],
  );
  assert.deepEqual(await upload.json(), {
    error: "Durable storage is unavailable",
  });
});

test("state paths reject traversal before any write", () => {
  for (const path of ["../key", "/key", "a//b", "a/./b", "a\\b", "a\u0000b"]) {
    assert.throws(() =>
      decodeCommit({
        id: first,
        baseRevision: 0,
        mutations: [{ op: "delete", path }],
      }),
    );
  }
});

test("Access proxy checks browser origins and replaces incoming credentials", () => {
  const origin = "https://kitties.example.com";
  assert.equal(
    sameOrigin(
      new Request(origin, {
        method: "POST",
        headers: { Origin: "https://evil.example" },
      }),
      origin,
    ),
    false,
  );
  assert.equal(
    sameOrigin(new Request(origin, { method: "POST" }), origin),
    false,
  );
  assert.equal(
    sameOrigin(
      new Request(origin, { method: "POST", headers: { Origin: origin } }),
      origin,
    ),
    true,
  );
  assert.equal(
    sameOrigin(
      new Request(origin, { headers: { Upgrade: "websocket" } }),
      origin,
    ),
    false,
  );
  const forwarded = gatewayRequest(
    new Request(`${origin}/v1/kitties?token=untrusted`, {
      headers: {
        Authorization: "Bearer untrusted",
        "X-Forwarded-For": "spoofed",
      },
    }),
    "private-token",
    origin,
  );
  assert.equal(forwarded.headers.get("Authorization"), "Bearer private-token");
  assert.equal(forwarded.headers.get("X-Forwarded-For"), null);
  assert.equal(new URL(forwarded.url).searchParams.has("token"), false);
});

test("oversized commit metadata is rejected before it can consume Worker memory", async () => {
  const f = await fixture();
  const response = await f.state.handle(
    new Request("http://state/v1/commit", {
      method: "POST",
      headers: { "Content-Length": String(128 * 1024 * 1024) },
      body: "not consumed",
    }),
    f.epoch,
  );
  assert.equal(response.status, 413);
  assert.equal(f.state.manifest().revision, 0);
  const chunked = await f.state.handle(
    new Request("http://state/v1/commit", {
      method: "POST",
      body: new Uint8Array(2 * 1024 * 1024 + 1),
    }),
    f.epoch,
  );
  assert.equal(chunked.status, 413);
  assert.equal(f.state.manifest().revision, 0);
});

function importRequest(
  state: DurableFiles,
  epoch: number,
  action: string,
  body: object,
) {
  return state.handle(
    new Request(`http://state/v1/import/${action}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    epoch,
  );
}

test("a many-chat recovery publishes all 300 files atomically and survives retries", async () => {
  const f = await fixture();
  const part = await f.upload("recovered content");
  const id = "import_0000000001";
  const begin = { id, files: 300, batches: 2 };
  assert.equal(
    (await importRequest(f.state, f.epoch, "begin", begin)).status,
    200,
  );
  const files = Array.from({ length: 300 }, (_, index) => ({
    op: "put",
    path: `chats/${index}.json`,
    mode: 0o600,
    parts: [part],
  }));
  const batch = { id, index: 0, mutations: files.slice(0, 256) };
  assert.equal(
    (await importRequest(f.state, f.epoch, "batch", batch)).status,
    200,
  );
  assert.deepEqual(f.state.manifest(), { revision: 0, files: [] });
  assert.equal(
    (await importRequest(f.state, f.epoch, "finalize", { id })).status,
    409,
  );
  assert.equal(
    (await f.commit(first, 0, [{ op: "put", path: "unrelated", mode: 0o600 }]))
      .status,
    409,
  );
  const restarted = new DurableFiles(f.storage, f.bucket, "owner");
  assert.deepEqual(
    await (await importRequest(restarted, f.epoch, "begin", begin)).json(),
    { next: 1 },
  );
  assert.equal(
    (await importRequest(restarted, f.epoch, "batch", batch)).status,
    200,
  );
  assert.equal(
    (
      await importRequest(restarted, f.epoch, "batch", {
        ...batch,
        mutations: files.slice(1, 256),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await importRequest(restarted, f.epoch, "batch", {
        id,
        index: 1,
        mutations: files.slice(256),
      })
    ).status,
    200,
  );
  f.storage.failSync = true;
  assert.equal(
    (await importRequest(restarted, f.epoch, "finalize", { id })).status,
    503,
  );
  f.storage.failSync = false;
  assert.deepEqual(
    await (await importRequest(restarted, f.epoch, "finalize", { id })).json(),
    { revision: 1 },
  );
  assert.equal(restarted.manifest().files.length, 300);
  assert.deepEqual(restarted.manifest().files[100].parts, [part]);
  assert.equal(
    (
      await importRequest(restarted, f.epoch, "begin", {
        ...begin,
        id: "import_0000000002",
      })
    ).status,
    409,
  );
});

test("interrupted imports are fenced and can be restarted without publishing stale files", async () => {
  const f = await fixture();
  const id = "import_0000000001";
  const part = await f.upload("bytes");
  const mutation = {
    op: "put",
    path: "settings.json",
    mode: 0o600,
    parts: [part],
  };
  await importRequest(f.state, f.epoch, "begin", { id, files: 1, batches: 1 });
  assert.equal(
    (
      await importRequest(f.state, f.epoch, "batch", {
        id,
        index: 0,
        mutations: [
          { ...mutation, parts: [{ sha256: "a".repeat(64), size: 1 }] },
        ],
      })
    ).status,
    409,
  );
  let entered!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.bucket.headGate = () => {
    entered();
    return gate;
  };
  const pending = importRequest(f.state, f.epoch, "batch", {
    id,
    index: 0,
    mutations: [mutation],
  });
  await arrived;
  const epoch = await f.state.advanceEpoch();
  release();
  assert.equal((await pending).status, 409);
  assert.equal(
    (await importRequest(f.state, f.epoch, "finalize", { id })).status,
    409,
  );
  const fresh = "import_0000000002";
  assert.equal(
    (
      await importRequest(f.state, epoch, "begin", {
        id: fresh,
        files: 1,
        batches: 1,
      })
    ).status,
    200,
  );
  f.bucket.headGate = undefined;
  assert.equal(
    (
      await importRequest(f.state, epoch, "batch", {
        id: fresh,
        index: 0,
        mutations: [{ ...mutation, path: "fresh.json" }],
      })
    ).status,
    200,
  );
  assert.equal(
    (await importRequest(f.state, epoch, "finalize", { id: fresh })).status,
    200,
  );
  assert.deepEqual(
    f.state.manifest().files.map((file) => file.path),
    ["fresh.json"],
  );
});

test("native container transport uses HTTP while preserving the secure external origin", async () => {
  const request = new Request("https://kitties.example/v1/chat?stream=true", {
    method: "POST",
    body: "message",
    headers: {
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "kitties.example",
      Authorization: "Bearer synthetic",
    },
  });
  const forwarded = containerRequest(request);
  assert.equal(forwarded.url, "http://kitties.example/v1/chat?stream=true");
  assert.equal(forwarded.headers.get("X-Forwarded-Proto"), "https");
  assert.equal(forwarded.headers.get("X-Forwarded-Host"), "kitties.example");
  assert.equal(forwarded.headers.get("Authorization"), "Bearer synthetic");
  assert.equal(forwarded.method, "POST");
  assert.equal(await forwarded.text(), "message");
  const websocket = containerRequest(
    new Request("https://kitties.example/v1/desktop", {
      headers: { Upgrade: "websocket" },
    }),
  );
  assert.equal(websocket.headers.get("Upgrade"), "websocket");
});
