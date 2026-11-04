import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { HomeDO } from "./actors.ts";
import { Notify } from "./notification-definition.ts";
import { readBody } from "./request.ts";
import { seal, type Envelope } from "./secrets.ts";
import { sha256 } from "./kitty.ts";
import { publicHttps } from "./outbound.ts";

const json = (data: unknown, status = 200) =>
  HttpServerResponse.fromWeb(
    Response.json(data, { status, headers: { "Cache-Control": "no-store" } }),
  );

export const NotificationSettings = Schema.Struct({
  enabled: Schema.Boolean,
  events: Schema.Array(Schema.Literals(["approval", "completed", "help", "health"])),
});

const subscriptionSchema = Schema.Struct({
  endpoint: Schema.String.check(Schema.isMaxLength(2048)),
  expirationTime: Schema.NullOr(Schema.Number),
  keys: Schema.Struct({
    p256dh: Schema.String.check(Schema.isMaxLength(200)),
    auth: Schema.String.check(Schema.isMaxLength(100)),
  }),
});

export const makeNotifications = Effect.gen(function* () {
  const homes = yield* HomeDO,
    workflows = yield* Workflows.RunWorkflow(Notify);

  const env = (yield* Cloudflare.WorkerEnvironment) as { KITTIES_KEK: string };

  const tick = Effect.gen(function* () {
    const home = homes.getByName("owner", { locationHint: "weur" });
    yield* Effect.forEach(
      yield* home.list("notification-batch"),
      (row) => {
        const batch = JSON.parse(row.body) as { status: string };

        return batch.status === "pending" ? workflows.start({ id: row.id }) : Effect.void;
      },
      { concurrency: 4 },
    );
  });

  const route = (request: Request) =>
    Effect.gen(function* () {
      const home = homes.getByName("owner", { locationHint: "weur" }),
        path = new URL(request.url).pathname,
        method = request.method;

      if (path === "/v1/notifications" && method === "GET") {
        const prefs = yield* home.read("settings", "notifications");

        return json({
          settings: prefs ? JSON.parse(prefs) : { enabled: false, events: [] },
          batches: (yield* home.list("notification-batch"))
            .slice(-30)
            .map((row) => ({ id: row.id, ...JSON.parse(row.body) })),
          subscriptions: (yield* home.list("push-subscription")).length,
        });
      }

      if (path === "/v1/notifications" && method === "PUT") {
        const body = yield* readBody(request, NotificationSettings);
        yield* home.write("settings", "notifications", JSON.stringify(body));

        return json({ ok: true });
      }

      if (path === "/v1/notifications/key" && method === "GET") {
        let saved = yield* home.read("settings", "vapid");

        if (!saved) {
          const keys = yield* Effect.promise(async () => {
            const pair = await crypto.subtle.generateKey(
              { name: "ECDSA", namedCurve: "P-256" },
              true,
              ["sign", "verify"],
            );

            const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
            const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);

            return {
              publicKey: btoa(String.fromCharCode(...pub))
                .replace(/=/g, "")
                .replace(/\+/g, "-")
                .replace(/\//g, "_"),
              privateKey: jwk.d!,
            };
          });

          const secret = yield* Effect.tryPromise({
            try: () => seal(env.KITTIES_KEK, "settings:vapid:private-key", keys.privateKey),
            catch: () => "KEY_UNAVAILABLE",
          });

          yield* home.insert(
            "settings",
            "vapid",
            JSON.stringify({ publicKey: keys.publicKey, secret }),
          );
          saved = yield* home.read("settings", "vapid");
        }

        return json({
          publicKey: (JSON.parse(saved!) as { publicKey: string; secret: Envelope }).publicKey,
        });
      }

      if (path === "/v1/notifications/subscriptions" && method === "POST") {
        const body = yield* readBody(request, subscriptionSchema);
        yield* Effect.try({
          try: () => {
            const host = publicHttps(body.endpoint).hostname;

            if (
              !(
                host === "fcm.googleapis.com" ||
                host === "updates.push.services.mozilla.com" ||
                host.endsWith(".notify.windows.com") ||
                host === "web.push.apple.com"
              )
            )
              throw Error();
          },
          catch: () => "PUSH_HOST_DENIED",
        });
        const id = yield* Effect.promise(() => sha256(body.endpoint));

        const secret = yield* Effect.tryPromise({
          try: () => seal(env.KITTIES_KEK, `push-subscription:${id}:payload`, JSON.stringify(body)),
          catch: () => "KEY_UNAVAILABLE",
        });

        yield* home.write("push-subscription", id, JSON.stringify(secret));

        return json({ id }, 201);
      }

      if (
        (path === "/v1/notifications/test" || path === "/v1/notifications/digest") &&
        method === "POST"
      ) {
        const prefs = yield* home.read("settings", "notifications");

        if (!prefs || !JSON.parse(prefs).enabled)
          return json({ code: "NOTIFICATIONS_DISABLED", params: {} }, 400);

        if (!(yield* home.list("push-subscription")).length)
          return json({ code: "PUSH_SUBSCRIPTION_REQUIRED", params: {} }, 400);

        const body = yield* readBody(
          request,
          Schema.Struct({
            operationId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/)),
          }),
        );

        const id = `owner-${body.operationId}`;
        const counts = yield* home.list("run-health");

        const title = path.endsWith("digest")
          ? `Puppies: ${counts.filter((row) => JSON.parse(row.body).status === "completed").length} tareas terminadas, ${counts.filter((row) => JSON.parse(row.body).status === "suspended").length} necesitan atención`
          : "Tus notificaciones de Puppies funcionan";

        yield* home.queueNotice(id, "health", title, "/", true);
        yield* tick;

        return json({ ok: true }, 202);
      }

      return undefined;
    });

  return { route, tick };
});
