import * as Effect from "effect/Effect";

interface Env {
  PUBLIC_URL: string;
  ACCESS_EMAIL: string;
  ASSETS: { fetch(request: Request): Promise<Response> };
}
interface Context {
  access?: { getIdentity(): Promise<{ email?: string } | undefined> };
}

export default {
  fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const url = new URL(request.url);
        if (url.origin !== env.PUBLIC_URL) return new Response("Not found", { status: 404 });
        if (!ctx.access) return new Response("Cloudflare Access required", { status: 403 });
        const identity = yield* Effect.promise(() => ctx.access!.getIdentity());
        if (identity?.email?.toLowerCase() !== env.ACCESS_EMAIL.toLowerCase()) {
          return new Response("Access denied", { status: 403 });
        }
        if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
        if (url.pathname === "/v1/health")
          return Response.json({ ok: true, version: "effect-foundation" });
        if (url.pathname === "/v1/session")
          return Response.json({ signed_in: true, email: identity.email });
        if (url.pathname.startsWith("/v1/")) return new Response("Not found", { status: 404 });
        return yield* Effect.promise(() => env.ASSETS.fetch(request));
      }),
    );
  },
};
