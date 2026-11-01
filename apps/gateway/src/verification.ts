import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import Gateway from "./worker.ts";

// beta.84's bindWorker resolves an inline Worker's implementation while building a
// consumer at runtime. That tries to find the target's DO bindings in this Worker.
// Register the service dependency during planning, then use the native binding.
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
      return { tick: () => safeTick, alarm: () => safeTick };
    });
  }),
) {}

export default class Verification extends Cloudflare.Worker<Verification>()(
  "Verification",
  Effect.gen(function* () {
    const token = yield* Config.Redacted("KITTIES_VERIFY_TOKEN");
    return {
      main: import.meta.url,
      domain: "checks.kitties.rccpr.tech",
      env: { KITTIES_VERIFY_TOKEN: token },
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
    const env = (yield* Cloudflare.WorkerEnvironment) as { KITTIES_VERIFY_TOKEN: string };
    yield* Cloudflare.Workers.cron("* * * * *", () =>
      verifiers.getByName("engine-v1", { locationHint: "weur" }).tick(),
    );
    return {
      fetch: Effect.gen(function* () {
        const request = yield* Cloudflare.Request;
        if (request.headers.get("Authorization") !== `Bearer ${env.KITTIES_VERIFY_TOKEN}`)
          return HttpServerResponse.empty({ status: 404 });
        if (request.method === "POST" && new URL(request.url).pathname === "/run")
          yield* verifiers.getByName("engine-v1", { locationHint: "weur" }).tick();
        const report = yield* gateway.probeReport();
        return HttpServerResponse.fromWeb(
          Response.json(report ? JSON.parse(report) : { status: "pending" }),
        );
      }).pipe(Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty({ status: 503 })))),
    };
  }).pipe(
    Effect.provide(Cloudflare.Workers.CronEventSourceLive),
    Effect.tapCause((cause) => Effect.logError("Verification init failed", Cause.pretty(cause))),
  ),
) {}
