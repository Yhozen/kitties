import { CommandHeaders } from "@alchemy.run/domain/Foldkit";
import { NativeAccessError } from "@kitties/device/NativeAccessAuthentication";
import { LibraryApi } from "@kitties/domain/LibraryApi.api";
import { LibraryId } from "@kitties/domain/Library/Library.id";
import { LibraryUnauthorized } from "@kitties/domain/LibrarySession.middleware";
import {
  Cause,
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
  ScopedRef,
  Semaphore,
  Stream,
} from "effect";
import * as ByteSize from "effect/ByteSize";
import * as Headers from "effect/http/Headers";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as RpcClient from "effect/rpc/RpcClient";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type * as Scope from "effect/Scope";
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError";
import {
  LibraryClientAuthentication,
  LibraryClientScope,
  LibraryReauthenticationFailed,
} from "../library/LibraryClientAuthentication.ts";

export const LibraryHandshake = Schema.Struct({
  libraryId: LibraryId,
  epoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
});

export type LibraryHandshake = typeof LibraryHandshake.Type;

export type LibraryApiClient = typeof LibraryApi.Client.Service;

export class LibraryConnectionError extends Schema.TaggedError<
  LibraryConnectionError,
  { readonly brand: unique symbol }
>()("LibraryConnectionError", {
  reason: Schema.Literals(["Denied", "Unavailable", "NotReady", "ChangedAuthority"]),
}) {}

export interface LibraryConnectionSession {
  readonly client: LibraryApiClient;
  readonly handshake: LibraryHandshake;
}

/** The host owns credentials; this port returns only the official client and safe metadata. */
export class LibraryConnectionTransport extends Context.Service<
  LibraryConnectionTransport,
  {
    readonly open: (
      interactive: boolean,
    ) => Effect.Effect<LibraryConnectionSession, LibraryConnectionError, Scope.Scope>;
  }
>()("@kitties/web/library-host/LibraryConnectionTransport") {
  static readonly unavailable = Layer.succeed(LibraryConnectionTransport, {
    open: () => Effect.fail(new LibraryConnectionError({ reason: "Unavailable" })),
  });

  static readonly layerHttp = (
    config: { readonly origin: string; readonly allowLoopback: boolean },
    authenticate: Effect.Effect<void, LibraryConnectionError>,
  ) =>
    Layer.effect(
      LibraryConnectionTransport,
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;
        const timeoutMs = yield* LibraryCallTimeoutMs;

        return LibraryConnectionTransport.of({
          open: Effect.fnUntraced(function* (interactive) {
            const url = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(config.origin).pipe(
              Effect.mapError(() => new LibraryConnectionError({ reason: "Unavailable" })),
            );

            if (
              url.origin !== config.origin ||
              (url.protocol !== "https:" &&
                !(
                  config.allowLoopback &&
                  url.protocol === "http:" &&
                  (url.hostname === "localhost" || url.hostname === "127.0.0.1")
                ))
            )
              return yield* new LibraryConnectionError({ reason: "Unavailable" });

            if (interactive) yield* authenticate;

            const handshake = yield* Effect.scoped(
              Effect.gen(function* () {
                const response = yield* http.get(`${config.origin}/v1/library/session`);

                if (response.status === 401 || response.status === 403)
                  return yield* new LibraryConnectionError({ reason: "Denied" });

                if (response.status === 409)
                  return yield* new LibraryConnectionError({ reason: "NotReady" });

                if (response.status !== 200)
                  return yield* new LibraryConnectionError({ reason: "Unavailable" });

                return yield* response.json.pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(LibraryHandshake)),
                );
              }),
            ).pipe(
              Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(8)),
              Effect.mapError((error) =>
                Schema.is(LibraryConnectionError)(error)
                  ? error
                  : new LibraryConnectionError({
                      reason: Schema.is(NativeHttpDenial)(error) ? "Denied" : "Unavailable",
                    }),
              ),
              Effect.timeoutOrElse({
                duration: timeoutMs,
                orElse: () => new LibraryConnectionError({ reason: "Unavailable" }),
              }),
            );

            const client = yield* LibraryApi.clientHttp(`${config.origin}/v1/library/rpc`).pipe(
              Effect.provideService(HttpClient.HttpClient, HttpClient.filterStatusOk(http)),
            );

            return { client, handshake };
          }),
        });
      }),
    );
}

