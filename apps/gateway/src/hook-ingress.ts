import * as Cloudflare from "@alchemy.run/cloudflare";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import Gateway from "./worker.ts";
const binding = Effect.gen(function* () {
  if (!globalThis.__ALCHEMY_RUNTIME__) return yield* Cloudflare.Workers.bindWorker(Gateway);
  const env = yield* Cloudflare.WorkerEnvironment;
  return Cloudflare.Workers.makeRpcStub<Gateway>((env as Record<string, unknown>).Gateway);
});
export default class HookIngress extends Cloudflare.Worker<HookIngress>()(
  "HookIngress",
  Effect.gen(function* () {
    const stage = yield* Stage;
    return {
      main: import.meta.url,
      dev: { port: 1339, strictPort: true },
      domain: stage === "local" ? undefined : `hooks-${stage}.kitties.rccpr.tech`,
      workersDev: false,
      observability: {
        enabled: true,
        logs: { enabled: true, invocationLogs: true },
        redactQueryString: true,
      },
    };
  }),
  Effect.gen(function* () {
    const gateway = yield* binding;
    const throttle = yield* Cloudflare.RateLimit("HOOK_LIMIT", {
      namespaceId: 74981,
      simple: { limit: 600, period: 60 },
    });
    return {
      fetch: Effect.gen(function* () {
        const request = yield* Cloudflare.Request,
          url = new URL(request.url),
          match = url.pathname.match(/^\/hooks\/([a-zA-Z0-9_-]{1,64})$/);
        if (request.method !== "POST" || !match || url.search)
          return HttpServerResponse.empty({ status: 404 });
        if (
          !(yield* throttle.limit({ key: request.headers.get("CF-Connecting-IP") ?? "unknown" }))
            .success
        )
          return HttpServerResponse.empty({ status: 429 });
        const body = yield* Effect.tryPromise({
          try: async () => {
            if (Number(request.headers.get("Content-Length")) > 1048576) throw Error();
            const reader = request.body?.getReader();
            if (!reader) throw Error();
            let size = 0;
            const chunks: Uint8Array[] = [];
            try {
              for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                size += value.length;
                if (size > 1048576) throw Error();
                chunks.push(value);
              }
            } finally {
              await reader.cancel();
            }
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.length;
            }
            return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          },
          catch: () => "BODY_LIMIT",
        });
        const names = [
          "x-github-delivery",
          "x-hub-signature-256",
          "stripe-signature",
          "x-kitties-timestamp",
          "x-kitties-signature",
          "x-kitties-delivery",
        ];
        const headers = Object.fromEntries(
          names.map((name) => [name, request.headers.get(name) ?? ""]),
        );
        const result = yield* gateway.receiveWebhook(match[1]!, headers, body);
        return HttpServerResponse.empty({ status: result.status });
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 413 })))),
    };
  }).pipe(Effect.provide(Cloudflare.Workers.RateLimitBinding)),
) {}
