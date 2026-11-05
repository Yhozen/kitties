// Application-owned local fixture. No production entrypoint imports this module.
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import { Platform } from "@alchemy.run/domain/Platform";
import { LibraryModel } from "../../../packages/domain/src/Library.model.ts";
import { Library } from "../../../packages/domain/src/Library/Library.aggregate.ts";
import { LibraryId } from "../../../packages/domain/src/Library/Library.id.ts";
import { FinalizeLibraryImport } from "../../../packages/domain/src/Library/FinalizeLibraryImport.command.ts";
import { LibraryActor } from "../../../packages/domain/src/LibraryActor.context.ts";
import {
  LibraryControl,
  LibraryControlAdapters,
} from "../../../apps/gateway/src/library-control.ts";
import { libraryRecoveryHooksLayer } from "../../../apps/gateway/src/library-recovery-host.ts";
import { LibraryHttp, libraryHttpLayer } from "../../../apps/gateway/src/library-http.ts";
import {
  LibraryRequestScope,
  LibraryAuthentication,
  LibrarySessionDenied,
  localLibraryAuthenticationLayer,
} from "../../../apps/gateway/src/library-session.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

const Metric = Schema.Literals([
  "started",
  "closed",
  "reads",
  "sends",
  "scopes",
  "scopesClosed",
  "requests",
  "requestsClosed",
  "physicalAborts",
]);

type Metric = typeof Metric.Type;

const makeProbe = () => {
  const counts: Record<Metric, number> = {
    started: 0,
    closed: 0,
    reads: 0,
    sends: 0,
    scopes: 0,
    scopesClosed: 0,
    requests: 0,
    requestsClosed: 0,
    physicalAborts: 0,
  };

  const pending = new Set<{ metric: Metric; target: number; resume: () => void }>();

  const record = (metric: Metric) => {
    counts[metric]++;

    for (const waiter of pending) if (counts[waiter.metric] >= waiter.target) waiter.resume();
  };

  const bump = (metric: Metric) => Effect.sync(() => record(metric));

  return {
    bump,
    record,
    snapshot: () => ({ ...counts, live: counts.started - counts.closed, waiters: pending.size }),
    wait: (metric: Metric, target: number) =>
      Effect.callback<void>((resume) => {
        if (counts[metric] >= target) {
          resume(Effect.void);

          return;
        }

        const waiter = { metric, target, resume: () => resume(Effect.void) };
        pending.add(waiter);

        return Effect.sync(() => {
          pending.delete(waiter);
        });
      }),
  };
};

class Probe extends Context.Service<Probe, ReturnType<typeof makeProbe>>()(
  "OwnedLibraryHttp/Probe",
) {}

const ControlLive = LibraryControlAdapters.pipe(Layer.provideMerge(LibraryControl.layer));

const HooksLive = libraryRecoveryHooksLayer({
  modelName: "LibraryModel",
  layout: 0,
  libraryId: "owner",
  epoch: 1,
  lineage: "library-1",
}).pipe(Layer.provide(ControlLive));

const Native = DomainCloudflare.layerDurableObjects({ recovery: HooksLive });

// Observe the actual native stores; all commands, polling and persistence delegate
// unchanged to the installed provider. These counters are lifecycle evidence only.
const Observed = Layer.effect(
  Platform,
  Effect.gen(function* () {
    const native = yield* Platform;
    const probe = yield* Probe;
    const marked = new WeakSet<Scope.Scope>();

    return Platform.of({
      model: (model) =>
        native.model(model).pipe(
          Effect.map((host) => ({
            ...host,
            aggregate: (aggregate, kit) =>
              host.aggregate(aggregate, kit).pipe(
                Effect.map((store) => ({
                  ...store,
                  send: (id, command, meta) =>
                    probe.bump("sends").pipe(Effect.andThen(store.send(id, command, meta))),
                  state: Effect.fnUntraced(function* (id) {
                    yield* probe.bump("reads");
                    const scope = yield* Effect.serviceOption(Scope.Scope);

                    if (Option.isSome(scope) && !marked.has(scope.value)) {
                      marked.add(scope.value);
                      yield* probe.bump("scopes");
                      yield* Scope.addFinalizer(scope.value, probe.bump("scopesClosed"));
                    }

                    return yield* store.state(id);
                  }),
                  changes: (id) =>
                    store.changes(id).pipe(
                      Stream.onStart(probe.bump("started")),
                      Stream.onExit(() => probe.bump("closed")),
                    ),
                })),
              ),
          })),
        ),
    });
  }),
).pipe(Layer.provideMerge(Native));

const Live = Layer.mergeAll(
  ControlLive,
  HooksLive,
  LibraryModel.layer(Layer.empty).pipe(Layer.provide(Observed)),
);

class FixtureSessions extends Context.Service<FixtureSessions, Map<string, number>>()(
  "OwnedLibraryHttp/Sessions",
) {}

