import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { ResticRepository, type ResticBucket } from "../src/restic.ts";

class Bucket implements ResticBucket {
  readonly objects = new Map<string, Uint8Array<ArrayBuffer>>();
  continuedLists = 0;
  rangeReads = 0;
  failListContinuation = false;

  async head(key: string) {
    const bytes = this.objects.get(key);
    return bytes ? { size: bytes.length } : null;
  }
  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    const range = options?.range;
    if (range) this.rangeReads++;
    const body = range ? bytes.slice(range.offset, range.offset + range.length) : bytes;
    return { size: bytes.length, body: new Response(body).body! };
  }
  async put(key: string, body: ReadableStream<Uint8Array> | Uint8Array) {
    const bytes = new Uint8Array(await new Response(
      body instanceof Uint8Array ? new Uint8Array(body) : body,
    ).arrayBuffer());
    // Match R2: interrupted uploads never replace a committed object.
    this.objects.set(key, bytes);
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async list(options: { prefix: string; cursor?: string }) {
    if (options.cursor) {
      this.continuedLists++;
      if (this.failListContinuation) throw new Error("Injected listing failure");
    }
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(options.prefix)).sort();
    const start = Number(options.cursor ?? 0);
    const page = keys.slice(start, start + 1);
    const truncated = start + page.length < keys.length;
    return {
      objects: page.map((key) => ({ key, size: this.objects.get(key)!.length })),
      truncated,
      ...(truncated ? { cursor: String(start + page.length) } : {}),
    };
  }
}

const directory = await mkdtemp(join(tmpdir(), "kitties-restic-rest-"));
const bucket = new Bucket();
let repository = new ResticRepository(bucket);
const requests: Array<{ method: string; path: string; range: string | null }> = [];
const server = createServer(async (request, response) => {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers))
      if (typeof value === "string") headers.set(name, value);
    requests.push({ method: request.method ?? "GET", path: request.url ?? "/", range: headers.get("range") });
    const options: RequestInit & { duplex?: "half" } = { method: request.method, headers };
    if (!["GET", "HEAD"].includes(request.method ?? "GET")) {
      options.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
      options.duplex = "half";
    }
    const result = await repository.handle(new Request(`http://backups${request.url}`, options));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) {
    if (response.headersSent) response.destroy(error instanceof Error ? error : undefined);
    else response.writeHead(500).end();
  }
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert(address && typeof address !== "string");
const endpoint = `http://127.0.0.1:${address.port}`;
const environment: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: directory,
  TMPDIR: directory,
  RESTIC_REPOSITORY: `rest:${endpoint}/`,
  RESTIC_PASSWORD: randomBytes(32).toString("base64"),
  RESTIC_CACHE_DIR: join(directory, "cache"),
};

function restic(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("restic", args, { env: environment, stdio: ["pipe", "pipe", "pipe"] });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.stdin.on("error", () => {});
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`restic ${args[0]} failed (${signal ?? code}): ${Buffer.concat(errors).toString()}`));
      else resolve(Buffer.concat(output));
    });
    child.stdin.end(input);
  });
}

async function backup(bytes: Buffer, time: string): Promise<string> {
  const output = await restic([
    "backup", "--json", "--stdin", "--stdin-filename", "recovery.tar",
    "--host", "kitties-smoke", "--tag", "kitties-recovery", "--time", time,
  ], bytes);
  const summary = output.toString().trim().split("\n").map((line) => JSON.parse(line))
    .find((line) => line.message_type === "summary");
  assert.equal(typeof summary?.snapshot_id, "string", "restic did not acknowledge the snapshot");
  return summary.snapshot_id;
}

