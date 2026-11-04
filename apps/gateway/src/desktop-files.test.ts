import { test, expect, vi, afterEach } from "vitest";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { desktopFileHandler } from "./desktop-files.ts";
import {
  FILE_LIMIT,
  SHARED_ROOT,
  TRANSFER_LEASE,
  attachmentName,
  relativeFilePath,
  transferUrl,
  fileStream,
} from "./desktop-files-core.ts";
import { freshComputer } from "./computer-state.ts";
import { newFileLease, validFileLease, liveFileLeases } from "./file-leases.ts";
afterEach(() => vi.unstubAllGlobals());
const root = SHARED_ROOT;
const signal = () => new AbortController().signal;
const source = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });

test("paths and signed canonical destinations cannot escape Shared", () => {
  for (const path of [
    "../profile",
    "/etc/passwd",
    ".browser/key",
    "a/../b",
    "a\\b",
    "a\nfile",
    "x//y",
    "a/",
    "",
  ])
    expect(() => relativeFilePath(path)).toThrow();
  expect(relativeFilePath("日本語/notes 🐈.pdf")).toBe("日本語/notes 🐈.pdf");
  expect(attachmentName("notes 🐈.pdf")).toContain("filename*=UTF-8''notes%20%F0%9F%90%88.pdf");
  for (const reply of [
    { path: "/home/user/secret", method: "GET", url: "https://box.on.boat.dev/a" },
    { path: root + "/a", method: "GET", url: "https://box.on.boat.dev.evil.test/a" },
    { path: root + "/a", method: "PUT", url: "https://box.on.boat.dev/a" },
  ])
    expect(() => transferUrl(reply, root + "/a", "GET")).toThrow();
});

test("stream remains pull-driven, checks length, cancels and releases only once", async () => {
  let pulls = 0;
  const finished = vi.fn(async () => {}),
    cancelled = vi.fn();
  const upstream = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        pulls++;
        c.enqueue(new Uint8Array(64));
      },
      cancel: cancelled,
    },
    { highWaterMark: 0 },
  );
  const abort = new AbortController();
  const reader = fileStream(upstream, { signal: abort.signal, finished }).getReader();
  await Promise.resolve();
  expect(pulls).toBe(0);
  await reader.read();
  expect(pulls).toBe(1);
  abort.abort();
  await expect(reader.read()).rejects.toThrow();
  expect(cancelled).toHaveBeenCalledOnce();
  expect(finished).toHaveBeenCalledExactlyOnceWith(false);
  const complete = vi.fn(async () => {});
  const bytes = new Uint8Array([0, 255, 42]);
  expect(
    new Uint8Array(
      await new Response(
        fileStream(source(bytes), { signal: signal(), expected: 3, finished: complete }),
      ).arrayBuffer(),
    ),
  ).toEqual(bytes);
  expect(complete).toHaveBeenCalledExactlyOnceWith(true);
  await expect(
    new Response(
      fileStream(source(bytes), { signal: signal(), expected: 4, finished }),
    ).arrayBuffer(),
  ).rejects.toThrow("FILE_SIZE_MISMATCH");
  await expect(
    new Response(
      fileStream(source(new Uint8Array(FILE_LIMIT + 1)), { signal: signal(), finished }),
    ).arrayBuffer(),
  ).rejects.toThrow("FILE_TOO_LARGE");
});

test("leases reject unavailable computers and stale generations; bound crashes and concurrency", () => {
  const state = { ...freshComputer("kitty", 0), phase: "ready" as const, remoteId: "bx_test" };
  const lease = newFileLease(state, [], "one", 100);
  expect(validFileLease(state, lease, 101)).toBe(true);
  expect(validFileLease({ ...state, generation: 2 }, lease, 101)).toBe(false);
  expect(validFileLease({ ...state, phase: "attention" }, lease, 101)).toBe(false);
  expect(() => newFileLease({ ...state, phase: "restoring" }, [], "two", 101)).toThrow();
  expect(() => newFileLease(state, [lease, lease, lease, lease], "five", 101)).toThrow();
  expect(liveFileLeases([lease], 100 + TRANSFER_LEASE)).toEqual([]);
});