const FixtureAuth = Layer.effect(
  LibraryAuthentication,
  Effect.gen(function* () {
    const sessions = yield* FixtureSessions;

    return LibraryAuthentication.of({
      verify: Effect.fnUntraced(function* (request) {
        const expiresAt = sessions.get(request.headers.get("x-local-session") ?? "");

        if (expiresAt === undefined)
          return yield* new LibrarySessionDenied({ reason: "assertion" });

        return yield* Effect.gen(function* () {
          const local = yield* LibraryAuthentication;

          return yield* local.verify(request);
        }).pipe(
          Effect.provide(localLibraryAuthenticationLayer(new URL(request.url).origin, expiresAt)),
        );
      }),
    });
  }),
);

const HttpLive = libraryHttpLayer({
  rpcPath: "/v1/library/rpc",
  sessionPath: "/v1/library/session",
  authorityTimeoutMs: 5000,
}).pipe(Layer.provideMerge(Live), Layer.provide(FixtureAuth), Layer.orDie);

const FixtureInput = Schema.Struct({
  action: Schema.Literals(["initialize", "issue", "stats", "wait", "freeze"]),
  ttlMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: -1000, maximum: 60000 }))),
  metric: Schema.optional(Metric),
  waitMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10000 }))),
  target: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))),
});

export default class OwnedLibraryHttp extends Cloudflare.Worker<OwnedLibraryHttp>()(
  "OwnedLibraryHttp",
  { main: import.meta.url },
  Effect.gen(function* () {
    const probe = yield* Probe;
    const control = yield* LibraryControl;
    const libraries = yield* Library;

    const app = yield* LibraryHttp;
    const sessions = yield* FixtureSessions;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* Cloudflare.Request;
        const url = new URL(request.url);

        if (url.pathname === "/fixture" && request.method === "POST") {
          const input = yield* Effect.tryPromise(() => request.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(FixtureInput)),
            Effect.orDie,
          );

          const action = Match.value(input.action).pipe(
            Match.when("initialize", () =>
              Effect.gen(function* () {
                yield* control.initialize("http-empty-v1");
                yield* libraries
                  .send(
                    LibraryId.make("owner"),
                    new FinalizeLibraryImport({
                      inventoryId: "http-empty-v1",
                      expectedImportedCount: 0,
                      expectedHighWater: 0,
                    }),
                    { commandId: "library:1:import:http-empty-v1:finalize" },
                  )
                  .pipe(
                    Effect.provideService(LibraryActor, {
                      libraryId: LibraryId.make("owner"),
                      authority: "import",
                      importFinalized: false,
                    }),
                    Effect.provideService(LibraryRequestScope, { libraryId: "owner", epoch: 1 }),
                  );

                return yield* control.finishImport("http-empty-v1", 0);
              }),
            ),
            Match.when("issue", () =>
              Effect.sync(() => {
                const key = crypto.randomUUID();
                const expiresAt = Date.now() + (input.ttlMs ?? 30000);
                sessions.set(key, expiresAt);

                return { key, expiresAt };
              }),
            ),
            Match.when("stats", () => Effect.sync(probe.snapshot)),
            Match.when("wait", () =>
              probe
                .wait(input.metric ?? "closed", input.target ?? 1)
                .pipe(Effect.andThen(Effect.sync(probe.snapshot))),
            ),
            Match.when("freeze", () => control.beginFreeze("http-freeze")),
            Match.exhaustive,
          );

          const result = yield* Effect.exit(action.pipe(Effect.timeout(input.waitMs ?? 10000)));

          return yield* HttpServerResponse.json(
            Exit.isSuccess(result)
              ? { ok: true, value: result.value }
              : { ok: false, error: Cause.pretty(result.cause) },
          );
        }

        if (!url.pathname.startsWith("/v1/library/"))
          return HttpServerResponse.empty({ status: 404 });

        if (["/v1/library/rpc", "/v1/library/rpc/"].includes(url.pathname)) {
          yield* probe.bump("requests");

          const aborted = () => {
            probe.record("physicalAborts");
          };

          request.signal.addEventListener("abort", aborted, { once: true });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => request.signal.removeEventListener("abort", aborted)),
          );
          yield* Effect.addFinalizer(() => probe.bump("requestsClosed"));
        }

        const response = yield* app.route(request);

        return response ?? HttpServerResponse.empty({ status: 404 });
      }).pipe(
        Effect.tapCause((cause) =>
          Effect.sync(() => console.error("owned HTTP fixture failure", Cause.pretty(cause))),
        ),
      ),
    };
  }).pipe(
    Effect.provide(HttpLive),
    Effect.provide(
      Layer.mergeAll(
        Layer.sync(Probe, makeProbe),
        Layer.sync(FixtureSessions, () => new Map<string, number>()),
      ),
    ),
  ),
) {}
