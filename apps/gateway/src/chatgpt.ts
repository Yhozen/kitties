import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { HomeDO } from "./actors.ts";
import { chatgptConfig } from "./chatgpt-config.ts";
import { readBody } from "./request.ts";
const json = (body: unknown, status = 200) =>
  HttpServerResponse.fromWeb(
    Response.json(body, { status, headers: { "Cache-Control": "no-store" } }),
  );
export const makeChatgpt = Effect.gen(function* () {
  const homes = yield* HomeDO;
  const env = (yield* Cloudflare.WorkerEnvironment) as { CHATGPT_ENABLED: string };
  return (request: Request) =>
    Effect.gen(function* () {
      const path = new URL(request.url).pathname;
      if (path === "/v1/features" && request.method === "GET")
        return json({ chatgpt: env.CHATGPT_ENABLED === "true" });
      const route = path.match(/^\/v1\/providers\/([a-zA-Z0-9_-]{1,128})\/signin(?:\/(finish))?$/);
      if (!route) return;
      if (env.CHATGPT_ENABLED !== "true")
        return json({ code: "FEATURE_DISABLED", params: {} }, 404);
      const id = route[1]!,
        home = homes.getByName("owner", { locationHint: "weur" }),
        key = `chatgpt-${id}`;
      const raw = yield* home.read("provider", id);
      if (!raw || (JSON.parse(raw) as { kind: string }).kind !== "chatgpt")
        return json({ code: "NOT_FOUND", params: {} }, 404);
      if (request.method === "GET") return json({ status: yield* home.oauthStatus(key) });
      if (request.method === "DELETE") {
        yield* home.oauthDisconnect(key);
        return HttpServerResponse.empty({ status: 204 });
      }
      if (request.method !== "POST") return json({ code: "NOT_FOUND", params: {} }, 404);
      if (route[2] === "finish") {
        const body = yield* readBody(
          request,
          Schema.Struct({ url: Schema.String.check(Schema.isMaxLength(16384)) }),
        );
        const callback = yield* Effect.try({
          try: () => new URL(body.url),
          catch: () => "OAUTH_INVALID_CALLBACK",
        });
        if (
          callback.origin + callback.pathname !== chatgptConfig.redirectUri ||
          callback.hash ||
          callback.searchParams.has("error")
        )
          return json({ code: "OAUTH_INVALID_CALLBACK", params: {} }, 400);
        const result = yield* home.oauthFinish(
          callback.searchParams.get("state") ?? "",
          callback.searchParams.get("code") ?? "",
          undefined,
          key,
        );
        return json({ ok: result === key });
      }
      const started = yield* home.oauthBegin(key, chatgptConfig);
      const url = new URL(started.url);
      url.searchParams.set("id_token_add_organizations", "true");
      url.searchParams.set("codex_cli_simplified_flow", "true");
      url.searchParams.set("originator", "codex_cli_rs");
      return json({ ...started, url: url.href });
    });
});
