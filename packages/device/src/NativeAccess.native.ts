import { Clock, Context, Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import {
  NativeAccessAuthentication,
  NativeAccessConfiguration,
  NativeAccessError,
} from "./NativeAccessAuthentication.ts";

export const NativeAccessTimeouts = Context.Reference<{
  readonly connectMs: number;
  readonly cancellationMs: number;
}>("@kitties/device/NativeAccessTimeouts", {
  defaultValue: () => ({ connectMs: 10000, cancellationMs: 5000 }),
});

export type NativeHttpOptions = RequestInit & {
  readonly maxRedirections: 0;
  readonly connectTimeout: number;
};

// These ports belong to the native adapter; application features use HttpClient/authentication.
export class NativeAccessPort extends Context.Service<
  NativeAccessPort,
  {
    readonly configuration: Effect.Effect<unknown, NativeAccessError>;
    readonly begin: Effect.Effect<unknown, NativeAccessError>;
    readonly finish: (attemptId: string) => Effect.Effect<unknown, NativeAccessError>;
    readonly cancel: (attemptId: string) => Effect.Effect<void, NativeAccessError>;
  }
>()("@kitties/device/NativeAccessPort") {}

export class NativeHttpPort extends Context.Service<
  NativeHttpPort,
  { readonly send: (url: string, options: NativeHttpOptions) => Promise<Response> }
>()("@kitties/device/NativeHttpPort") {}

const Attempt = Schema.Struct({
  attemptId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
});

const Credential = Schema.Struct({
  accessToken: Schema.RedactedFromValue(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(8192),
      Schema.isPattern(/^[!-~]+$/),
    ),
  ),
  expiresIn: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(86400)),
});

type Session = {
  readonly token: Redacted.Redacted<string>;
  readonly expiresAt: number;
  readonly controller: AbortController;
};

