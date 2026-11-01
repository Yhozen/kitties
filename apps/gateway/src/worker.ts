import * as Cloudflare from "@alchemy.run/cloudflare";
import { Stage } from "alchemy/Stage";
import * as Workflows from "alchemy/Workflows";
import * as Config from "effect/Config";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { GuestAssets } from "./resources.ts";
import { WorkflowEngine } from "effect/workflow";
import { Health, Session } from "@kitties/domain";
import { HomeDO, KittyDO, ChatDO } from "./actors.ts";
import { ChatDOLive } from "./chat.ts";
import { DesktopAttemptLive } from "./workflows/desktop.ts";
import { ComputerOpLive } from "./workflows/computer.ts";
import { TurnLive } from "./workflows/turn.ts";
import { DistillLive } from "./workflows/distill.ts";
import { DelegationLive } from "./workflows/delegation.ts";
import { GoalSlotLive } from "./workflows/goal.ts";
import { makeAutonomy } from "./autonomy.ts";
import { makeWebhooks } from "./webhooks.ts";
import { TimerProbe, TimerProbeLive } from "./workflows/timer-probe.ts";
import { NotifyLive } from "./workflows/notify.ts";
import { makeNotifications } from "./notifications.ts";
import { ApprovalLive } from "./workflows/approval.ts";
import { makeLifecycle } from "./lifecycle.ts";
import { chatEvents } from "./chat-stream.ts";
import * as Stream from "effect/Stream";
import { makeOAuth } from "./oauth.ts";
import { makeApplication } from "./application.ts";
import { ownerError } from "./security.ts";
import type { GuestConfig } from "./kitty.ts";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
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
  const kek = yield* Config.Redacted("KITTIES_KEK");
  const releaseKey = yield* Config.Redacted("KITTIES_RELEASE_KEY");
  const deployment = yield* Config.String("KITTIES_DEPLOYMENT");
  const boatKey = yield* Config.Redacted("BOAT_DEV_API_KEY");
  const blobs = yield* GuestAssets;
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
    dev: { port: 1337, strictPort: true, access: { identity: { email } } },
    env: {
      PUBLIC_URL: Cloudflare.Worker.URL,
      ACCESS_EMAIL: email,
      CHATGPT_ENABLED: yield* Config.String("KITTIES_CHATGPT_ENABLED").pipe(
        Config.withDefault("false"),
      ),
      STAGE: stage,
      KITTIES_KEK: kek,
      BOAT_DEV_API_KEY: boatKey,
      KITTIES_DEPLOYMENT: deployment,
      KITTIES_RELEASE_KEY: releaseKey,
      GUEST_URL:
        stage === "local" ? "http://localhost:1338" : `https://guest-${stage}.kitties.rccpr.tech`,
      BLOBS: blobs,
    },
  };
});
const ProbePayload = Probe.payloadSchema;

