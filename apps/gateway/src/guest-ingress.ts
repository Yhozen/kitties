import type * as cf from "@cloudflare/workers-types";
import { releaseSignature } from "./releases.ts";
const native = globalThis as unknown as {
  Request: typeof cf.Request;
  Response: typeof cf.Response;
  Headers: typeof cf.Headers;
};
interface Env {
  KITTIES: cf.DurableObjectNamespace;
  PUBLIC_URL: string;
  RELEASE_KEY: string;
  RELEASES: cf.R2Bucket;
}
// This Worker has no owner, OAuth or operator routes. Its namespace is explicitly
// bound to Gateway's KittyDO, rather than declaring another set of objects.
export default {
  async fetch(request: cf.Request, env: Env): Promise<cf.Response> {
    const url = new URL(request.url);
    const release = url.pathname.match(/^\/releases\/([a-f0-9]{64}\.tgz)$/);
    if (release && request.method === "GET" && url.origin === env.PUBLIC_URL) {
      const expires = Number(url.searchParams.get("expires"));
      if (
        !Number.isFinite(expires) ||
        expires < Date.now() ||
        expires > Date.now() + 3600000 ||
        url.searchParams.get("signature") !==
          (await releaseSignature(env.RELEASE_KEY, release[1]!, expires))
      )
        return new native.Response(null, { status: 404 });
      const object = await env.RELEASES.get(release[1]!);
      return object
        ? new native.Response(object.body, {
            headers: { "Content-Type": "application/gzip", "Cache-Control": "private, no-store" },
          })
        : new native.Response(null, { status: 404 });
    }
    const match = url.pathname.match(
      /^\/guest\/([a-zA-Z0-9_-]{1,128})\/(control|frames|video|artifact\/[a-zA-Z0-9_-]{1,128})$/,
    );
    if (
      url.origin !== env.PUBLIC_URL ||
      !match ||
      !["GET", "PUT"].includes(request.method) ||
      (request.method === "GET" && request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    )
      return new native.Response(null, { status: 404 });
    const headers = new native.Headers(request.headers);
    headers.delete("X-Kitties-Owner");
    return env.KITTIES.getByName(match[1]!, { locationHint: "weur" }).fetch(
      new native.Request(request, { headers }),
    );
  },
};
