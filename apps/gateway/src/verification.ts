import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as cf from "@cloudflare/workers-types";
import { KittyDO, type GuestConfig } from "./kitty.ts";
import { GuestAssets } from "./resources.ts";
import Gateway from "./worker.ts";
import { benchmarkChannel } from "./channel-benchmark.ts";
import { probeMcpEndpoints } from "./mcp.ts";

// beta.84's bindWorker resolves an inline Worker's implementation while building a
// consumer at runtime. That tries to find the target's DO bindings in this Worker.
// Register the service dependency during planning, then use the native binding.
const signArtifact = async (secret: string, value: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
};

const gatewayBinding = Effect.gen(function* () {
  if (!globalThis.__ALCHEMY_RUNTIME__) return yield* Cloudflare.Workers.bindWorker(Gateway);
  const env = yield* Cloudflare.WorkerEnvironment;
  return Cloudflare.Workers.makeRpcStub<Gateway>((env as Record<string, unknown>).Gateway);
});

const cases = [
  { name: "replay-3", steps: 3, wait: true, fail: false },
  { name: "replay-50", steps: 50, wait: true, fail: false },
  { name: "replay-200", steps: 200, wait: true, fail: false },
  { name: "replay-500", steps: 500, wait: true, fail: false },
  { name: "journaled-failure", steps: 3, wait: false, fail: true },
];
interface Checkpoint {
  index: number;
  id: string;
  executionId?: string;
  signaledAt?: number;
  results: { name: string; status: string; signalToResultMs?: number }[];
}

class VerificationDO extends Cloudflare.DurableObject<VerificationDO>()(
  "VerificationDO",
  Effect.gen(function* () {
    const gateway = yield* gatewayBinding;
    const state = yield* Cloudflare.DurableObjectState;
    const env = (yield* Cloudflare.WorkerEnvironment) as { DESKTOPS: cf.DurableObjectNamespace };
    return Effect.sync(() => {
      const tick = Effect.gen(function* () {
        const saved = yield* state.storage.get<Checkpoint>("checkpoint");
        const checkpoint = saved ?? { index: 0, id: `cloud-${Date.now()}`, results: [] };
        if (checkpoint.index >= cases.length) return;
        const spec = cases[checkpoint.index]!;
        const id = `${checkpoint.id}-${checkpoint.index}`;
        const payload = { id, steps: spec.steps, delayMs: 100, wait: spec.wait, fail: spec.fail };
        if (!checkpoint.executionId) checkpoint.executionId = yield* gateway.probeStart(payload);
        const status = yield* gateway.probeStatus(checkpoint.executionId);
        if (status._tag === "Completed" || status._tag === "Failed") {
          const calls = yield* gateway.probeCalls(id);
          const expected = spec.fail ? 1 : spec.steps;
          const duplicate = yield* gateway.probeStart(payload);
          const correct =
            duplicate === checkpoint.executionId &&
            calls.length === expected &&
            calls.every((call) => call.calls === 1) &&
            (spec.fail
              ? status._tag === "Failed" && status.error === "PROBE_FAILURE"
              : status._tag === "Completed" && status.result === spec.steps);
          if (!correct) {
            yield* gateway.probeSaveReport(
              JSON.stringify({
                date: new Date().toISOString(),
                status: "failed",
                case: spec.name,
                calls,
              }),
            );
            yield* Effect.logError("Cloud engine probe failed", spec.name);
            checkpoint.index = cases.length;
          } else {
            checkpoint.results.push({
              name: spec.name,
              status: "pass",
              ...(checkpoint.signaledAt
                ? { signalToResultMs: Date.now() - checkpoint.signaledAt }
                : {}),
            });
            checkpoint.index++;
            delete checkpoint.executionId;
            delete checkpoint.signaledAt;
            yield* Effect.log("Cloud engine probe passed", spec.name);
          }
        } else if (spec.wait && !checkpoint.signaledAt) {
          const calls = yield* gateway.probeCalls(id);
          if (calls.length === spec.steps) {
            yield* gateway.probeSignal(checkpoint.executionId);
            checkpoint.signaledAt = Date.now();
          }
        }
        yield* state.storage.put("checkpoint", checkpoint);
        if (checkpoint.index < cases.length) yield* state.storage.setAlarm(Date.now() + 1000);
        else if (checkpoint.results.length === cases.length) {
          const report = {
            date: new Date().toISOString(),
            status: "passed",
            runtime: "Cloudflare DurableObjectEngine",
            cases: checkpoint.results,
          };
          yield* gateway.probeSaveReport(JSON.stringify(report));
          yield* Effect.log("Cloud engine acceptance passed", report);
        }
      });
      const safeTick = tick.pipe(
        Effect.catchCause(() =>
          Effect.gen(function* () {
            yield* Effect.logError("Cloud engine verifier will retry");
            yield* state.storage.setAlarm(Date.now() + 5000);
          }),
        ),
      );
      return {
        channel: (id: string) => Effect.promise(() => benchmarkChannel(env.DESKTOPS, 200, id)),
        tick: () => safeTick,
        alarm: () => safeTick,
        snapshot: () => state.storage.get<Checkpoint>("checkpoint"),
      };
    });
  }),
) {}

