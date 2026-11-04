import { blobStream } from "./blob-stream.ts";
import * as Schema from "effect/Schema";
import { stored, NameRecord } from "./stored-records.ts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type { ComputerState } from "./computer-state.ts";
import type { FileLease } from "./file-leases.ts";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as cf from "@cloudflare/workers-types";
import { HomeDO, KittyDO } from "./actors.ts";
import { boatClient, BoatError, ownsSandbox } from "./boat.ts";
import {
  SHARED_ROOT,
  FILE_LIMIT,
  TRANSFER_TIMEOUT,
  FileError,
  relativeFilePath,
  uploadFileName,
  attachmentName,
  transferUrl,
  fileListing,
  fileStream,
  type FileListing,
  type FileUrl,
} from "./desktop-files-core.ts";

const FileListingResponse: Schema.Codec<FileListing> = Schema.Struct({
  path: Schema.String,
  files: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        path: Schema.String,
        isDir: Schema.Boolean,
        isSymlink: Schema.Boolean,
        size: Schema.Number,
        modifiedAt: Schema.String,
      }),
    ),
  ),
  truncated: Schema.Boolean,
});

const FileUrlResponse: Schema.Codec<FileUrl> = Schema.Struct({
  path: Schema.String,
  method: Schema.String,
  url: Schema.String,
});

