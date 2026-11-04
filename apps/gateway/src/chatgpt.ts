import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { ChatgptLinkInput, type ChatgptFailure } from "@kitties/domain/entities";
import { HomeDO } from "./actors.ts";
import { readBody } from "./request.ts";
import { safeChatgptError } from "./chatgpt-errors.ts";
const json = (body: unknown, status = 200) =>
  HttpServerResponse.fromWeb(
    Response.json(body, {
      status,
      headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    }),
  );
const failure = (error: unknown) => {
  const info =
    error && typeof error === "object" && "code" in error && "reason" in error
      ? (error as ChatgptFailure)
      : safeChatgptError(error);
  return json(
    { code: info.code, params: {}, error: info },
    info.code.endsWith("_NOT_FOUND") ? 404 : info.reason === "provider_unavailable" ? 503 : 400,
  );
};
export const makeChatgpt = Effect.gen(function* () {
  const homes = yield* HomeDO;
  const env = (yield* Cloudflare.WorkerEnvironment) as { CHATGPT_ENABLED: string };
  const home = () => homes.getByName("owner", { locationHint: "weur" });
  return (request: Request) =>
    Effect.gen(function* () {
      const path = new URL(request.url).pathname,
        method = request.method;
      if (path === "/v1/features" && method === "GET")
        return json({ chatgpt: env.CHATGPT_ENABLED === "true" });
      // Linking and admission are available while inference remains disabled.
      if (path === "/v1/chatgpt/accounts" && method === "GET")
        return yield* home()
          .chatgptAccounts()
          .pipe(
            Effect.map((value) => json(value)),
            Effect.catch((error) => Effect.succeed(failure(error))),
          );
      if (path === "/v1/chatgpt/link-attempts" && method === "POST") {
        const body = yield* readBody(request, ChatgptLinkInput);
        return yield* home()
          .chatgptBegin(body)
          .pipe(
            Effect.map((value) => json(value, 201)),
            Effect.catch((error) => Effect.succeed(failure(error))),
          );
      }
      const account = path.match(
        /^\/v1\/chatgpt\/accounts\/([a-zA-Z0-9_-]{1,128})(?:\/(models|probe))?$/,
      );
      if (account) {
        const id = account[1]!;
        if (!account[2] && method === "GET")
          return yield* home()
            .chatgptAccount(id)
            .pipe(
              Effect.map((value) => json(value)),
              Effect.catch((error) => Effect.succeed(failure(error))),
            );
        if (!account[2] && method === "DELETE")
          return yield* home()
            .chatgptDisconnect(id)
            .pipe(
              Effect.map((value) => json(value)),
              Effect.catch((error) => Effect.succeed(failure(error))),
            );
        if (account[2] === "models" && method === "GET")
          return yield* home()
            .chatgptModels(id)
            .pipe(
              Effect.map((value) => json(value)),
              Effect.catch((error) => Effect.succeed(failure(error))),
            );
        if (account[2] === "probe" && method === "POST")
          return yield* home()
            .chatgptProbe(id)
            .pipe(
              Effect.map((value) => json(value)),
              Effect.catch((error) => Effect.succeed(failure(error))),
            );
      }
      const attempt = path.match(
        /^\/v1\/chatgpt\/link-attempts\/([a-zA-Z0-9_-]{1,128})(?:\/(authorize))?$/,
      );
      if (attempt) {
        const id = attempt[1]!;
        if (attempt[2] === "authorize" && method === "GET")
          return yield* home()
            .chatgptAuthorize(id)
            .pipe(
              Effect.map((url) =>
                HttpServerResponse.fromWeb(
                  new Response(null, {
                    status: 303,
                    headers: {
                      Location: url,
                      "Cache-Control": "no-store",
                      "Referrer-Policy": "no-referrer",
                    },
                  }),
                ),
              ),
              Effect.catch((error) => Effect.succeed(failure(error))),
            );
        if (!attempt[2] && method === "GET")
          return yield* home()
            .chatgptAttempt(id)
            .pipe(
              Effect.map((value) => json(value)),
              Effect.catch((error) => Effect.succeed(failure(error))),
            );
        if (!attempt[2] && method === "DELETE")
          return yield* home()
            .chatgptCancel(id)
            .pipe(
              Effect.map((value) => json(value)),
              Effect.catch((error) => Effect.succeed(failure(error))),
            );
      }
      if (path.startsWith("/v1/chatgpt/")) return json({ code: "NOT_FOUND", params: {} }, 404);
    });
});
