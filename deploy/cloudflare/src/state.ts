import {
  applyCommit,
  decodeCommit,
  isHash,
  ProtocolError,
  type Commit,
  type FileEntry,
  type Manifest,
  type Mutation,
} from "./protocol.ts";

import { StagedImport } from "./imports.ts";

const MAX_BLOB_BYTES = 512 * 1024 * 1024;
const MAX_COMMIT_BYTES = 2 * 1024 * 1024;

export interface MetadataStorage {
  sql: {
    exec<T extends Record<string, SqlStorageValue>>(
      query: string,
      ...bindings: SqlStorageValue[]
    ): { toArray(): T[] };
  };
  transactionSync<T>(callback: () => T): T;
  sync(): Promise<void>;
}

export interface BlobStore {
  get(
    key: string,
  ): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
  head(key: string): Promise<{ size: number } | null>;
  put(
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    options: { sha256: string },
  ): Promise<unknown>;
}

// SQLite holds the authoritative manifest; R2 holds immutable, checksum-verified bytes.
export class DurableFiles {
  private readonly imports: StagedImport;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: MetadataStorage,
    private readonly bucket: BlobStore,
    private readonly owner: string,
  ) {
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS state_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
    );
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS state_files (path TEXT PRIMARY KEY, mode INTEGER NOT NULL)`,
    );
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS state_parts (path TEXT NOT NULL, ordinal INTEGER NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(path, ordinal))`,
    );
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS state_commits (id TEXT PRIMARY KEY, digest TEXT NOT NULL, revision INTEGER NOT NULL)`,
    );
    this.imports = new StagedImport(
      storage,
      (epoch) => this.assertEpoch(epoch),
      (mutations) => this.verifyParts(mutations),
    );
  }

  epoch(): number {
    return this.meta("epoch");
  }

  async advanceEpoch(): Promise<number> {
    const epoch = this.epoch() + 1;
    this.storage.sql.exec(
      "INSERT OR REPLACE INTO state_meta VALUES ('epoch', ?)",
      epoch,
    );
    await this.storage.sync();
    return epoch;
  }

  manifest(): Manifest {
    const files = this.storage.sql
      .exec<{
        path: string;
        mode: number;
      }>("SELECT path, mode FROM state_files ORDER BY path")
      .toArray();
    const parts = this.storage.sql
      .exec<{
        path: string;
        sha256: string;
        size: number;
      }>("SELECT path, sha256, size FROM state_parts ORDER BY path, ordinal")
      .toArray();
    const byPath = new Map<string, FileEntry>(
      files.map((file) => [file.path, { ...file, parts: [] }]),
    );
    for (const { path, sha256, size } of parts) {
      const file = byPath.get(path);
      if (!file) throw new Error("State manifest contains an orphaned part");
      file.parts.push({ sha256, size });
    }
    return { revision: this.meta("revision"), files: [...byPath.values()] };
  }

  async handle(request: Request, epoch: number): Promise<Response> {
    try {
      this.assertEpoch(epoch);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/manifest") {
        return Response.json(this.manifest(), {
          headers: { "Cache-Control": "no-store" },
        });
      }
      const sha = url.pathname.startsWith("/v1/blob/")
        ? url.pathname.slice(9)
        : "";
      if (isHash(sha)) {
        if (request.method === "GET") {
          const object = await this.bucket.get(this.objectKey(sha));
          this.assertEpoch(epoch);
          if (!object) return new Response("Blob not found", { status: 404 });
          return new Response(object.body, {
            headers: {
              "Content-Length": String(object.size),
              "Cache-Control": "no-store",
            },
          });
        }
        if (request.method === "PUT") {
          const length = Number(request.headers.get("Content-Length"));
          if (
            !request.headers.has("Content-Length") ||
            !Number.isSafeInteger(length) ||
            length < 0 ||
            length > MAX_BLOB_BYTES
          ) {
            throw new ProtocolError(
              "A valid Content-Length up to 512 MiB is required",
              413,
            );
          }
          await this.bucket.put(
            this.objectKey(sha),
            request.body ?? new Uint8Array(),
            { sha256: sha },
          );
          this.assertEpoch(epoch);
          return new Response(null, { status: 204 });
        }
      }
      if (
        request.method === "POST" &&
        (url.pathname === "/v1/commit" ||
          url.pathname.startsWith("/v1/import/"))
      ) {
        const raw = await readCommitBody(request);
        let input: unknown;
        try {
          input = JSON.parse(raw);
        } catch {
          throw new ProtocolError("Invalid JSON");
        }
        if (url.pathname.startsWith("/v1/import/")) {
          return await this.exclusive(() =>
            this.imports.handle(url.pathname.slice(11), input, epoch),
          );
        }
        const commit = decodeCommit(input);
        return await this.exclusive(() => this.commit(commit, epoch));
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (error instanceof ProtocolError)
        return Response.json(
          { error: error.message },
          { status: error.status },
        );
      // The client must stop after an unacknowledged state write. Never return success here.
      console.error(
        "Durable state request failed",
        error instanceof Error ? error.name : "unknown",
      );
      return Response.json(
        { error: "Durable storage is unavailable" },
        { status: 503 },
      );
    }
  }

  private async commit(commit: Commit, epoch: number): Promise<Response> {
    this.assertEpoch(epoch);
    const digest = await sha256(JSON.stringify(commit));
    this.assertEpoch(epoch);
    const previous = this.storage.sql
      .exec<{
        digest: string;
        revision: number;
      }>("SELECT digest, revision FROM state_commits WHERE id = ?", commit.id)
      .toArray()[0];
    if (previous) {
      if (previous.digest !== digest)
        throw new ProtocolError(
          "Commit id was reused with different content",
          409,
        );
      await this.storage.sync();
      return Response.json({ revision: previous.revision });
    }
    const before = this.manifest();
    const after = applyCommit(before, commit);
    if (this.imports.pending())
      throw new ProtocolError("A recovery import is in progress", 409);
    await this.verifyParts(commit.mutations);
    this.storage.transactionSync(() => {
      this.assertEpoch(epoch);
      if (this.meta("revision") !== before.revision)
        throw new ProtocolError("State revision changed", 409);
      const oldFiles = new Map(before.files.map((file) => [file.path, file]));
      const newPaths = new Set(after.files.map((file) => file.path));
      for (const path of oldFiles.keys()) {
        if (!newPaths.has(path)) {
          this.storage.sql.exec("DELETE FROM state_parts WHERE path = ?", path);
          this.storage.sql.exec("DELETE FROM state_files WHERE path = ?", path);
        }
      }
      for (const file of after.files) {
        const old = oldFiles.get(file.path);
        if (JSON.stringify(old) === JSON.stringify(file)) continue;
        this.storage.sql.exec(
          "INSERT OR REPLACE INTO state_files VALUES (?, ?)",
          file.path,
          file.mode,
        );
        const isAppend =
          old &&
          old.parts.length <= file.parts.length &&
          old.parts.every(
            (part, index) =>
              part.sha256 === file.parts[index]?.sha256 &&
              part.size === file.parts[index]?.size,
          );
        const start = isAppend ? old.parts.length : 0;
        if (!isAppend)
          this.storage.sql.exec(
            "DELETE FROM state_parts WHERE path = ?",
            file.path,
          );
        for (let index = start; index < file.parts.length; index++) {
          const part = file.parts[index];
          this.storage.sql.exec(
            "INSERT INTO state_parts VALUES (?, ?, ?, ?)",
            file.path,
            index,
            part.sha256,
            part.size,
          );
        }
      }
      this.storage.sql.exec(
        "INSERT OR REPLACE INTO state_meta VALUES ('revision', ?)",
        after.revision,
      );
      this.storage.sql.exec(
        "INSERT INTO state_commits VALUES (?, ?, ?)",
        commit.id,
        digest,
        after.revision,
      );
      this.storage.sql.exec(
        "DELETE FROM state_commits WHERE revision < ?",
        after.revision - 1024,
      );
    });
    await this.storage.sync();
    return Response.json({ revision: after.revision });
  }

  private async verifyParts(mutations: Mutation[]): Promise<void> {
    const references = new Map<string, number>();
    for (const part of mutations.flatMap((mutation) => mutation.parts ?? [])) {
      const size = references.get(part.sha256);
      if (size !== undefined && size !== part.size)
        throw new ProtocolError("A blob has conflicting sizes");
      references.set(part.sha256, part.size);
    }
    for (const [sha, size] of references) {
      const object = await this.bucket.head(this.objectKey(sha));
      if (!object || object.size !== size)
        throw new ProtocolError(
          "A referenced blob is missing or has the wrong size",
          409,
        );
    }
  }

  private assertEpoch(epoch: number): void {
    if (!Number.isSafeInteger(epoch) || epoch <= 0 || epoch !== this.epoch()) {
      throw new ProtocolError(
        "This gateway instance no longer owns durable state",
        409,
      );
    }
  }

  private meta(key: string): number {
    return (
      this.storage.sql
        .exec<{
          value: number;
        }>("SELECT value FROM state_meta WHERE key = ?", key)
        .toArray()[0]?.value ?? 0
    );
  }

  private objectKey(sha: string): string {
    return `${this.owner}/blobs/${sha}`;
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function readCommitBody(request: Request): Promise<string> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > MAX_COMMIT_BYTES) {
    await request.body?.cancel();
    throw new ProtocolError("Commit metadata is too large", 413);
  }
  if (!request.body) throw new ProtocolError("Commit metadata is required");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      size += chunk.value.byteLength;
      if (size > MAX_COMMIT_BYTES) {
        await reader.cancel();
        throw new ProtocolError("Commit metadata is too large", 413);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
