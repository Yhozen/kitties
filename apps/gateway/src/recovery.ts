import * as Match from "effect/Match";
import { stored, ExecutionRecord } from "./stored-records.ts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
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
import { LibraryControl } from "./library-control.ts";
import {
  LibraryRecoveryCoordinator,
  LibraryRestoreRequest,
} from "./library-recovery-coordinator.ts";
import { RecoveryOperationId } from "./library-recovery-records.ts";

const json = <Value>(body: Value, status = 200) =>
  HttpServerResponse.fromWeb(
    Response.json(body, { status, headers: { "Cache-Control": "no-store" } }),
  );

const makeRecovery = Effect.gen(function* () {
  // SAFETY: Gateway deployment declares these named bindings in worker.ts; Cloudflare injects their declared values into every bound actor.
  const env = (yield* Cloudflare.WorkerEnvironment) as {
    KITTIES_KEK: string;
    KITTIES_LIBRARY_CUTOVER_ENABLED: string;
  };

  const libraryControl = yield* LibraryControl;
  const libraryRecovery = yield* LibraryRecoveryCoordinator;
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
    Match.value(kind).pipe(
      Match.when("workflow", () => workflowActor(engine, name, env.KITTIES_KEK)),
      Match.when("home", () => homes.getByName(name, { locationHint: "weur" })),
      Match.when("kitty", () => kitties.getByName(name, { locationHint: "weur" })),
      Match.orElse(() => chats.getByName(name, { locationHint: "weur" })),
    );

  return {
    route: (request: Request) =>
      Effect.gen(function* () {
        const path = new URL(request.url).pathname;

        if (!path.startsWith("/v1/recovery")) return;

        if (path === "/v1/recovery/library" && request.method === "GET")
          return json({ control: yield* libraryControl.status });

        if (path.startsWith("/v1/recovery/library/") && request.method === "POST") {
          if (env.KITTIES_LIBRARY_CUTOVER_ENABLED !== "true")
            return json({ code: "LIBRARY_CUTOVER_DISABLED", params: {} }, 409);

          if (path === "/v1/recovery/library/import") {
            const body = yield* readBody(
              request,
              Schema.Struct({ inventoryId: RecoveryOperationId }),
            );

            return json(yield* home().libraryMigrate(body.inventoryId));
          }

          if (path === "/v1/recovery/library/restore") {
            const body = yield* readBody(request, LibraryRestoreRequest);

            return json(yield* libraryRecovery.restore(body));
          }
        }

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

          const workflow = Match.value(summary[1]).pipe(
            Match.when("export", () => Export),
            Match.when("restore", () => Restore),
            Match.orElse(() => Purge),
          );

          const executionId = stored(ExecutionRecord, record).executionId;

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

          const workflow = Match.value(body.kind).pipe(
            Match.when("export", () => Export),
            Match.when("restore", () => Restore),
            Match.orElse(() => Purge),
          );

          yield* workflow
            .resume(stored(ExecutionRecord, record).executionId)
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
          const previous = yield* root().read("restore", body.operationId);

          if (previous) {
            const saved = stored(
              Schema.Struct({ status: Schema.String, executionId: Schema.String }),
              previous,
            );

            if (saved.status === "completed") return json({ executionId: saved.executionId }, 202);
          }

          const control = yield* root().status();

          if (control.mode !== "ready" && control.operation_id !== body.operationId)
            return json({ code: "RECOVERY_BUSY", params: {} }, 409);
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

export class Recovery extends Context.Service<Recovery, Effect.Success<typeof makeRecovery>>()(
  "@kitties/gateway/Recovery",
) {
  static readonly layer = Layer.effect(Recovery, makeRecovery);
}
