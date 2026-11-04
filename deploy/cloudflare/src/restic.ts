export interface ResticBucket {
  get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
  head(key: string): Promise<{ size: number } | null>;
  put(
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(options: {
    prefix: string;
    cursor?: string;
  }): Promise<{
    objects: { key: string; size: number }[];
    truncated: boolean;
    cursor?: string;
  }>;
}

const TYPES = "data|keys|locks|snapshots|index";
const FILE = new RegExp(`^/(?:config|(?:${TYPES})/[a-f0-9]{64})$`);
const DIRECTORY = new RegExp(`^/(${TYPES})/$`);
const PREFIX = "restic/";
const CONTENT_V2 = "application/vnd.x.restic.rest.v2";
const MAX_OBJECT = 512 * 1024 * 1024;

// Restic's documented REST protocol, backed by a separate private R2 bucket.
export class ResticRepository {
  constructor(private readonly bucket: ResticBucket) {}

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      if (
        request.method === "POST" &&
        url.searchParams.get("create") === "true"
      )
        return new Response(null, { status: 200 });
      return new Response("Repository deletion is unavailable", {
        status: 501,
      });
    }
    const directory = DIRECTORY.exec(url.pathname);
    if (directory && request.method === "GET")
      return this.list(
        directory[1],
        request.headers.get("Accept") === CONTENT_V2,
      );
    if (!FILE.test(url.pathname))
      return new Response("Not found", { status: 404 });
    const key = PREFIX + url.pathname.slice(1);
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Content-Type": "application/octet-stream",
    });
    if (request.method === "HEAD") {
      const object = await this.bucket.head(key);
      if (!object) return new Response(null, { status: 404 });
      headers.set("Content-Length", String(object.size));
      return new Response(null, { headers });
    }
    if (request.method === "GET") {
      const rawRange = request.headers.get("Range");
      let range: { offset: number; length: number } | undefined;
      if (rawRange !== null) {
        const object = await this.bucket.head(key);
        if (!object) return new Response(null, { status: 404 });
        range = parseRange(rawRange, object.size);
        if (!range)
          return new Response(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${object.size}` },
          });
        headers.set(
          "Content-Range",
          `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`,
        );
      }
      const object = await this.bucket.get(key, range ? { range } : undefined);
      if (!object) return new Response(null, { status: 404 });
      headers.set("Content-Length", String(range?.length ?? object.size));
      headers.set("Accept-Ranges", "bytes");
      return new Response(object.body, { status: range ? 206 : 200, headers });
    }
    if (request.method === "POST") {
      const length = Number(request.headers.get("Content-Length"));
      if (
        !request.headers.has("Content-Length") ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_OBJECT
      )
        return new Response("A Content-Length up to 512 MiB is required", {
          status: 413,
        });
      await this.bucket.put(key, request.body ?? new Uint8Array());
      return new Response(null, { status: 200 });
    }
    if (request.method === "DELETE") {
      await this.bucket.delete(key);
      return new Response(null, { status: 200 });
    }
    return new Response("Method not allowed", { status: 405 });
  }

  private list(type: string, version2: boolean): Response {
    const prefix = `${PREFIX}${type}/`;
    let cursor: string | undefined;
    let started = false;
    let first = true;
    let done = false;
    const seen = new Set<string>();
    const encoder = new TextEncoder();
    const bucket = this.bucket;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!started) {
          controller.enqueue(encoder.encode("["));
          started = true;
        }
        if (done) {
          controller.enqueue(encoder.encode("]"));
          controller.close();
          return;
        }
        const page = await bucket.list({ prefix, cursor });
        const entries = page.objects.map((object) => {
          const name = object.key.slice(prefix.length);
          const value = JSON.stringify(
            version2 ? { name, size: object.size } : name,
          );
          const separator = first ? "" : ",";
          first = false;
          return separator + value;
        });
        if (entries.length)
          controller.enqueue(encoder.encode(entries.join("")));
        if (page.truncated) {
          if (!page.cursor || seen.has(page.cursor))
            throw new Error("Backup listing did not advance");
          cursor = page.cursor;
          seen.add(cursor);
        } else done = true;
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": version2
          ? CONTENT_V2
          : "application/vnd.x.restic.rest.v1",
        "Cache-Control": "no-store",
      },
    });
  }
}

function parseRange(
  raw: string,
  size: number,
): { offset: number; length: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!match || (!match[1] && !match[2]) || size <= 0) return;
  const start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  const end =
    match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start ||
    (!match[1] && Number(match[2]) <= 0)
  )
    return;
  return { offset: start, length: end - start + 1 };
}
