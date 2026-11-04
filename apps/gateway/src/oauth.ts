import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { HomeDO } from "./actors.ts";
import { discoverOAuth, jsonResponse, type OAuthConfig } from "./oauth-core.ts";
import { allowedFetch, publicHttps } from "./outbound.ts";
import { OAuthStartInput, type Connection } from "./entities.ts";
import { readBody } from "./request.ts";

export const oauthOrigin = (stage: string) => `https://auth-${stage}.kitties.rccpr.tech`;

export const nativeOAuth = {
  google: {
    issuer: "https://accounts.google.com",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    scope:
      "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/calendar.events",
  },
  m365: {
    issuer: "https://login.microsoftonline.com/common/v2.0",
    authorizationEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "offline_access User.Read Files.Read Calendars.ReadWrite",
  },
};

const json = (body: unknown, status = 200) =>
  HttpServerResponse.fromWeb(
    Response.json(body, { status, headers: { "Cache-Control": "no-store" } }),
  );

export const makeOAuth = Effect.gen(function* () {
  const homes = yield* HomeDO;
  const env = (yield* Cloudflare.WorkerEnvironment) as { STAGE: string };
  const home = () => homes.getByName("owner", { locationHint: "weur" });

  const origin = oauthOrigin(env.STAGE),
    redirectUri = `${origin}/oauth/callback`;

  return {
    callback: (state: string, code: string, issuer?: string) =>
      home().oauthFinish(state, code, issuer),
    route: (request: Request) =>
      Effect.gen(function* () {
        const path = new URL(request.url).pathname;

        const match = path.match(
          /^\/v1\/connections\/([a-zA-Z0-9_-]{1,128})\/oauth(?:\/(discover|start))?$/,
        );

        if (!match) return;

        const id = match[1]!,
          saved = yield* home().read("connection", id);

        if (!saved) return json({ code: "NOT_FOUND", params: {} }, 404);
        const connection = JSON.parse(saved) as Connection;

        if (!match[2] && request.method === "GET")
          return json({ status: yield* home().oauthStatus(id) });

        if (!match[2] && request.method === "DELETE") {
          yield* home().oauthDisconnect(id);

          return HttpServerResponse.empty({ status: 204 });
        }

        if (request.method !== "POST") return json({ code: "NOT_FOUND", params: {} }, 404);

        const native =
          connection.kind === "google" || connection.kind === "m365"
            ? nativeOAuth[connection.kind]
            : undefined;

        if (match[2] === "discover") {
          const metadata =
            native ??
            (yield* Effect.tryPromise({
              try: () => discoverOAuth(connection.url),
              catch: () => "OAUTH_DISCOVERY_REQUIRED",
            }));

          return json({ ...metadata, redirectUri });
        }

        if (match[2] !== "start") return json({ code: "NOT_FOUND", params: {} }, 404);
        const body = yield* readBody(request, OAuthStartInput);

        const metadata =
          native ??
          (yield* Effect.tryPromise({
            try: () => discoverOAuth(connection.url),
            catch: () => "OAUTH_DISCOVERY_REQUIRED",
          }));

        let clientId = body.clientId,
          clientSecret = body.clientSecret;

        if (!clientId && "cimd" in metadata && metadata.cimd)
          clientId = `${origin}/.well-known/oauth-client/kitties.json`;

        if (!clientId && "registrationEndpoint" in metadata && metadata.registrationEndpoint) {
          const endpoint = publicHttps(metadata.registrationEndpoint);

          const registration = yield* Effect.tryPromise({
            try: async () =>
              jsonResponse(
                await allowedFetch(endpoint.href, [endpoint.hostname], {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  signal: AbortSignal.timeout(15000),
                  body: JSON.stringify({
                    client_name: "Kitties",
                    redirect_uris: [redirectUri],
                    grant_types: ["authorization_code", "refresh_token"],
                    response_types: ["code"],
                    token_endpoint_auth_method: "none",
                  }),
                }),
              ),
            catch: () => "OAUTH_REGISTRATION_FAILED",
          });

          if (typeof registration.client_id !== "string")
            return json({ code: "OAUTH_REGISTRATION_FAILED", params: {} }, 400);
          clientId = registration.client_id;

          if (typeof registration.client_secret === "string")
            clientSecret = registration.client_secret;
        }

        if (!clientId) return json({ code: "OAUTH_CLIENT_REQUIRED", params: {} }, 400);

        const config: OAuthConfig = {
          issuer: metadata.issuer,
          authorizationEndpoint: metadata.authorizationEndpoint,
          tokenEndpoint: metadata.tokenEndpoint,
          clientId,
          clientSecret,
          authMethod:
            clientSecret &&
            "authMethods" in metadata &&
            metadata.authMethods.includes("client_secret_basic")
              ? "client_secret_basic"
              : clientSecret
                ? "client_secret_post"
                : "none",
          scope: body.scope ?? ("scope" in metadata ? metadata.scope : metadata.scopes.join(" ")),
          redirectUri,
          protectedUrl: connection.url,
          ...(connection.kind === "mcp" ? { resource: connection.url } : {}),
        };

        const result = yield* home().oauthBegin(id, config);

        // Google needs explicit offline consent to return a refresh token on reauthorization.
        if (connection.kind === "google") {
          const url = new URL(result.url);
          url.searchParams.set("access_type", "offline");
          url.searchParams.set("prompt", "consent");

          return json({ ...result, url: url.href });
        }

        return json(result);
      }),
  };
});
