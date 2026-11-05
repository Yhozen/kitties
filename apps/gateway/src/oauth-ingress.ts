import * as Cloudflare from "@alchemy.run/cloudflare";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { readBody } from "./request.ts";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import Gateway from "./worker.ts";
import { oauthOrigin } from "./oauth.ts";

const binding = Effect.gen(function* () {
  if (!globalThis.__ALCHEMY_RUNTIME__) return yield* Cloudflare.Workers.bindWorker(Gateway);

  return Cloudflare.Workers.makeRpcStub<Gateway>((yield* Cloudflare.WorkerEnvironment).Gateway);
});

export default class OAuthIngress extends Cloudflare.Worker<OAuthIngress>()(
  "OAuthIngress",
  Effect.gen(function* () {
    const stage = yield* Stage;

    return {
      main: import.meta.url,
      dev: { port: 1340, strictPort: true },
      domain: stage === "local" ? undefined : new URL(oauthOrigin(stage)).hostname,
      workersDev: false,
      observability: {
        enabled: true,
        logs: { enabled: true, invocationLogs: false },
        redactQueryString: true,
      },
      env: { STAGE: stage },
    };
  }),
  Effect.gen(function* () {
    const gateway = yield* binding;

    // Plan-time construction has no bindings; decode them when a request runs.
    const bindings = yield* Cloudflare.WorkerEnvironment;

    return {
      fetch: Effect.gen(function* () {
        const { STAGE: stage } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ STAGE: Schema.String }),
        )(bindings).pipe(Effect.orDie);

        const origin = oauthOrigin(stage);

        const request = yield* Cloudflare.Request,
          url = new URL(request.url);

        if (
          request.method === "POST" &&
          url.pathname === "/oauth/chatgpt/callback" &&
          !url.search
        ) {
          const value = Schema.String.check(Schema.isMaxLength(8192));

          const result = yield* readBody(
            request,
            Schema.Struct({
              state: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{43}$/)),
              code: Schema.optional(value),
              clientId: Schema.optional(value),
              issuer: Schema.optional(value),
              error: Schema.optional(value),
            }),
          ).pipe(
            Effect.flatMap((callback) => gateway.finishChatgpt(callback)),
            Effect.map((attempt) => ({
              status: 200,
              body: { status: attempt.status, accountId: attempt.accountId },
            })),
            Effect.catch(() => Effect.succeed({ status: 400, body: { status: "failed" } })),
          );

          return HttpServerResponse.fromWeb(
            Response.json(result.body, {
              status: result.status,
              headers: {
                "Cache-Control": "no-store",
                "Referrer-Policy": "no-referrer",
                "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
                "X-Content-Type-Options": "nosniff",
              },
            }),
          );
        }

        if (request.method !== "GET") return HttpServerResponse.empty({ status: 404 });

        if (url.pathname === "/.well-known/oauth-client/kitties.json" && !url.search)
          return HttpServerResponse.fromWeb(
            Response.json(
              {
                client_id: `${origin}${url.pathname}`,
                client_name: "Kitties",
                redirect_uris: [`${origin}/oauth/callback`],
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                token_endpoint_auth_method: "none",
              },
              { headers: { "Cache-Control": "public, max-age=300" } },
            ),
          );

        if (url.pathname !== "/oauth/callback") return HttpServerResponse.empty({ status: 404 });

        const state = url.searchParams.get("state"),
          code = url.searchParams.get("code");

        const headers = {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
          "X-Content-Type-Options": "nosniff",
        };

        if (!state || !code || url.searchParams.has("error"))
          return HttpServerResponse.fromWeb(
            new Response("Authorization was not completed. Return to Kitties and try again.", {
              status: 400,
              headers,
            }),
          );

        const success = yield* gateway
          .finishOAuth(state, code, url.searchParams.get("iss") ?? undefined)
          .pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          );

        return HttpServerResponse.fromWeb(
          new Response(
            success
              ? "Connected. You can close this page and return to Kitties."
              : "This authorization expired or was already used. Start again in Kitties.",
            { status: success ? 200 : 400, headers },
          ),
        );
      }),
    };
  }),
) {}