export const LibraryCallTimeoutMs = Context.Reference<number>(
  "@kitties/web/library-host/LibraryCallTimeoutMs",
  { defaultValue: () => 10000 },
);

const NativeTransportDenial = Schema.Struct({
  _tag: Schema.Literal("TransportError"),
  cause: NativeAccessError.check(Schema.makeFilter((error) => error.reason === "Denied")),
});

const NativeHttpDenial = Schema.Struct({
  _tag: Schema.Literal("HttpClientError"),
  reason: NativeTransportDenial,
});

const HttpDenial = Schema.Struct({
  _tag: Schema.Literal("RpcClientError"),
  reason: Schema.Struct({
    _tag: Schema.Literal("HttpError"),
    cause: Schema.Union([
      Schema.Struct({
        _tag: Schema.Literal("StatusCodeError"),
        response: Schema.Struct({ status: Schema.Literals([401, 403]) }),
      }),
      NativeTransportDenial,
    ]),
  }),
});

const timeout = () =>
  new RpcClientError({
    reason: new RpcClientDefect({ message: "Library request timed out", cause: undefined }),
  });

type ActiveConnection = LibraryConnectionSession & {
  readonly scope: LibraryClientScope;
  readonly closed: Ref.Ref<boolean>;
};

export class LibraryConnection extends Context.Service<
  LibraryConnection,
  {
    readonly connect: (
      interactive: boolean,
    ) => Effect.Effect<LibraryClientScope, LibraryConnectionError>;
  }
