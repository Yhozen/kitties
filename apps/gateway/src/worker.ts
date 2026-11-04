import type { ChatgptCallback } from "./chatgpt-core.ts";
import { verifiedAccessIdentity } from "./access-jwt.ts";
import { makeRecovery } from "./recovery.ts";
import { PurgeLive } from "./workflows/purge.ts";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Stage } from "alchemy/Stage";
import * as Config from "effect/Config";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ExportLive } from "./workflows/export.ts";
import { RestoreLive } from "./workflows/restore.ts";
import { RetainedExports, GuestAssets } from "./resources.ts";
import { Health, Session } from "@kitties/domain";
import { HomeDO, KittyDO } from "./actors.ts";
import { ChatDOLive } from "./chat.ts";
import { DesktopAttemptLive } from "./workflows/desktop.ts";
import { ComputerOpLive } from "./workflows/computer.ts";
import { TurnLive } from "./workflows/turn.ts";
import { DistillLive } from "./workflows/distill.ts";
import { DelegationLive } from "./workflows/delegation.ts";
import { GoalSlotLive } from "./workflows/goal.ts";
import { makeAutonomy } from "./autonomy.ts";
import { makeWebhooks } from "./webhooks.ts";
import { NotifyLive } from "./workflows/notify.ts";
import { makeNotifications } from "./notifications.ts";
import { ApprovalLive } from "./workflows/approval.ts";
import { makeLifecycle } from "./lifecycle.ts";
import { makeOAuth } from "./oauth.ts";
import { makeApplication } from "./application.ts";
import { ownerError } from "./security.ts";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

const props = Effect.gen(function* () {
  const stage = yield* Stage;
  const domain = yield* Config.String("KITTIES_NEXT_DOMAIN").pipe(
    Config.withDefault(
      stage === "prod"
        ? "kitties.rccpr.tech"
        : `${stage === "next" ? "next" : "dev"}.kitties.rccpr.tech`,
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
      ACCESS_ISSUER: yield* Config.String("KITTIES_ACCESS_ISSUER").pipe(
        Config.withDefault("https://misty-sky-3199.cloudflareaccess.com"),
      ),
      ACCESS_AUDIENCE: yield* Config.String("KITTIES_ACCESS_AUDIENCE").pipe(
        Config.withDefault(
          stage === "next"
            ? "6d0289542bd5627c4611d3191d290eb709f6dc21567ce86beede78b8d5e8ff10"
            : stage === "prod"
              ? "6c23180dee19ed077a61fdc54b8021bb5437c8cee924b3d72513f745c2fdb679"
              : "",
        ),
      ),
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
      EXPORTS: yield* RetainedExports,
    },
  };
});

export default class Gateway extends Cloudflare.Worker<Gateway>()(
  "Gateway",
  props.pipe(
    Effect.tapCause((cause) =>
      Effect.logError("Gateway configuration failed", Cause.pretty(cause)),
    ),
  ),
  Effect.gen(function* () {
    const homes = yield* HomeDO;
    const kitties = yield* KittyDO;
    const application = yield* makeApplication;
    const oauth = yield* makeOAuth;
    const lifecycle = yield* makeLifecycle;

    const autonomy = yield* makeAutonomy;
    const receiveWebhook = yield* makeWebhooks;
    const notifications = yield* makeNotifications;
    const recovery = yield* makeRecovery;
    yield* Cloudflare.Workers.cron("* * * * *", () =>
      lifecycle.pipe(
        Effect.andThen(autonomy.tick),
        Effect.andThen(notifications.tick),
        Effect.andThen(recovery.tick()),
      ),
    );
    const env = (yield* Cloudflare.WorkerEnvironment) as {
      PUBLIC_URL: string;
      ACCESS_EMAIL: string;
      ACCESS_ISSUER: string;
      ACCESS_AUDIENCE: string;
      STAGE: string;
      KITTIES_KEK: string;
      ASSETS: { fetch(request: Request): Promise<Response> };
    };
    const json = (body: unknown, status = 200) =>
      HttpServerResponse.fromWeb(
        Response.json(body, { status, headers: { "Cache-Control": "no-store" } }),
      );
    return {
      receiveWebhook,
      finishChatgpt: (callback: ChatgptCallback) =>
        homes.getByName("owner", { locationHint: "weur" }).chatgptFinish(callback),
      finishOAuth: (state: string, code: string, issuer?: string) =>
        oauth.callback(state, code, issuer),
      fetch: Effect.gen(function* () {
        const request = yield* Cloudflare.Request;
        const access = yield* Cloudflare.Access.Context;
        const nativeIdentity = access
          ? yield* access.getIdentity().pipe(Effect.catch(() => Effect.succeed(undefined)))
          : undefined;
        const identity =
          nativeIdentity ??
          (yield* Effect.promise(() =>
            verifiedAccessIdentity(request, env.ACCESS_ISSUER, env.ACCESS_AUDIENCE),
          ));
        const error = ownerError(request, env.PUBLIC_URL, env.ACCESS_EMAIL, identity);
        if (error) return json(error.body, error.status);
        const url = new URL(request.url);
        const handled = yield* application(request);
        if (handled) return handled;
        const desktopRoute = url.pathname.match(
          /^\/v1\/kitties\/([a-zA-Z0-9_-]{1,128})\/desktop(?:\/(control|frames|video))?$/,
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
        if (request.method === "GET" && url.pathname === "/v1/health")
          return json(
            Schema.decodeUnknownSync(Health)({
              ok: true,
              version: "effect-2026.11.01",
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
        ExportLive,
        PurgeLive,
        RestoreLive,
        TurnLive,
        DistillLive,
        GoalSlotLive,
        DelegationLive,
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
