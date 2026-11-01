import * as Cloudflare from "@alchemy.run/cloudflare";
import { Stage } from "alchemy/Stage";
import * as Workflows from "alchemy/Workflows";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { WorkflowEngine } from "effect/workflow";
import { Health, Session } from "@kitties/domain";
import { HomeDO, KittyDO, ChatDO } from "./actors.ts";
import { ownerError } from "./security.ts";
import { AdvancedProbe, AdvancedProbeLive, CallbackProbeDO } from "./workflows/advanced-probe.ts";
import { ContinueProbe, Probe, ProbeLive } from "./workflows/probe.ts";

const props = Effect.gen(function* () {
  const stage = yield* Stage;
  const domain = yield* Config.String("KITTIES_NEXT_DOMAIN").pipe(
    Config.withDefault(
      `${stage === "next" ? "next" : stage === "e2e" ? "e2e" : "dev"}.kitties.rccpr.tech`,
    ),
  );
  const email = yield* Config.String("KITTIES_ACCESS_EMAIL").pipe(
    Config.withDefault("gabriel@garox.org"),
  );
  return {
    main: import.meta.url,
    domain,
    workersDev: false as const,
    limits: { cpuMs: 300000 },
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: true },
      traces: { enabled: true },
      redactQueryString: true,
    },
    assets: {
      directory: new URL("../../web/dist", import.meta.url).pathname,
      runWorkerFirst: true,
      notFoundHandling: "none" as const,
    },
    access: {
      name: `Kitties ${stage}`,
      sessionDuration: "720h",
      policies: [{ decision: "allow" as const, include: [{ email }] }],
    },
    dev: { access: { identity: { email } } },
    env: { PUBLIC_URL: Cloudflare.Worker.URL, ACCESS_EMAIL: email, STAGE: stage },
  };
});
const ProbePayload = Probe.payloadSchema;