try {
  await restic(["init"]);
  const first = Buffer.concat([Buffer.from("kitties private recovery fixture one\n"), randomBytes(1024 * 1024)]);
  const second = Buffer.concat([Buffer.from("kitties private recovery fixture two\n"), randomBytes(1024 * 1024)]);
  const firstID = await backup(first, "2026-01-01 03:00:00");
  const secondID = await backup(second, "2026-01-02 03:00:00");
  assert(requests.some((request) => request.method === "POST" && request.path.startsWith("/locks/")),
    "restic never acquired a repository lock");
  assert(requests.some((request) => request.method === "DELETE" && request.path.startsWith("/locks/")),
    "restic never released a repository lock");
  assert.equal([...bucket.objects.keys()].filter((key) => key.startsWith("restic/locks/")).length, 0,
    "completed backups left repository locks behind");
  const snapshots = JSON.parse((await restic(["snapshots", "--json"])).toString()) as Array<{ id: string }>;
  assert.equal(snapshots.length, 2);
  assert(snapshots.some((snapshot) => snapshot.id.startsWith(firstID)));
  assert(snapshots.some((snapshot) => snapshot.id.startsWith(secondID)));
  assert(bucket.continuedLists > 0, "restic did not exercise paginated listings");
  const version1 = await fetch(endpoint + "/snapshots/");
  assert.equal(version1.headers.get("content-type"), "application/vnd.x.restic.rest.v1");
  assert.deepEqual((await version1.json() as string[]).sort(), snapshots.map((snapshot) => snapshot.id).sort());

  // A fresh adapter/cache must recover solely from the committed bucket objects.
  repository = new ResticRepository(bucket);
  environment.RESTIC_CACHE_DIR = join(directory, "fresh-cache");
  assert.deepEqual(await restic(["dump", firstID, "recovery.tar"]), first);
  const restored = join(directory, "restored");
  await restic(["restore", secondID, "--target", restored]);
  assert.deepEqual(await readFile(join(restored, "recovery.tar")), second);

  const pack = requests.find((request) => request.method === "POST" && request.path.startsWith("/data/"));
  assert(pack, "restic never uploaded an encrypted data pack");
  const full = await fetch(endpoint + pack.path);
  assert.equal(full.status, 200);
  const encrypted = Buffer.from(await full.arrayBuffer());
  assert(!encrypted.includes(Buffer.from("kitties private recovery fixture")), "bucket contains plaintext recovery contents");
  const head = await fetch(endpoint + pack.path, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get("content-length")), encrypted.length);
  const partial = await fetch(endpoint + pack.path, { headers: { Range: "bytes=17-63" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), `bytes 17-63/${encrypted.length}`);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), encrypted.subarray(17, 64));
  assert(bucket.rangeReads > 0);
  const suffix = await fetch(endpoint + pack.path, { headers: { Range: "bytes=-16" } });
  assert.equal(suffix.status, 206);
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), encrypted.subarray(-16));
  const unsatisfiable = await fetch(endpoint + pack.path, { headers: { Range: `bytes=${encrypted.length}-` } });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get("content-range"), `bytes */${encrypted.length}`);

  // An R2 error on a later page must never look like a successful, shortened listing.
  bucket.failListContinuation = true;
  const listing = await repository.handle(new Request("http://backups/snapshots/", {
    headers: { Accept: "application/vnd.x.restic.rest.v2" },
  }));
  if (listing.ok) await assert.rejects(() => listing.text());
  else assert(listing.status >= 500);
  bucket.failListContinuation = false;
  assert.equal(JSON.parse((await restic(["snapshots", "--json"])).toString()).length, 2);

  // A transport failure after some bytes cannot publish a partial replacement.
  const before = new Map(bucket.objects);
  let pulled = false;
  const broken = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!pulled) { pulled = true; controller.enqueue(new Uint8Array([1, 2, 3])); }
      else controller.error(new Error("Injected upload interruption"));
    },
  });
  await assert.rejects(() => repository.handle(new Request("http://backups" + pack.path, {
    method: "POST", headers: { "Content-Length": "6" }, body: broken, duplex: "half",
  } as RequestInit)), /Injected upload interruption/);
  assert.deepEqual(bucket.objects, before, "interrupted upload changed committed repository objects");

  const deletesBefore = requests.filter((request) => request.method === "DELETE" && request.path.startsWith("/data/")).length;
  await restic(["forget", "--host", "kitties-smoke", "--tag", "kitties-recovery", "--group-by", "host,tags", "--keep-last", "1", "--prune"]);
  const retained = JSON.parse((await restic(["snapshots", "--json"])).toString()) as Array<{ id: string }>;
  assert.equal(retained.length, 1);
  assert(retained[0].id.startsWith(secondID), "retention removed the newest recovery");
  assert(requests.filter((request) => request.method === "DELETE" && request.path.startsWith("/data/")).length > deletesBefore,
    "prune did not delete obsolete encrypted packs");
  await restic(["check", "--read-data"]);
  assert.deepEqual(await restic(["dump", secondID, "recovery.tar"]), second);
  console.log("Private restic REST acceptance passed: init, streamed backups, fresh-adapter restore, range reads, pagination, interrupted-upload and listing failures, retention/prune, and full repository check.");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