export default class Verification extends Cloudflare.Worker<Verification>()(
  "Verification",
  Effect.gen(function* () {
    const token = yield* Config.Redacted("KITTIES_VERIFY_TOKEN");
    const target = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* Gateway;
    const assets = yield* GuestAssets;
    return {
      main: import.meta.url,
      domain: "checks.kitties.rccpr.tech",
      env: {
        KITTIES_VERIFY_TOKEN: token,
        GUEST_ASSETS: assets,
        ...(target
          ? {
              DESKTOPS: Cloudflare.DurableObject<KittyDO>("KittyDO", {
                scriptName: target.workerName,
              }),
            }
          : {}),
      },
      workersDev: false,
      observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
      limits: { cpuMs: 300000 },
    };
  }).pipe(
    Effect.tapCause((cause) => Effect.logError("Verification props failed", Cause.pretty(cause))),
  ),
  Effect.gen(function* () {
    const verifiers = yield* VerificationDO;
    const gateway = yield* gatewayBinding;
    const env = (yield* Cloudflare.WorkerEnvironment) as {
      KITTIES_VERIFY_TOKEN: string;
      DESKTOPS: cf.DurableObjectNamespace;
      GUEST_ASSETS: cf.R2Bucket;
    };
    yield* Cloudflare.Workers.cron("* * * * *", () =>
      verifiers.getByName("engine-progress-v2", { locationHint: "weur" }).tick(),
    );
    return {
      fetch: Effect.gen(function* () {
        const request = yield* Cloudflare.Request;
        const url = new URL(request.url);
        if (url.pathname === "/mcp-fixture" && request.method === "POST") {
          const body = yield* Effect.tryPromise(() => request.json()) as Effect.Effect<
            { id?: string | number; method: string },
            unknown
          >;
          if (body.id === undefined) return HttpServerResponse.empty({ status: 202 });
          const result =
            body.method === "initialize"
              ? {
                  protocolVersion: "2025-11-25",
                  capabilities: { tools: {} },
                  serverInfo: { name: "Kitties acceptance fixture", version: "1" },
                }
              : body.method === "tools/list"
                ? {
                    tools: [
                      {
                        name: "sample",
                        description: "Return sample data",
                        inputSchema: {
                          type: "object",
                          properties: {},
                          additionalProperties: false,
                        },
                        annotations: { readOnlyHint: true },
                      },
                    ],
                  }
                : body.method === "tools/call"
                  ? { content: [{ type: "text", text: "sample data" }] }
                  : {};
          return HttpServerResponse.fromWeb(Response.json({ jsonrpc: "2.0", id: body.id, result }));
        }
        if (
          url.pathname === "/model/v1/chat/completions" &&
          request.method === "POST" &&
          request.headers.get("Authorization") === "Bearer kitties-acceptance-fixture"
        ) {
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              for (const content of ["Hola", ", ", "prueba completada."])
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
                  ),
                );
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
                ),
              );
              controller.close();
            },
          });
          return HttpServerResponse.fromWeb(
            new Response(stream, {
              headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
            }),
          );
        }
        if (url.pathname === "/channel/control" || url.pathname === "/channel/frames") {
          const auth = request.headers
            .get("Authorization")
            ?.match(/^Benchmark (\d+)\.([a-f0-9]{64})$/);
          const expires = Number(auth?.[1]);
          if (!auth || expires < Date.now() || expires > Date.now() + 3600000)
            return HttpServerResponse.empty({ status: 404 });
          const signature = yield* Effect.promise(() =>
            signArtifact(env.KITTIES_VERIFY_TOKEN, `channel:spike-fresh:${expires}`),
          );
          if (auth[2] !== signature) return HttpServerResponse.empty({ status: 404 });
          const response = yield* Effect.promise(() =>
            env.DESKTOPS.getByName("spike-fresh", { locationHint: "weur" }).fetch(
              request as unknown as cf.Request,
            ),
          );
          return response.status === 101
            ? HttpServerResponse.setBody(
                HttpServerResponse.empty({ status: 101 }),
                HttpBody.raw(response),
              )
            : HttpServerResponse.fromWeb(response as unknown as Response);
        }
        if (url.pathname.startsWith("/artifact/")) {
          const key = url.pathname.slice(10);
          const expires = Number(url.searchParams.get("expires"));
          if (
            !/^[a-f0-9]{64}\.tgz$/.test(key) ||
            expires < Date.now() ||
            expires > Date.now() + 3600000
          )
            return HttpServerResponse.empty({ status: 404 });
          const expected = yield* Effect.promise(() =>
            signArtifact(env.KITTIES_VERIFY_TOKEN, `${key}:${expires}`),
          );
          if (url.searchParams.get("signature") !== expected)
            return HttpServerResponse.empty({ status: 404 });
          const object = yield* Effect.promise(() => env.GUEST_ASSETS.get(key));
          return object
            ? HttpServerResponse.fromWeb(new Response(object.body as unknown as ReadableStream))
            : HttpServerResponse.empty({ status: 404 });
        }
        if (request.headers.get("Authorization") !== `Bearer ${env.KITTIES_VERIFY_TOKEN}`)
          return HttpServerResponse.empty({ status: 404 });
        if (url.pathname === "/timer-probe" && request.method === "POST")
          return HttpServerResponse.fromWeb(
            Response.json({
              executionId: yield* gateway.timerStart(url.searchParams.get("id") ?? "default"),
            }),
          );
        if (url.pathname === "/timer-probe" && request.method === "GET")
          return HttpServerResponse.fromWeb(
            Response.json(yield* gateway.timerStatus(url.searchParams.get("executionId") ?? "")),
          );
        if (url.pathname === "/mcp-probe" && request.method === "POST")
          return HttpServerResponse.fromWeb(Response.json(yield* probeMcpEndpoints));
        const streamRoute = url.pathname.match(/^\/chat-stream\/([a-zA-Z0-9_-]{1,128})$/);
        if (streamRoute && request.method === "GET")
          return HttpServerResponse.stream(gateway.verifyChatStream(streamRoute[1]!), {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
          });
        if (url.pathname === "/application" && request.method === "POST") {
          const body = yield* Effect.tryPromise(() => request.json()) as Effect.Effect<
            { method: string; path: string; body: string | null },
            unknown
          >;
          return HttpServerResponse.fromWeb(
            Response.json(yield* gateway.verifyApplication(body.method, body.path, body.body)),
          );
        }
        if (url.pathname === "/channel-token") {
          const expires = Date.now() + 3600000;
          const signature = yield* Effect.promise(() =>
            signArtifact(env.KITTIES_VERIFY_TOKEN, `channel:spike-fresh:${expires}`),
          );
          return HttpServerResponse.fromWeb(Response.json({ token: `${expires}.${signature}` }));
        }
        if (url.pathname === "/desktop/config" && request.method === "POST") {
          const body = (yield* Effect.tryPromise(() => request.json())) as Omit<
            GuestConfig,
            "epoch"
          >;
          if (
            !/^spike(?:-[a-z0-9]+)?$/.test(body.kittyId) ||
            !/^[a-f0-9]{64}$/.test(body.tokenHash)
          )
            return HttpServerResponse.empty({ status: 400 });
          return HttpServerResponse.fromWeb(
            Response.json(yield* gateway.desktopConfigure(body.kittyId, body)),
          );
        }
        if (url.pathname === "/desktop/status")
          return HttpServerResponse.fromWeb(
            Response.json(yield* gateway.desktopStatus(url.searchParams.get("id") ?? "spike")),
          );
        if (url.pathname === "/desktop/benchmark" && request.method === "POST")
          return HttpServerResponse.fromWeb(
            Response.json(
              yield* verifiers
                .getByName("channel-v1", { locationHint: "weur" })
                .channel(url.searchParams.get("id") ?? "spike-fresh"),
            ),
          );
        if (url.pathname === "/desktop/control" || url.pathname === "/desktop/frames") {
          const response = yield* Effect.promise(() =>
            env.DESKTOPS.getByName(url.searchParams.get("id") ?? "spike-fresh", {
              locationHint: "weur",
            }).fetch(request as unknown as cf.Request),
          );
          return response.status === 101
            ? HttpServerResponse.setBody(
                HttpServerResponse.empty({ status: 101 }),
                HttpBody.raw(response),
              )
            : HttpServerResponse.fromWeb(response as unknown as Response);
        }
        if (url.pathname === "/asset-url") {
          const key = url.searchParams.get("key") ?? "";
          if (!/^[a-f0-9]{64}\.tgz$/.test(key)) return HttpServerResponse.empty({ status: 400 });
          const expires = Date.now() + 3600000;
          const signature = yield* Effect.promise(() =>
            signArtifact(env.KITTIES_VERIFY_TOKEN, `${key}:${expires}`),
          );
          return HttpServerResponse.fromWeb(
            Response.json({
              url: `${url.origin}/artifact/${key}?expires=${expires}&signature=${signature}`,
            }),
          );
        }
        if (request.method === "POST" && url.pathname === "/run")
          yield* verifiers.getByName("engine-progress-v2", { locationHint: "weur" }).tick();
        const report = yield* gateway.probeReport();
        return HttpServerResponse.fromWeb(
          Response.json(
            report
              ? JSON.parse(report)
              : {
                  status: "pending",
                  checkpoint: yield* verifiers
                    .getByName("engine-progress-v2", { locationHint: "weur" })
                    .snapshot(),
                },
          ),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Verification request failed", Cause.pretty(cause)).pipe(
            Effect.as(HttpServerResponse.empty({ status: 503 })),
          ),
        ),
      ),
    };
  }).pipe(
    Effect.provide(Cloudflare.Workers.CronEventSourceLive),
    Effect.tapCause((cause) => Effect.logError("Verification init failed", Cause.pretty(cause))),
  ),
) {}