export default class Gateway extends Cloudflare.Worker<Gateway>()(
  "Gateway",
  props,
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine;
    const homes = yield* HomeDO;
    yield* KittyDO;
    yield* ChatDO;
    const probes = yield* Workflows.RunWorkflow(Probe);
    const advanced = yield* Workflows.RunWorkflow(AdvancedProbe);
    const callbacks = yield* CallbackProbeDO;
    const env = (yield* Cloudflare.WorkerEnvironment) as {
      PUBLIC_URL: string;
      ACCESS_EMAIL: string;
      STAGE: string;
      ASSETS: { fetch(request: Request): Promise<Response> };
    };
    const json = (body: unknown, status = 200) =>
      HttpServerResponse.fromWeb(
        Response.json(body, { status, headers: { "Cache-Control": "no-store" } }),
      );
    return {
      advancedStart: (payload: typeof AdvancedProbe.payloadSchema.Type) =>
        advanced.start(payload).pipe(Effect.map((run) => run.executionId)),
      advancedStatus: (id: string) => advanced.get(id).status,
      advancedRepair: (id: string, executionId: string) =>
        homes
          .getByName("owner")
          .write("probe-repair", id, "ready")
          .pipe(
            Effect.andThen(
              AdvancedProbe.resume(executionId).pipe(
                Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
              ),
            ),
          ),
      callbackStart: (id: string) => callbacks.getByName(id).start(),
      callbackStatus: (id: string) => callbacks.getByName(id).status(),
      probeSaveReport: (report: string) =>
        homes
          .getByName("owner", { locationHint: "weur" })
          .write("evidence", "engine-cloud", report),
      probeReport: () =>
        homes.getByName("owner", { locationHint: "weur" }).read("evidence", "engine-cloud"),
      probeStart: (payload: typeof ProbePayload.Type) =>
        probes.start(payload).pipe(Effect.map((run) => run.executionId)),
      probeStatus: (id: string) => probes.get(id).status,
      probeSignal: (id: string) => probes.get(id).signal(ContinueProbe, true),
      probeCalls: (id: string) => homes.getByName("owner", { locationHint: "weur" }).probeCalls(id),
      fetch: Effect.gen(function* () {
        const request = yield* Cloudflare.Request;
        const access = yield* Cloudflare.Access.Context;
        const identity = access
          ? yield* access.getIdentity().pipe(Effect.catch(() => Effect.succeed(undefined)))
          : undefined;
        const error = ownerError(request, env.PUBLIC_URL, env.ACCESS_EMAIL, identity);
        if (error) return json(error.body, error.status);
        const url = new URL(request.url);
        if (
          env.STAGE !== "prod" &&
          url.pathname === "/v1/operator/advanced" &&
          request.method === "POST"
        ) {
          const body = yield* Effect.tryPromise(() => request.json());
          const payload = yield* Schema.decodeUnknownEffect(AdvancedProbe.payloadSchema)(body);
          return json({ executionId: (yield* advanced.start(payload)).executionId }, 202);
        }
        const advancedRoute = url.pathname.match(
          /^\/v1\/operator\/advanced\/([a-zA-Z0-9_-]+)(?:\/(repair))?$/,
        );
        if (env.STAGE !== "prod" && advancedRoute) {
          if (request.method === "GET") return json(yield* advanced.get(advancedRoute[1]!).status);
          if (request.method === "POST" && advancedRoute[2] === "repair") {
            yield* homes
              .getByName("owner")
              .write("probe-repair", url.searchParams.get("id") ?? "", "ready");
            yield* AdvancedProbe.resume(advancedRoute[1]!).pipe(
              Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
            );
            return json({ ok: true });
          }
        }
        if (env.STAGE !== "prod" && url.pathname === "/v1/operator/callback") {
          const stub = callbacks.getByName(url.searchParams.get("id") ?? "parking-v1");
          if (request.method === "POST") {
            yield* stub.start();
            return json({ ok: true });
          }
          return json((yield* stub.status()) ?? null);
        }
        if (request.method === "GET" && url.pathname === "/v1/operator/evidence") {
          const report = yield* homes
            .getByName("owner", { locationHint: "weur" })
            .read("evidence", "engine-cloud");
          return json({ engine: report ? JSON.parse(report) : { status: "pending" } });
        }
        if (request.method === "GET" && url.pathname === "/v1/health")
          return json(
            Schema.decodeUnknownSync(Health)({
              ok: true,
              version: "effect-skeleton",
              runtime: "boat",
              stage: env.STAGE,
            }),
          );
        if (request.method === "GET" && url.pathname === "/v1/session")
          return json(
            Schema.decodeUnknownSync(Session)({
              signed_in: true,
              email: identity!.email,
              logout_url: "/cdn-cgi/access/logout",
            }),
          );
        if (
          env.STAGE !== "prod" &&
          url.pathname === "/v1/operator/probes" &&
          request.method === "POST"
        ) {
          const body = yield* Effect.tryPromise(() => request.json()).pipe(
            Effect.catch(() => Effect.succeed(null)),
          );
          const payload = yield* Schema.decodeUnknownEffect(ProbePayload)(body).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          );
          if (
            !payload ||
            payload.steps < 1 ||
            payload.steps > 500 ||
            !Number.isInteger(payload.steps) ||
            payload.delayMs < 0 ||
            payload.delayMs > 900000
          )
            return json({ code: "INVALID_REQUEST", params: {} }, 400);
          const run = yield* probes.start(payload);
          return json({ executionId: run.executionId }, 202);
        }
        const probeRoute = url.pathname.match(
          /^\/v1\/operator\/probes\/([a-zA-Z0-9_-]+)(?:\/(signal|calls|interrupt))?$/,
        );
        if (env.STAGE !== "prod" && probeRoute) {
          const run = probes.get(probeRoute[1]!);
          if (request.method === "GET" && !probeRoute[2]) return json(yield* run.status);
          if (request.method === "GET" && probeRoute[2] === "calls")
            return json(
              yield* homes
                .getByName("owner", { locationHint: "weur" })
                .probeCalls(url.searchParams.get("id") ?? probeRoute[1]!),
            );
          if (request.method === "POST" && probeRoute[2] === "signal") {
            yield* run.signal(ContinueProbe, true);
            return json({ ok: true });
          }
          if (request.method === "POST" && probeRoute[2] === "interrupt") {
            yield* run.interrupt;
            return json({ ok: true });
          }
        }
        if (
          url.pathname.startsWith("/v1/") ||
          url.pathname.startsWith("/guest/") ||
          url.pathname.startsWith("/hooks/") ||
          url.pathname.startsWith("/.well-known/")
        )
          return json({ code: "NOT_FOUND", params: {} }, 404);
        if (request.method !== "GET" && request.method !== "HEAD")
          return json({ code: "NOT_FOUND", params: {} }, 404);
        return HttpServerResponse.fromWeb(yield* Effect.promise(() => env.ASSETS.fetch(request)));
      }).pipe(Effect.catch(() => Effect.succeed(json({ code: "UNAVAILABLE", params: {} }, 503)))),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(ProbeLive, AdvancedProbeLive).pipe(
        Layer.provideMerge(Cloudflare.Workflows.DurableObjectEngine),
      ),
    ),
  ),
) {}

// Workerd restart acceptance revision 1.
