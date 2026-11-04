import { FILE_LIMIT, attachmentName, relativeFilePath } from "./desktop-files-core.ts";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as cf from "@cloudflare/workers-types";
import { HomeDO, KittyDO } from "./actors.ts";
import { DesktopAttempt, DesktopDecision } from "./desktop-definition.ts";
import { seal } from "./secrets.ts";
import { readBody } from "./request.ts";
const json = (value: unknown, status = 200) =>
  HttpServerResponse.fromWeb(
    Response.json(value, { status, headers: { "Cache-Control": "no-store" } }),
  );
export const makeOwnerData = Effect.gen(function* () {
  const homes = yield* HomeDO,
    kitties = yield* KittyDO,
    desktop = yield* Workflows.RunWorkflow(DesktopAttempt);
  const env = (yield* Cloudflare.WorkerEnvironment) as { KITTIES_KEK: string; BLOBS: cf.R2Bucket };
  return (request: Request) =>
    Effect.gen(function* () {
      const home = homes.getByName("owner", { locationHint: "weur" }),
        path = new URL(request.url).pathname,
        method = request.method;
      if (path === "/v1/vault" && method === "GET")
        return json(
          (yield* home.list("vault")).map((row) => {
            const saved = JSON.parse(row.body) as { name: string; updatedAt: number };
            return { id: row.id, name: saved.name, updatedAt: saved.updatedAt };
          }),
        );
      const vault = path.match(/^\/v1\/vault\/([a-zA-Z0-9_-]{1,128})$/);
      if (vault) {
        const id = vault[1]!;
        if (method === "PUT") {
          const body = yield* readBody(
            request,
            Schema.Struct({
              name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
              value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16000)),
            }),
          );
          const secret = yield* Effect.tryPromise({
            try: () => seal(env.KITTIES_KEK, `vault:${id}:value`, body.value),
            catch: () => "KEY_UNAVAILABLE",
          });
          yield* home.write(
            "vault",
            id,
            JSON.stringify({ name: body.name, secret, updatedAt: Date.now() }),
          );
          return json({ id, name: body.name });
        }
        if (method === "DELETE") {
          yield* home.remove("vault", id);
          return HttpServerResponse.empty({ status: 204 });
        }
      }
      if (path === "/v1/help" && method === "GET")
        return json(
          (yield* home.list("desktop-help"))
            .map((row) => ({ id: row.id, ...JSON.parse(row.body) }))
            .filter((row) => row.status === "pending"),
        );
      const help = path.match(/^\/v1\/help\/([^/]+)\/decision$/);
      if (help && method === "POST") {
        const id = decodeURIComponent(help[1]!),
          body = yield* readBody(
            request,
            Schema.Struct({ decision: Schema.Literals(["accept", "skip"]) }),
          );
        const saved = yield* home.read("desktop-help", id);
        if (!saved) return json({ code: "NOT_FOUND", params: {} }, 404);
        const row = JSON.parse(saved) as {
          status: string;
          expiresAt: number;
          executionId: string;
          kittyId: string;
        };
        if (row.status !== "pending" || row.expiresAt <= Date.now())
          return json({ code: "HELP_CONFLICT", params: {} }, 409);
        if ((yield* kitties.getByName(row.kittyId, { locationHint: "weur" }).status()).grant)
          return json({ code: "CONTROL_MUST_BE_RELEASED", params: {} }, 409);
        const claimed = yield* home.decideHelp(id, body.decision);
        if (!claimed) return json({ code: "HELP_CONFLICT", params: {} }, 409);
        yield* desktop.get(row.executionId).signal(DesktopDecision, body.decision);
        return json({ ok: true });
      }
      if (path === "/v1/artifacts" && method === "GET")
        return json(
          (yield* home.list("artifact")).map((row) => ({ id: row.id, ...JSON.parse(row.body) })),
        );
      const artifact = path.match(/^\/v1\/artifacts\/(.+)$/);
      if (artifact) {
        const id = decodeURIComponent(artifact[1]!);
        if (!/^(?:screenshots\/[a-zA-Z0-9_-]+\/[0-9]+\/)?[a-zA-Z0-9_.-]{1,160}$/.test(id))
          return json({ code: "NOT_FOUND", params: {} }, 404);
        const key = id.startsWith("screenshots/") ? id : "artifacts/" + id;
        if (method === "GET") {
          const blob = yield* Effect.promise(() => env.BLOBS.get(key));
          if (!blob) return json({ code: "NOT_FOUND", params: {} }, 404);
          const saved = id.startsWith("screenshots/") ? null : yield* home.read("artifact", id);
          const filename = saved ? (JSON.parse(saved) as { name: string }).name : id;
          return HttpServerResponse.fromWeb(
            new Response(blob.body as unknown as ReadableStream, {
              headers: {
                "Content-Type": id.startsWith("screenshots/")
                  ? "image/jpeg"
                  : "application/octet-stream",
                "Content-Disposition": id.startsWith("screenshots/")
                  ? "inline"
                  : attachmentName(filename),
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": "private, no-store",
              },
            }),
          );
        }
        if (method === "PUT" && !id.startsWith("screenshots/")) {
          const header = request.headers.get("Content-Length");
          if (!header || !/^\d+$/.test(header))
            return json({ code: "FILE_SIZE_REQUIRED", params: {} }, 411);
          const size = Number(header);
          if (!Number.isSafeInteger(size) || size > FILE_LIMIT)
            return json({ code: "FILE_TOO_LARGE", params: {} }, 413);
          const name = new URL(request.url).searchParams.get("name") ?? id;
          const validName = yield* Effect.try(() => relativeFilePath(name)).pipe(
            Effect.catch(() => Effect.succeed(null)),
          );
          if (!validName || name.includes("/"))
            return json({ code: "INVALID_FILE_NAME", params: {} }, 400);
          // The incoming HTTP body has a known Content-Length. Pass it straight to R2;
          // buffering or wrapping it would lose that length and consume Worker memory.
          yield* Effect.promise(() =>
            env.BLOBS.put(
              key,
              (request.body ?? new Uint8Array()) as Parameters<cf.R2Bucket["put"]>[1],
            ),
          );
          const row = { name, size, updatedAt: Date.now() };
          yield* home.write("artifact", id, JSON.stringify(row));
          return json({ id, ...row }, 201);
        }
      }
      return undefined;
    });
});