export default class Gateway extends Cloudflare.Worker<Gateway>()(
  "Gateway",
  props.pipe(
    Effect.tapCause((cause) =>
      Effect.logError("Gateway configuration failed", Cause.pretty(cause)),
    ),
  ),
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine;
    const homes = yield* HomeDO;
    const kitties = yield* KittyDO;
    const chats = yield* ChatDO;
    const probes = yield* Workflows.RunWorkflow(Probe);
    const advanced = yield* Workflows.RunWorkflow(AdvancedProbe);
    const timers = yield* Workflows.RunWorkflow(TimerProbe);
    const callbacks = yield* CallbackProbeDO;
    const application = yield* makeApplication;
    const oauth = yield* makeOAuth;
    const lifecycle = yield* makeLifecycle;
    const autonomy = yield* makeAutonomy;
    const receiveWebhook = yield* makeWebhooks;
    const notifications = yield* makeNotifications;
    yield* Cloudflare.Workers.cron("* * * * *", () =>
      lifecycle.pipe(Effect.andThen(autonomy.tick), Effect.andThen(notifications.tick)),
    );
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
      receiveWebhook,
      finishOAuth: (state: string, code: string, issuer?: string) =>
        oauth.callback(state, code, issuer),
      timerStart: (id: string) => timers.start({ id }).pipe(Effect.map((run) => run.executionId)),
      timerStatus: (id: string) => timers.get(id).status,
      verifyChatStream: (id: string) =>
        chatEvents((after) => chats.getByName(id, { locationHint: "weur" }).events(after), 0).pipe(
          Stream.filter(() => env.STAGE === "next" || env.STAGE === "e2e"),
        ),
      verifyApplication: (method: string, path: string, body: string | null) =>
        Effect.gen(function* () {
          if (env.STAGE !== "next" && env.STAGE !== "e2e") return { status: 404, body: "" };
          if (
            !/^\/v1\/(features|kitties|chats|providers|connections|approvals|runs|computer-runs|releases|vault|help|artifacts|skills|goals|hooks|approval-rules|notifications)(?:\/|$)/.test(
              path,
            )
          )
            return { status: 404, body: "" };
          const response = yield* application(
            new Request(env.PUBLIC_URL + path, {
              method,
              headers: { "Content-Type": "application/json" },
              ...(body ? { body } : {}),
            }),
          );
          if (!response) return { status: 404, body: "" };
          if (path.includes("/events")) return { status: 400, body: "" };
          const native = HttpServerResponse.toWeb(response);
          return { status: native.status, body: yield* Effect.promise(() => native.text()) };
        }),
      desktopConfigure: (id: string, config: Omit<GuestConfig, "epoch">) =>
        kitties.getByName(id, { locationHint: "weur" }).configure(config),
      desktopStatus: (id: string) => kitties.getByName(id, { locationHint: "weur" }).status(),
      desktopReceipt: (id: string, intentId: string) =>
        kitties.getByName(id, { locationHint: "weur" }).receipt(intentId),
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
        const handled = yield* application(request);
        if (handled) return handled;
        const desktopRoute = url.pathname.match(
          /^\/v1\/kitties\/([a-zA-Z0-9_-]{1,128})\/desktop(?:\/(control|frames))?$/,
        );
        if (desktopRoute && request.method === "GET") {
          const kitty = kitties.getByName(desktopRoute[1]!, { locationHint: "weur" });
          if (desktopRoute[2]) {
            if (request.headers.get("Origin") !== env.PUBLIC_URL)
              return json({ code: "ORIGIN_DENIED", params: {} }, 403);
            return yield* kitty.fetch(yield* HttpServerRequest.HttpServerRequest);
          }
          return json(yield* kitty.status());
        }
        if (
          (env.STAGE === "local" || env.STAGE === "e2e") &&
          url.pathname === "/v1/operator/desktop" &&
          request.method === "POST"
        ) {
          const body = (yield* Effect.tryPromise(() => request.json())) as Omit<
            GuestConfig,
            "epoch"
          >;
          return json(
            yield* kitties.getByName(body.kittyId, { locationHint: "weur" }).configure(body),
          );
        }

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
    Effect.tapCause((cause) =>
      Effect.logError("Gateway initialization failed", Cause.pretty(cause)),
    ),
    Effect.provide(Cloudflare.Workers.CronEventSourceLive),
    Effect.provide(
      Layer.mergeAll(
        ProbeLive,
        AdvancedProbeLive,
        TurnLive,
        DistillLive,
        GoalSlotLive,
        DelegationLive,
        TimerProbeLive,
        NotifyLive,
        ApprovalLive,
        ComputerOpLive,
        DesktopAttemptLive,
      ).pipe(
        Layer.provideMerge(ChatDOLive),
        Layer.provideMerge(Cloudflare.Workflows.DurableObjectEngine),
      ),
    ),
  ),
) {}

// Workerd restart acceptance revision 1.