async function fixture() {
  let valid = true,
    released = 0,
    puts = 0,
    signed = 0;
  const seen: { url: string; init?: RequestInit }[] = [];
  const files: Record<string, Uint8Array> = { [root + "/hello.bin"]: new Uint8Array([0, 255, 17]) };
  const computer = { ...freshComputer("test", 0), phase: "ready" as const, remoteId: "bx_test" };
  const home = { read: () => Effect.succeed("{}") };
  const kitty = {
    beginFileTransfer: () =>
      Effect.succeed({
        computer,
        lease: {
          id: "lease",
          remoteId: "bx_test",
          generation: 1,
          expiresAt: Date.now() + TRANSFER_LEASE,
        },
      }),
    validFileTransfer: () => Effect.succeed(valid),
    endFileTransfer: () =>
      Effect.sync(() => {
        released++;
      }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      const url = new URL(input);
      if (url.hostname === "boat.dev") {
        if (url.pathname.endsWith("/bx_test"))
          return Response.json({
            sandbox: {
              id: "bx_test",
              name: "kn-test-g1",
              labels: {
                "kitties.deployment": "fixture",
                "kitties.kitty": "test",
                "kitties.generation": "1",
              },
            },
          });
        if (url.pathname.endsWith("/list"))
          return Response.json({
            path: root,
            truncated: false,
            files: Object.entries(files).map(([path, bytes]) => ({
              name: path.slice(root.length + 1),
              path,
              isDir: false,
              isSymlink: false,
              size: bytes.length,
            })),
          });
        signed++;
        const body = JSON.parse(init?.body as string);
        return Response.json({
          path: body.path,
          method: url.pathname.endsWith("/upload-url") ? "PUT" : "GET",
          url: "https://fixture.on.boat.dev/" + encodeURIComponent(body.path),
        });
      }
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      expect(init?.redirect).toBe("manual");
      const path = decodeURIComponent(url.pathname.slice(1));
      if (init?.method === "PUT") {
        puts++;
        files[path] = new Uint8Array(await new Response(init.body).arrayBuffer());
        return Response.json({ ok: true });
      }
      return new Response(new Uint8Array(files[path]!), {
        headers: { "Content-Length": String(files[path]!.length) },
      });
    }),
  );
  const route = desktopFileHandler(
    {
      BOAT_DEV_API_KEY: "fixture-key",
      KITTIES_DEPLOYMENT: "fixture",
      BLOBS: { get: async () => null },
    },
    { home: () => home, kitty: () => kitty },
  );
  return {
    call: async (suffix = "", init?: RequestInit) =>
      HttpServerResponse.toWeb(
        (await Effect.runPromise(
          route(new Request("https://kitties.test/v1/kitties/test/files" + suffix, init)),
        ))!,
      ),
    fence: () => {
      valid = false;
    },
    stats: () => ({ released, puts, signed, seen, files }),
  };
}

test("authenticated route transfers binary bytes and retains its lease until download consumption", async () => {
  const f = await fixture();
  const data = new Uint8Array(6 * 1024 * 1024);
  data[0] = 255;
  data[data.length - 1] = 128;
  const reply = await f.call("?name=notes.bin&generation=1", {
    method: "POST",
    headers: { "X-File-Size": String(data.length) },
    body: data,
  });
  expect(reply.status).toBe(201);
  const saved = (await reply.json()) as { path: string };
  expect(saved.path).toMatch(/^notes \([a-f0-9-]{36}\)\.bin$/);
  expect(Buffer.from(f.stats().files[root + "/" + saved.path]!).equals(Buffer.from(data))).toBe(
    true,
  );
  expect(f.stats().released).toBe(1);
  const download = await f.call(
    "/download?path=" + encodeURIComponent(saved.path) + "&generation=1",
  );
  expect(download.status).toBe(200);
  expect(f.stats().released).toBe(1);
  expect(Buffer.from(await download.arrayBuffer()).equals(Buffer.from(data))).toBe(true);
  expect(f.stats().released).toBe(2);
  expect(download.headers.get("Content-Disposition")).toContain("attachment");
  expect(download.headers.get("X-Content-Type-Options")).toBe("nosniff");
});

test("stale views, invalid paths and over-limit bodies cannot mint transfer URLs", async () => {
  const f = await fixture();
  expect(
    (
      await f.call("?name=notes.bin&generation=2", {
        method: "POST",
        headers: { "X-File-Size": "1" },
        body: "x",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await f.call("?name=notes.bin&generation=1", {
        method: "POST",
        headers: { "X-File-Size": String(FILE_LIMIT + 1) },
      })
    ).status,
  ).toBe(413);
  expect((await f.call("/download?path=../secret&generation=1")).status).toBe(400);
  f.fence();
  expect((await f.call("/download?path=hello.bin&generation=1")).status).toBe(409);
  expect(f.stats().signed).toBe(0);
  expect(f.stats().puts).toBe(0);
});

test("a failed upload stays leased and is never replayed", async () => {
  const f = await fixture();
  const response = await f.call("?name=short.bin&generation=1", {
    method: "POST",
    headers: { "X-File-Size": "3" },
    body: "x",
  });
  expect(response.status).toBe(400);
  expect(f.stats().released).toBe(0);
  expect(f.stats().puts).toBe(1);
});
