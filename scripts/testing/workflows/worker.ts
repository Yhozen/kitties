import * as Cloudflare from "@alchemy.run/cloudflare";
import {
  makeCallback,
  type Callback,
  type CallbackError,
  type CallbackStatus,
} from "alchemy/Callback";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Activity, Workflow, WorkflowEngine, DurableDeferred, DurableClock } from "effect/workflow";

class ProbeFailure extends Schema.TaggedError<ProbeFailure, { readonly brand: unique symbol }>()(
  "ProbeFailure",
  {},
) {}

type LedgerRow = { n: number; body: string };

const callbackEvidence = (status: CallbackStatus | undefined) =>
  status === undefined
    ? null
    : {
        scheduledAt: status.scheduledAt,
        retryAt: status.retryAt ?? null,
        attempts: status.attempts,
        parked: status.parked,
        progress: status.progress ?? null,
      };

const Continue = DurableDeferred.make("continue", { success: Schema.String });

const Probe = Workflow.make("OwnedProbe", {
  payload: { id: Schema.String, mode: Schema.Literals(["failure", "restart", "progress"]) },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
}).annotate(Workflow.SuspendOnFailure, true);

export default class OwnedWorkflowProbe extends Cloudflare.Worker<OwnedWorkflowProbe>()(
  "OwnedWorkflowProbe",
  { main: import.meta.url },
  Effect.gen(function* () {
    class Ledger extends Cloudflare.DurableObject<Ledger>()(
      "ProbeLedger",
      Effect.gen(function* () {
        const state = yield* Cloudflare.DurableObjectState;

        return Effect.gen(function* () {
          const sql = state.raw.storage.sql;
          sql.exec(
            "CREATE TABLE IF NOT EXISTS events (key TEXT PRIMARY KEY, n INTEGER NOT NULL, body TEXT NOT NULL)",
          );

          const waiters = new Map<
            string,
            Set<{ n: number; complete: (value: LedgerRow) => void }>
          >();

          const read = (key: string) =>
            sql
              .exec<{ n: number; body: string }>("SELECT n, body FROM events WHERE key = ?", key)
              .toArray()[0];

          const note = (key: string, body: Schema.Json = null) =>
            Effect.sync(() => {
              const [row] = sql
                .exec<{ n: number; body: string }>(
                  "INSERT INTO events VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET n = n + 1, body = excluded.body RETURNING n, body",
                  key,
                  JSON.stringify(body),
                )
                .toArray();

              for (const waiter of waiters.get(key) ?? [])
                if (row.n >= waiter.n) waiter.complete(row);

              return row.n;
            });

          const wait = (key: string, n: number) =>
            Effect.callback<LedgerRow>((resume) => {
              const current = read(key);

              if (current && current.n >= n) {
                resume(Effect.succeed(current));

                return;
              }

              const group = waiters.get(key) ?? new Set();
              waiters.set(key, group);
              const waiter = { n, complete: (value: LedgerRow) => resume(Effect.succeed(value)) };
              group.add(waiter);

              return Effect.sync(() => {
                group.delete(waiter);

                if (group.size === 0) waiters.delete(key);
              });
            }).pipe(Effect.timeout("12 seconds"), Effect.orDie);

          const callback: Callback<{ mode: string; step: number }> = yield* makeCallback(
            "owned-retry",
            (payload: {
              mode: string;
              step: number;
            }): Effect.Effect<void, CallbackError, RuntimeContext> =>
              Effect.gen(function* () {
                const call = yield* note("callback-call-" + payload.mode);

                if (payload.mode === "progress") {
                  if (payload.step < 10)
                    yield* callback.schedule("job", {
                      after: 0,
                      payload: { ...payload, step: payload.step + 1 },
                      progress: payload.step + 1,
                    });
                  yield* note(
                    "callback-progress-" + payload.step,
                    callbackEvidence(yield* callback.getStatus("job")),
                  );
                  yield* note("callback-progress-status");
                } else if (payload.mode === "stuck") {
                  yield* callback.schedule("job", { after: 0, payload });
                  const status = yield* callback.getStatus("job");

                  if (status?.parked) yield* note("callback-parked", callbackEvidence(status));
                } else {
                  yield* note("callback-resumed", {
                    call,
                    status: callbackEvidence(yield* callback.getStatus("job")),
                  });
                }
              }),
            { retry: { delay: "1 second", maxAttempts: 2, parkedDelay: "1 hour" } },
          );

          return {
            note,
            wait,
            read: (key: string) => Effect.sync(() => read(key) ?? null),
            schedule: (mode: string) =>
              callback.schedule("job", { after: 0, payload: { mode, step: 0 } }),
            callbackStatus: () => callback.getStatus("job"),
          };
        });
      }),
    ) {}

    const ledgerNamespace = yield* Ledger;
    // A stub belongs to the current native I/O context; create it inside each invocation.
    const ledger = () => ledgerNamespace.getByName("owned");

    const activity = (name: string, value: string) =>
      Activity.make({
        name,
        success: Schema.String,
        execute: ledger().note(name).pipe(Effect.as(value), Effect.orDie),
      });

    const implementation = Workflows.layer(
      Probe,
      Effect.fn(function* ({ id, mode }) {
        if (mode === "failure") {
          return yield* Activity.make({
            name: id + "-typed-failure",
            success: Schema.String,
            error: ProbeFailure,
            execute: ledger()
              .note(id + "-failed")
              .pipe(Effect.orDie, Effect.andThen(Effect.fail(new ProbeFailure({})))),
          }).pipe(
            Effect.catchTag("ProbeFailure", () =>
              activity(id + "-handled", "typed-handler-reached"),
            ),
          );
        }

        if (mode === "progress") {
          for (let step = 0; step < 10; step++) {
            yield* activity(id + "-step-" + step, "step");
            // This is the durable-timer behavior under test, never a harness delay.
            yield* DurableClock.sleep({
              name: "clock-" + step,
              duration: "1 millis",
              inMemoryThreshold: 0,
            });
          }

          return "ten-durable-clocks-completed";
        }

        yield* activity(id + "-before", "x".repeat(70000));
        yield* activity(id + "-ready", "ready");
        const value = yield* DurableDeferred.await(Continue);
        yield* activity(id + "-after", value);

        return "resumed:" + value;
      }),
    );

    return yield* Effect.gen(function* () {
      const client = yield* Workflows.RunWorkflow(Probe);
      const engine = yield* WorkflowEngine.WorkflowEngine;

      if (!Predicate.hasProperty(engine, "adminCall") || !Predicate.isFunction(engine.adminCall))
        throw Error("PATCH_NOT_INSTALLED");

      // SAFETY: the pinned Cloudflare engine patch attaches adminCall with this exact signature; the function exists above and its wire result is decoded below.
      const administration = engine as WorkflowEngine.WorkflowEngine["Service"] & {
        adminCall: (
          name: string,
          id: string,
          method: string,
          args: readonly Schema.Json[],
        ) => Effect.Effect<unknown>;
      };

      const Input = Schema.Struct({
        action: Schema.String,
        id: Schema.optional(Schema.String),
        mode: Schema.optional(
          Schema.Literals(["failure", "restart", "progress", "stuck", "resumed"]),
        ),
        key: Schema.optional(Schema.String),
        n: Schema.optional(Schema.Number),
        args: Schema.optional(Schema.Array(Schema.Json)),
      });

      return {
        fetch: Effect.gen(function* () {
          const request = yield* Cloudflare.Request;

          if (request.method === "GET")
            return yield* HttpServerResponse.json({ fixture: "owned-workflow-probe" });

          const input = yield* Effect.tryPromise(() => request.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Input)),
            Effect.orDie,
          );

          const id = input.id ?? "";
          let value: Schema.Json | undefined;

          switch (input.action) {
            case "start": {
              if (input.mode !== "failure" && input.mode !== "restart" && input.mode !== "progress")
                throw Error("Invalid workflow mode");
              value = (yield* client.start({ id, mode: input.mode })).executionId;
              break;
            }

            case "result":
              value = yield* client.get(id).result.pipe(Effect.timeout("8 seconds"), Effect.orDie);
              break;
            case "signal":
              yield* client.get(id).signal(Continue, "operator-value");
              value = true;
              break;
            case "resume":
              yield* engine.resume(Probe, id);
              value = true;
              break;
            case "ledger":
              value = yield* ledger().read(input.key ?? "");
              break;
            case "wait":
              value = yield* ledger().wait(input.key ?? "", input.n ?? 1);
              break;
            case "callback-start":
              yield* ledger()
                .schedule(input.mode ?? "progress")
                .pipe(Effect.orDie);
              value = true;
              break;
            case "callback-status":
              value = callbackEvidence(yield* ledger().callbackStatus().pipe(Effect.orDie));
              break;
            case "admin": {
              const method = input.key ?? "";

              if (!["adminSummary", "adminCapture", "adminReadPart", "adminPurge"].includes(method))
                throw Error("Unsupported owned test operation");
              value = yield* administration
                .adminCall(Probe._tag, id, method, input.args ?? [])
                .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)), Effect.orDie);
              break;
            }

            default:
              throw Error("Unknown owned test action");
          }

          return yield* HttpServerResponse.json(value ?? null);
        }),
      };
    }).pipe(
      Effect.provide(
        implementation.pipe(Layer.provideMerge(Cloudflare.Workflows.layerDurableObjectEngine())),
      ),
    );
  }),
) {}