const json = <Value>(value: Value, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

interface FileEnvironment {
  BOAT_DEV_API_KEY: string;
  KITTIES_DEPLOYMENT: string;
  BLOBS: Pick<cf.R2Bucket, "get">;
}

interface FilePorts<ReadError, TransferError> {
  home: () => { read: (kind: string, id: string) => Effect.Effect<string | null, ReadError> };
  kitty: (id: string) => {
    beginFileTransfer: () => Effect.Effect<
      { lease: FileLease; computer: ComputerState },
      TransferError
    >;
    validFileTransfer: (id: string) => Effect.Effect<boolean, TransferError>;
    endFileTransfer: (id: string) => Effect.Effect<void, TransferError>;
  };
}

const makeDesktopFiles = Effect.gen(function* () {
  const homes = yield* HomeDO,
    kitties = yield* KittyDO;

  // SAFETY: Gateway deployment declares these named bindings in worker.ts; Cloudflare injects their declared values into every bound actor.
  const env = (yield* Cloudflare.WorkerEnvironment) as FileEnvironment;

  return desktopFileHandler(env, {
    home: () => homes.getByName("owner", { locationHint: "weur" }),
    kitty: (id) => kitties.getByName(id, { locationHint: "weur" }),
  });
});

export function desktopFileHandler<ReadError, TransferError>(
  env: FileEnvironment,
  ports: FilePorts<ReadError, TransferError>,
) {
  const boat = boatClient(env.BOAT_DEV_API_KEY);

  return (request: Request) =>
    Effect.gen(function* () {
      const url = new URL(request.url);

      const match = url.pathname.match(
        /^\/v1\/kitties\/([a-zA-Z0-9_-]{1,128})\/files(?:\/(download|from-library))?$/,
      );

      if (!match) return undefined;

      const id = match[1]!,
        action = match[2];

      const home = ports.home();
      const kitty = ports.kitty(id);

      const response = yield* Effect.tryPromise({
        try: async () => {
          if (!(await Effect.runPromise(home.read("kitty", id))))
            throw new FileError("KITTY_NOT_FOUND", 404);
          const upload = request.method === "POST" && (!action || action === "from-library");

          if (!upload && (request.method !== "GET" || action === "from-library"))
            throw new FileError("METHOD_NOT_ALLOWED", 405);

          const relative = relativeFilePath(
            url.searchParams.get("path") ?? "",
            action !== "download",
          );

          let size: number | undefined,
            body: ReadableStream<Uint8Array> | null = null,
            name = "";

          if (upload) {
            if (action === "from-library") {
              const artifact = url.searchParams.get("artifact") ?? "";

              if (!/^[a-zA-Z0-9_.-]{1,160}$/.test(artifact)) throw new FileError("NOT_FOUND", 404);
              const saved = await Effect.runPromise(home.read("artifact", artifact));

              if (!saved) throw new FileError("NOT_FOUND", 404);
              const blob = await env.BLOBS.get("artifacts/" + artifact);

              if (!blob) throw new FileError("NOT_FOUND", 404);
              name = stored(NameRecord, saved).name;
              size = blob.size;
              body = blobStream(blob.body);
            } else {
              name = url.searchParams.get("name") ?? "";
              const header = request.headers.get("X-File-Size");

              if (!header || !/^\d+$/.test(header)) throw new FileError("FILE_SIZE_REQUIRED", 411);
              size = Number(header);
              body = request.body;
            }

            if (!Number.isSafeInteger(size) || size! < 0 || size! > FILE_LIMIT)
              throw new FileError("FILE_TOO_LARGE", 413);
            name = uploadFileName(name, crypto.randomUUID());
          }

          const { lease, computer } = await Effect.runPromise(kitty.beginFileTransfer()).catch(
            () => {
              throw new FileError("COMPUTER_NOT_READY_OR_BUSY", 409);
            },
          );

          let handedOff = false,
            uncertainUpload = false;

          const release = () => Effect.runPromise(kitty.endFileTransfer(lease.id)).catch(() => {});
          const signal = AbortSignal.any([request.signal, AbortSignal.timeout(TRANSFER_TIMEOUT)]);

          const valid = async () => {
            if (signal.aborted || !(await Effect.runPromise(kitty.validFileTransfer(lease.id))))
              throw new FileError("FILE_TRANSFER_INTERRUPTED", 409);
          };

          const apiPath = `/sandboxes/${encodeURIComponent(lease.remoteId)}/files`;

          const api = <A>(
            method: string,
            path: string,
            responseSchema: Schema.Codec<A>,
            payload?: Schema.Json,
          ) =>
            Effect.runPromise(
              boat
                .request(method, apiPath + path, responseSchema, payload)
                .pipe(
                  Effect.mapError(
                    (error) =>
                      new FileError(
                        error.status === 404
                          ? "FILE_NOT_FOUND_OR_SHARING_NOT_READY"
                          : "FILE_SERVICE_UNAVAILABLE",
                        error.status === 404 ? 404 : 502,
                      ),
                  ),
                ),
            );

          try {
            const requestedGeneration = url.searchParams.get("generation");

            if (
              (upload || action === "download") &&
              requestedGeneration !== String(lease.generation)
            )
              throw new FileError("COMPUTER_CHANGED", 409);
            const sandbox = await Effect.runPromise(boat.get(lease.remoteId));

            if (
              !ownsSandbox(sandbox, env.KITTIES_DEPLOYMENT, id, lease.generation, computer.receipt)
            )
              throw new FileError("COMPUTER_OWNERSHIP_MISMATCH", 409);
            const directory = SHARED_ROOT + (relative ? "/" + relative : "");

            if (!upload && !action) {
              const listing = fileListing(
                await api(
                  "GET",
                  "/list?path=" + encodeURIComponent(directory),
                  FileListingResponse,
                ),
                relative,
              );

              await valid();

              return json({ ...listing, generation: lease.generation });
            }

            // Check the directory before upload; missing provisioning must not silently create an
            // inaccessible folder. For download also reject symlinks/special entries before signing.
            const parent = upload ? relative : relative.split("/").slice(0, -1).join("/");
            const parentPath = SHARED_ROOT + (parent ? "/" + parent : "");

            const listing = fileListing(
              await api("GET", "/list?path=" + encodeURIComponent(parentPath), FileListingResponse),
              parent,
            );

            if (!upload) {
              const entry = listing.files.find((file) => file.path === relative && !file.directory);

              if (!entry) throw new FileError("FILE_NOT_FOUND", 404);

              if (entry.size > FILE_LIMIT) throw new FileError("FILE_TOO_LARGE", 413);
              name = entry.name;
            }

            const path = upload ? directory + "/" + name : directory;
            await valid();

            const signed = await api(
              "POST",
              upload ? "/upload-url" : "/download-url",
              FileUrlResponse,
              {
                path,
                ttlSeconds: 60,
              },
            );

            const destination = transferUrl(signed, path, upload ? "PUT" : "GET");
            await valid();
            uncertainUpload = upload;

            const init: RequestInit = {
              method: upload ? "PUT" : "GET",
              redirect: "manual",
              signal,
            };

            if (upload) {
              init.headers = { "Content-Type": "application/octet-stream" };
              init.body = fileStream(
                body ??
                  new ReadableStream({
                    start(c) {
                      c.close();
                    },
                  }),
                { signal, expected: size, finished: async () => {} },
              );
            }

            const upstream = await fetch(destination, init);

            if (!upstream.ok) {
              await upstream.body?.cancel();
              throw new FileError("FILE_TRANSFER_FAILED", 502);
            }

            if (upload) {
              await upstream.body?.cancel();
              uncertainUpload = false;
              await valid();

              return json(
                {
                  name,
                  path: relative ? relative + "/" + name : name,
                  size,
                  generation: lease.generation,
                },
                201,
              );
            }

            if (!upstream.body) throw new FileError("FILE_TRANSFER_FAILED", 502);
            await valid();
            const length = upstream.headers.get("Content-Length");
            const expected = length !== null && /^\d+$/.test(length) ? Number(length) : undefined;

            if (expected !== undefined && expected > FILE_LIMIT) {
              await upstream.body.cancel();
              throw new FileError("FILE_TOO_LARGE", 413);
            }

            handedOff = true;

            const headers = new Headers({
              "Content-Type": "application/octet-stream",
              "Content-Disposition": attachmentName(name),
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "private, no-store",
            });

            if (expected !== undefined) headers.set("Content-Length", String(expected));

            return new Response(
              fileStream(upstream.body, { signal, expected, finished: release }),
              { headers },
            );
          } finally {
            // An interrupted PUT may still commit remotely. Keep its bounded lease until expiry;
            // never retry it automatically or claim cancellation proves the file was not written.
            if (!handedOff && !uncertainUpload) await release();
          }
        },
        catch: (error) =>
          error instanceof FileError
            ? error
            : new FileError(
                error instanceof BoatError
                  ? "FILE_SERVICE_UNAVAILABLE"
                  : "FILE_TRANSFER_INTERRUPTED",
                502,
              ),
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            json(
              {
                code: error.code,
                params: {},
              },
              error.status,
            ),
          ),
        ),
      );

      return HttpServerResponse.fromWeb(response);
    });
}

export class DesktopFiles extends Context.Service<
  DesktopFiles,
  Effect.Success<typeof makeDesktopFiles>
>()("@kitties/gateway/DesktopFiles") {
  static readonly layer = Layer.effect(DesktopFiles, makeDesktopFiles);
}
