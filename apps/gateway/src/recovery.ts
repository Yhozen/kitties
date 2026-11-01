import * as Cloudflare from "@alchemy.run/cloudflare";
import { workflowActor } from "./workflow-admin.ts";
import { WorkflowEngine } from "effect/workflow";
import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { HomeDO, ChatDO, KittyDO } from "./actors.ts";
import { RecoveryDO } from "./recovery-store.ts";
import { Export, Restore, Purge } from "./recovery-definition.ts";
import { readBody } from "./request.ts";
const json = (body: unknown, status = 200) =>
  HttpServerResponse.fromWeb(
    Response.json(body, { status, headers: { "Cache-Control": "no-store" } }),
  );
export const makeRecovery = Effect.gen(function* () {
  const env = (yield* Cloudflare.WorkerEnvironment) as { KITTIES_KEK: string };
  const engine = yield* WorkflowEngine.WorkflowEngine;
  const homes = yield* HomeDO,
    chats = yield* ChatDO,
    kitties = yield* KittyDO,
    roots = yield* RecoveryDO;
  const root = () => roots.getByName("control", { locationHint: "weur" }),
    home = () => homes.getByName("owner", { locationHint: "weur" });
  const purges = yield* Workflows.RunWorkflow(Purge);
  const exports = yield* Workflows.RunWorkflow(Export),
    restores = yield* Workflows.RunWorkflow(Restore);
  const discover = Effect.gen(function* () {
    const entries = [{ kind: "home", name: "owner" }];
    for (const kind of ["kitty", "chat"])
      for (const row of yield* home().list(kind)) entries.push({ kind, name: row.id });
    yield* root().registerMany(entries);
  });
  const actor = (kind: string, name: string) =>
    kind === "workflow"
      ? workflowActor(engine, name, env.KITTIES_KEK)
      : kind === "home"
        ? homes.getByName(name, { locationHint: "weur" })
        : kind === "kitty"
          ? kitties.getByName(name, { locationHint: "weur" })
          : chats.getByName(name, { locationHint: "weur" });
  return {
    route: (request: Request) =>
      Effect.gen(function* () {
        const path = new URL(request.url).pathname;
        if (!path.startsWith("/v1/recovery")) return;
        yield* discover;
        if (path === "/v1/recovery" && request.method === "GET")
          return json({
            control: yield* root().status(),
            objects: yield* root().objects(),
            exports: (yield* root().list("export")).map((r) => JSON.parse(r.body)),
            restores: (yield* root().list("restore")).map((r) => JSON.parse(r.body)),
            reviews: yield* root().reviews(),
            purges: (yield* root().list("purge")).map((r) => JSON.parse(r.body)),
          });
        const summary = path.match(
          /^\/v1\/recovery\/run\/(export|restore|purge)\/([a-zA-Z0-9_-]{1,128})$/,
        );
        if (summary && request.method === "GET") {
          const record = yield* root().read(summary[1]!, summary[2]!);
          if (!record) return json({ code: "NOT_FOUND", params: {} }, 404);
          const workflow =
            summary[1] === "export" ? Export : summary[1] === "restore" ? Restore : Purge;
          const executionId = (JSON.parse(record) as { executionId: string }).executionId;
          return json(
            yield* workflowActor(
              engine,
              `${workflow._tag}/${executionId}`,
              env.KITTIES_KEK,
            ).adminSummary(),
          );
        }
        if (path === "/v1/recovery/resume" && request.method === "POST") {
          const body = yield* readBody(
            request,
            Schema.Struct({
              kind: Schema.Literals(["export", "restore", "purge"]),
              operationId: Schema.String,
            }),
          );
          const record = yield* root().read(body.kind, body.operationId);
          if (!record) return json({ code: "NOT_FOUND", params: {} }, 404);
          const workflow =
            body.kind === "export" ? Export : body.kind === "restore" ? Restore : Purge;
          yield* workflow
            .resume((JSON.parse(record) as { executionId: string }).executionId)
            .pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine));
          return json({ ok: true });
        }
        if (path === "/v1/recovery/purge" && request.method === "POST") {
          const body = yield* readBody(request, Schema.Struct({ operationId: Schema.String }));
          return json(
            {
              executionId: (yield* purges.start({
                id: body.operationId,
                before: Date.now() - 30 * 86400000,
              })).executionId,
            },
            202,
          );
        }
        if (path === "/v1/recovery/exports" && request.method === "POST") {
          const body = yield* readBody(
            request,
            Schema.Struct({
              operationId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/)),
            }),
          );
          return json(
            { executionId: (yield* exports.start({ id: body.operationId })).executionId },
            202,
          );
        }
        if (path === "/v1/recovery/bookmark" && request.method === "POST") {
          const body = yield* readBody(
            request,
            Schema.Struct({
              kind: Schema.Literals(["home", "kitty", "chat", "workflow"]),
              name: Schema.String,
              at: Schema.optional(Schema.Number),
            }),
          );
          if (!(yield* root().objects()).some((o) => o.kind === body.kind && o.name === body.name))
            return json({ code: "NOT_FOUND", params: {} }, 404);
          return json({ bookmark: yield* actor(body.kind, body.name).adminBookmark(body.at) });
        }
        if (path === "/v1/recovery/restore" && request.method === "POST") {
          const body = yield* readBody(
            request,
            Schema.Struct({
              operationId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/)),
              kind: Restore.payloadSchema.fields.kind,
              name: Schema.String,
              bookmark: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{40,128}$/)),
            }),
          );
          if (!(yield* root().objects()).some((o) => o.kind === body.kind && o.name === body.name))
            return json({ code: "NOT_FOUND", params: {} }, 404);
          if (!(yield* root().claim("restore-request", body.operationId, JSON.stringify(body))))
            return json({ code: "OPERATION_CONFLICT", params: {} }, 409);
          yield* root().begin(body.operationId);
          return json(
            {
              executionId: (yield* restores.start({
                id: body.operationId,
                kind: body.kind,
                name: body.name,
                bookmark: body.bookmark,
              })).executionId,
            },
            202,
          );
        }
        return json({ code: "NOT_FOUND", params: {} }, 404);
      }),
    discover,
    actor,
    tick: () =>
      Effect.gen(function* () {
        const now = new Date();
        if (now.getUTCHours() !== 3 || now.getUTCMinutes() !== 0) return;
        if ((yield* root().status()).mode !== "ready") return;
        yield* discover;
        const id = `daily-${now.toISOString().slice(0, 10)}`;
        yield* exports.start({ id });
        yield* purges.start({ id, before: Date.now() - 30 * 86400000 });
      }),
    ready: () =>
      root()
        .status()
        .pipe(Effect.map((status) => status.mode === "ready")),
  };
});