>()("@kitties/web/library-host/LibraryConnection") {
  static readonly layer = Layer.effectContext(
    Effect.gen(function* () {
      const transport = yield* LibraryConnectionTransport;
      const random = yield* SecureRandom.SecureRandom;
      const callMs = yield* LibraryCallTimeoutMs;
      const sessionId = yield* random.uuidV4();
      const current = yield* ScopedRef.make(() => Option.none<ActiveConnection>());
      const pinned = yield* Ref.make(Option.none<LibraryClientScope>());
      const gate = yield* Semaphore.make(1);

      const reconnect = Effect.fnUntraced(
        function* (interactive: boolean, expected: Option.Option<LibraryClientScope>) {
          const prior = yield* Ref.get(pinned);
          const scope = Option.orElse(prior, () => expected);

          yield* ScopedRef.set(
            current,
            Effect.gen(function* () {
              const connection = yield* transport.open(interactive);
              const closed = yield* Ref.make(false);

              // LIFO: mark this generation before RPC finalizers wake its pending calls.
              yield* Effect.addFinalizer(() => Ref.set(closed, true));

              const handshake = yield* Schema.decodeUnknownEffect(LibraryHandshake)(
                connection.handshake,
              ).pipe(Effect.mapError(() => new LibraryConnectionError({ reason: "Unavailable" })));

              const now = yield* Clock.currentTimeMillis;

              if (handshake.expiresAt <= now)
                return yield* new LibraryConnectionError({ reason: "Denied" });

              if (
                Option.isSome(expected) &&
                (expected.value.sessionId !== sessionId ||
                  (Option.isSome(prior) &&
                    (expected.value.owner !== prior.value.owner ||
                      expected.value.epoch !== prior.value.epoch)))
              )
                return yield* new LibraryConnectionError({ reason: "ChangedAuthority" });

              if (
                Option.isSome(scope) &&
                (scope.value.owner !== handshake.libraryId || scope.value.epoch !== handshake.epoch)
              )
                return yield* new LibraryConnectionError({ reason: "ChangedAuthority" });

              const value = LibraryClientScope.make({
                owner: handshake.libraryId,
                epoch: handshake.epoch,
                sessionId,
              });

              yield* Ref.set(pinned, Option.some(value));

              return Option.some({ client: connection.client, handshake, scope: value, closed });
            }),
          ).pipe(Effect.tapError(() => ScopedRef.set(current, Effect.succeed(Option.none()))));

          return yield* Option.match(yield* ScopedRef.get(current), {
            onNone: () => Effect.fail(new LibraryConnectionError({ reason: "Unavailable" })),
            onSome: (connection) => Effect.succeed(connection.scope),
          });
        },
        (effect) => gate.withPermit(effect),
      );

      const active = Effect.gen(function* () {
        const value = yield* ScopedRef.get(current);

        if (Option.isNone(value)) return yield* new LibraryUnauthorized();
        const now = yield* Clock.currentTimeMillis;

        if (value.value.handshake.expiresAt <= now) return yield* new LibraryUnauthorized();

        return value.value;
      });

      const normalize = <E>(error: E) =>
        Effect.fail(Schema.is(HttpDenial)(error) ? new LibraryUnauthorized() : error);

      const call = <A, E>(run: (client: LibraryApiClient) => Effect.Effect<A, E>) =>
        active.pipe(
          Effect.flatMap((session) =>
            run(session.client).pipe(
              RpcClient.withHeaders({ "x-kitties-library-epoch": String(session.scope.epoch) }),
              // Keep recovery interruptible: genuine caller cancellation skips it.
              Effect.catchCauseIf(Cause.hasInterruptsOnly, (cause) =>
                Effect.gen(function* () {
                  if (yield* Ref.get(session.closed))
                    return yield* new RpcClientError({
                      reason: new RpcClientDefect({
                        message: "Library connection replaced during request",
                        cause: undefined,
                      }),
                    });

                  return yield* Effect.failCause(cause);
                }),
              ),
              Effect.timeoutOrElse({ duration: callMs, orElse: timeout }),
              Effect.catch(normalize),
            ),
          ),
        );

      const watch = <A, E>(run: (client: LibraryApiClient) => Stream.Stream<A, E>) =>
        Stream.unwrap(
          active.pipe(
            Effect.map((session) =>
              run(session.client).pipe(
                Stream.provideService(
                  RpcClient.CurrentHeaders,
                  Headers.fromInput({ "x-kitties-library-epoch": String(session.scope.epoch) }),
                ),
                Stream.interruptWhen(
                  Clock.currentTimeMillis.pipe(
                    Effect.flatMap((now) =>
                      Effect.sleep(Math.max(0, session.handshake.expiresAt - now)),
                    ),
                    Effect.andThen(new LibraryUnauthorized()),
                  ),
                ),
                Stream.catch((error) => Stream.fromEffect(normalize(error))),
              ),
            ),
          ),
        );

      const client = LibraryApi.Client.of({
        ProposeSkill: (...args) => call((api) => api.ProposeSkill(...args)),
        AcceptSkill: (...args) => call((api) => api.AcceptSkill(...args)),
        RemoveSkill: (...args) => call((api) => api.RemoveSkill(...args)),
        Library: {
          get: (...args) => call((api) => api.Library.get(...args)),
          watch: (...args) => watch((api) => api.Library.watch(...args)),
          events: (...args) => watch((api) => api.Library.events(...args)),
        },
        SkillDetail: {
          get: (...args) => call((api) => api.SkillDetail.get(...args)),
          snapshot: (...args) => call((api) => api.SkillDetail.snapshot(...args)),
          list: (...args) => call((api) => api.SkillDetail.list(...args)),
          watch: (...args) => watch((api) => api.SkillDetail.watch(...args)),
          events: (...args) => watch((api) => api.SkillDetail.events(...args)),
        },
      });

      return Context.make(LibraryConnection, {
        connect: (interactive) => reconnect(interactive, Option.none()),
      }).pipe(
        Context.add(LibraryApi.Client, client),
        Context.add(LibraryClientAuthentication, {
          reauthenticate: (scope) =>
            reconnect(true, Option.some(scope)).pipe(
              Effect.asVoid,
              Effect.mapError(
                (error) =>
                  new LibraryReauthenticationFailed({
                    reason: error.reason === "NotReady" ? "Unavailable" : error.reason,
                  }),
              ),
            ),
        }),
        Context.add(CommandHeaders, {
          get: () =>
            ScopedRef.get(current).pipe(
              Effect.map(
                Option.match({
                  onNone: () => ({}),
                  onSome: (session) => ({ "x-kitties-library-epoch": String(session.scope.epoch) }),
                }),
              ),
            ),
        }),
      );
    }),
  );
}