export const layerNativeAccess = Layer.effectContext(
  Effect.gen(function* () {
    const port = yield* NativeAccessPort;
    const http = yield* NativeHttpPort;
    const clock = yield* Clock.Clock;
    const timeouts = yield* NativeAccessTimeouts;
    const scope = yield* Effect.scope;

    const configuration = yield* port.configuration.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(NativeAccessConfiguration, { onExcessProperty: "error" }),
      ),
      Effect.catchTag("SchemaError", () =>
        Effect.fail(new NativeAccessError({ reason: "Configuration" })),
      ),
    );

    let session: Session | undefined;
    let authenticating = false;
    let generation = 0;
    let pendingAttempt: string | undefined;

    const clear = Effect.gen(function* () {
      generation += 1;
      session?.controller.abort();

      if (session !== undefined) Redacted.wipeUnsafe(session.token);
      session = undefined;
      const attempt = pendingAttempt;

      if (attempt !== undefined)
        yield* port.cancel(attempt).pipe(Effect.timeout(timeouts.cancellationMs), Effect.ignore);
    });

    yield* Effect.addFinalizer(() => clear);

    const authenticate = Effect.acquireUseRelease(
      Effect.suspend(() =>
        authenticating
          ? Effect.fail(new NativeAccessError({ reason: "Unavailable" }))
          : Effect.sync(() => {
              authenticating = true;
            }),
      ),
      () =>
        Effect.gen(function* () {
          yield* clear;
          const startedGeneration = generation;

          const credential = yield* Effect.acquireUseRelease(
            port.begin.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Attempt, { onExcessProperty: "error" })),
              Effect.catchTag("SchemaError", () =>
                Effect.fail(new NativeAccessError({ reason: "Unavailable" })),
              ),
            ),
            ({ attemptId }) =>
              Effect.gen(function* () {
                pendingAttempt = attemptId;

                if (generation !== startedGeneration)
                  return yield* new NativeAccessError({ reason: "Cancelled" });

                return yield* port.finish(attemptId).pipe(
                  Effect.flatMap(
                    Schema.decodeUnknownEffect(Credential, { onExcessProperty: "error" }),
                  ),
                  Effect.catchTag("SchemaError", () =>
                    Effect.fail(new NativeAccessError({ reason: "Unavailable" })),
                  ),
                );
              }),
            ({ attemptId }) =>
              Effect.gen(function* () {
                if (pendingAttempt === attemptId) pendingAttempt = undefined;
                yield* port
                  .cancel(attemptId)
                  .pipe(Effect.timeout(timeouts.cancellationMs), Effect.ignore);
              }),
          );

          if (generation !== startedGeneration) {
            Redacted.wipeUnsafe(credential.accessToken);

            return yield* new NativeAccessError({ reason: "Cancelled" });
          }

          const next: Session = {
            token: credential.accessToken,
            expiresAt: clock.currentTimeMillisUnsafe() + credential.expiresIn * 1000,
            controller: new AbortController(),
          };

          session = next;
          yield* Effect.sleep(credential.expiresIn * 1000).pipe(
            Effect.andThen(Effect.suspend(() => (session === next ? clear : Effect.void))),
            Effect.forkIn(scope),
          );
        }),
      () =>
        Effect.sync(() => {
          authenticating = false;
        }),
    );

    // Authorization is injected after Effect's request/tracing boundary. No token is
    // part of an HttpClientRequest, a feature Model, or an error's retained cause.
    const fetch: typeof globalThis.fetch = async (input, options) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const headers = new Headers(options?.headers);

      if (
        url.origin !== configuration.applicationUrl ||
        url.username !== "" ||
        url.password !== "" ||
        url.search !== "" ||
        url.hash !== "" ||
        !["/v1/library/session", "/v1/library/rpc", "/v1/library/rpc/"].includes(url.pathname) ||
        headers.has("authorization") ||
        headers.has("cookie") ||
        headers.has("cf-access-token") ||
        headers.has("cf-access-jwt-assertion") ||
        headers.has("cf-access-client-secret") ||
        headers.has("cf-access-client-id") ||
        (options?.method !== "GET" && options?.method !== "POST") ||
        (url.pathname === "/v1/library/session" && options?.method !== "GET") ||
        (url.pathname !== "/v1/library/session" && options?.method !== "POST")
      )
        throw new NativeAccessError({ reason: "Configuration" });
      const active = session;

      if (active === undefined || clock.currentTimeMillisUnsafe() >= active.expiresAt)
        throw new NativeAccessError({ reason: "Denied" });
      headers.set("authorization", `Bearer ${Redacted.value(active.token)}`);
      let response: Response;

      try {
        response = await http.send(url.href, {
          ...options,
          headers,
          credentials: "omit",
          redirect: "manual",
          maxRedirections: 0,
          connectTimeout: timeouts.connectMs,
          signal: options?.signal
            ? AbortSignal.any([options.signal, active.controller.signal])
            : active.controller.signal,
        });
      } catch {
        throw new NativeAccessError({
          reason:
            active.controller.signal.aborted || options?.signal?.aborted
              ? "Cancelled"
              : "Unavailable",
        });
      }

      if (active.controller.signal.aborted || options?.signal?.aborted) {
        await response.body?.cancel().catch(() => {});
        throw new NativeAccessError({ reason: "Cancelled" });
      }

      if (
        (response.url !== "" && response.url !== url.href) ||
        response.redirected ||
        (response.status >= 300 && response.status < 400)
      ) {
        await response.body?.cancel().catch(() => {});
        throw new NativeAccessError({ reason: "Configuration" });
      }

      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => {});

        // Clearing the generation also terminates any sibling idle watches.
        if (session === active) {
          generation += 1;
          active.controller.abort();
          Redacted.wipeUnsafe(active.token);
          session = undefined;
        }

        throw new NativeAccessError({ reason: "Denied" });
      }

      return response;
    };

    const client = yield* Layer.build(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
    );

    return Context.add(client, NativeAccessAuthentication, { configuration, authenticate, clear });
  }),
);
