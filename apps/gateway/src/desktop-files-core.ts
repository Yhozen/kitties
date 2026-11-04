// Files use Boat's raw-byte transfer lane; input and video sockets never carry file data.
export const SHARED_ROOT = "/home/user/.kitties/shared";
export const FILE_LIMIT = 64 * 1024 * 1024;
export const TRANSFER_TIMEOUT = 5 * 60_000;
export const TRANSFER_LEASE = TRANSFER_TIMEOUT + 60_000;
export class FileError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export function relativeFilePath(value: string, directory = false): string {
  if (directory && value === "") return value;
  const parts = value.split("/");
  if (
    parts.length > 12 ||
    new TextEncoder().encode(value).length > 1024 ||
    parts.some(
      (part) =>
        !part ||
        part.startsWith(".") ||
        part.includes("\\") ||
        part.split("").some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
        new TextEncoder().encode(part).length > 240,
    )
  )
    throw new FileError("INVALID_FILE_PATH");
  return value;
}
export function uploadFileName(value: string, id: string): string {
  relativeFilePath(value);
  if (value.includes("/")) throw new FileError("INVALID_FILE_NAME");
  // Every upload gets a new destination; retrying never silently overwrites a desktop file.
  const dot = value.lastIndexOf(".");
  const stem = dot > 0 ? value.slice(0, dot) : value;
  const suffix = dot > 0 ? value.slice(dot) : "";
  const name = `${stem} (${id})${suffix}`;
  relativeFilePath(name);
  return name;
}
export function attachmentName(name: string): string {
  const ascii = name.replace(/[^a-zA-Z0-9_. -]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16)}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
export interface BoatFile {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  modifiedAt: string;
}
export interface FileListing {
  path: string;
  files: BoatFile[];
  truncated: boolean;
}
export interface FileUrl {
  path: string;
  method: string;
  url: string;
}
export function transferUrl(reply: FileUrl, path: string, method: string): string {
  const url = new URL(reply.url);
  // Boat binds URLs to canonical paths. Reject symlinks and unexpected destinations.
  if (
    reply.path !== path ||
    reply.method !== method ||
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".on.boat.dev") ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    throw new FileError("FILE_DESTINATION_DENIED", 502);
  return url.href;
}
export function fileListing(reply: FileListing, relative: string) {
  const path = SHARED_ROOT + (relative ? "/" + relative : "");
  if (reply.path !== path) throw new FileError("FILE_DESTINATION_DENIED", 502);
  return {
    path: relative,
    truncated: reply.truncated,
    files: reply.files.flatMap((file) => {
      try {
        relativeFilePath(file.name);
        if (file.name.includes("/") || file.isSymlink || file.path !== path + "/" + file.name)
          return [];
        return [
          {
            name: file.name,
            path: relative ? relative + "/" + file.name : file.name,
            directory: file.isDir,
            size: file.size,
            modifiedAt: file.modifiedAt,
          },
        ];
      } catch {
        return [];
      }
    }),
  };
}
// Pull one chunk at a time. A slow reader applies backpressure instead of buffering the file.
export function fileStream(
  source: ReadableStream<Uint8Array>,
  options: {
    signal: AbortSignal;
    expected?: number;
    finished: (complete: boolean) => Promise<void>;
  },
) {
  const reader = source.getReader();
  let bytes = 0,
    ended = false;
  const finish = async (complete: boolean) => {
    if (ended) return;
    ended = true;
    options.signal.removeEventListener("abort", aborted);
    await options.finished(complete).catch(() => {});
  };
  let target: ReadableStreamDefaultController<Uint8Array>;
  const aborted = () => {
    if (ended) return;
    target.error(new FileError("FILE_TRANSFER_INTERRUPTED", 408));
    void reader.cancel().catch(() => {});
    void finish(false).catch(() => {});
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        target = controller;
        options.signal.addEventListener("abort", aborted, { once: true });
        if (options.signal.aborted) aborted();
      },
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (ended) return;
          if (chunk.done) {
            if (options.expected !== undefined && bytes !== options.expected)
              throw new FileError("FILE_SIZE_MISMATCH");
            await finish(true);
            controller.close();
          } else {
            bytes += chunk.value.byteLength;
            if (bytes > FILE_LIMIT || (options.expected !== undefined && bytes > options.expected))
              throw new FileError("FILE_TOO_LARGE", 413);
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          if (!ended) controller.error(error);
          await reader.cancel().catch(() => {});
          await finish(false);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => {});
        await finish(false);
      },
    },
    { highWaterMark: 0 },
  );
}
