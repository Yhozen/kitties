import { Library } from "@kitties/domain/Library/Library.aggregate";
import { FinalizedImport } from "@kitties/domain/Library/Library.state";
import { LibraryApi } from "@kitties/domain/LibraryApi.api";
import { LibrarySession } from "@kitties/domain/LibrarySession.middleware";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import type { HttpServerError } from "effect/http/HttpServerError";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  LibraryAdmission,
  LibraryAdmissionUnavailable,
  LibraryAuthentication,
  LibraryEpoch,
  LibraryEpochSource,
  LibraryRequestScope,
  LibrarySessionLive,
  LibraryTransportSession,
  awaitLibrarySessionExpiry,
  withinLibrarySession,
  type VerifiedLibrarySession,
} from "./library-session.ts";

const RoutePath = Schema.String.check(Schema.isPattern(/^\/[A-Za-z0-9_/-]+$/));

const Configuration = Schema.Struct({
  rpcPath: RoutePath,
  sessionPath: RoutePath,
  authorityTimeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
});

export type LibraryHttpConfiguration = typeof Configuration.Type;

export class LibraryHttpConfigurationInvalid extends Schema.TaggedError<
  LibraryHttpConfigurationInvalid,
  {
    readonly brand: unique symbol;
  }
>()("LibraryHttpConfigurationInvalid", {}) {}

export class LibraryHttp extends Context.Service<
  LibraryHttp,
  {
    readonly route: (
      request: Request,
    ) => Effect.Effect<
      HttpServerResponse.HttpServerResponse | undefined,
      HttpBody.HttpBodyError | HttpServerError,
      Scope.Scope
    >;
  }
>()("@kitties/gateway/LibraryHttp") {}

const json = (status: number, value: Schema.Json) =>
  HttpServerResponse.fromWeb(
    Response.json(value, {
      status,
      headers: { "Cache-Control": "no-store" },
    }),
  );

const unavailable = () => new LibraryAdmissionUnavailable();

type HostedLibrary =
  | Exclude<Effect.Services<typeof LibraryApi>, LibrarySession>
  | Effect.Services<typeof Library>;

export const libraryHttpLayer = (configuration: LibraryHttpConfiguration) =>
  Layer.effect(
    LibraryHttp,
    Effect.gen(function* () {
      const config = yield* Schema.decodeUnknownEffect(Configuration)(configuration).pipe(
        Effect.mapError(() => new LibraryHttpConfigurationInvalid()),
      );

      if (config.rpcPath === config.sessionPath)
        return yield* new LibraryHttpConfigurationInvalid();
      const authentication = yield* LibraryAuthentication;
      const epochs = yield* LibraryEpochSource;
      const admission = yield* LibraryAdmission;
      const libraries = yield* Library;
      // A typed context view still contains every runtime service. Remove the
      // construction scope physically so it cannot override a request child.
      const model = (yield* Effect.context<HostedLibrary>()).pipe(Context.omit(Scope.Scope));

      const handshake = Effect.fnUntraced(function* (session: VerifiedLibrarySession) {
        const epoch = yield* epochs
          .current(session.libraryId)
          .pipe(
            Effect.flatMap((epoch) =>
              Schema.decodeUnknownEffect(LibraryEpoch)(epoch).pipe(Effect.mapError(unavailable)),
            ),
          );

        const scope = Object.freeze({ libraryId: session.libraryId, epoch });
        yield* admission.check(scope);

        const state = yield* libraries
          .state(session.libraryId)
          .pipe(Effect.provideService(LibraryRequestScope, scope));

        if (!Schema.is(FinalizedImport)(state.importProgress))
          return json(409, { code: "LIBRARY_IMPORT_REQUIRED" });

        return json(200, { libraryId: session.libraryId, epoch, expiresAt: session.expiresAt });
      });

      const rpc = Effect.fnUntraced(function* (request: Request, session: VerifiedLibrarySession) {
        const parent = yield* Effect.scope;
        const child = yield* Scope.fork(parent);

        const requestLayer = LibrarySessionLive.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeedContext(model),
              Layer.succeed(LibraryAdmission, admission),
              Layer.succeed(LibraryTransportSession, session),
            ),
          ),
        );

        const response = yield* withinLibrarySession(
          session,
          Effect.gen(function* () {
            const api = yield* LibraryApi;

            return yield* api.fetch;
          }).pipe(
            Effect.provide(requestLayer),
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(request),
            ),
            Scope.provide(child),
          ),
        ).pipe(
          Effect.onExit((exit) =>
            Exit.match(exit, {
              onFailure: () => Scope.close(child, exit),
              onSuccess: () => Effect.void,
            }),
          ),
        );

        // The RPC middleware bounds the handler drain. This body deadline also
        // bounds blocked output; body exit/cancel closes the owned server scope.
        return yield* Match.value(response.body).pipe(
          Match.tag("Stream", (body) =>
            Effect.gen(function* () {
              // Start independently of body pulls: an unread response must release
              // its RPC server too. The enclosing HTTP server owns the parent scope.
              const deadline = yield* awaitLibrarySessionExpiry(session).pipe(
                Effect.catchTag("LibrarySessionExpired", () => Scope.close(child, Exit.void)),
                Effect.forkIn(parent),
              );

              return HttpServerResponse.setBody(
                response,
                HttpBody.stream(
                  body.stream.pipe(
                    Stream.interruptWhen(awaitLibrarySessionExpiry(session)),
                    Stream.onExit((exit) =>
                      Fiber.interrupt(deadline).pipe(Effect.andThen(Scope.close(child, exit))),
                    ),
                  ),
                  body.contentType,
                  body.contentLength,
                ),
              );
            }),
          ),
          Match.orElse(() => Scope.close(child, Exit.void).pipe(Effect.as(response))),
        );
      });

      return LibraryHttp.of({
        route: Effect.fnUntraced(function* (request) {
          const url = new URL(request.url);

          // The official Effect RPC HTTP client prepends its base URL to an
          // empty path, yielding one trailing slash. Accept that exact alias
          // without redirecting a credential-bearing native request.
          const rpcRequest =
            url.pathname === config.rpcPath || url.pathname === `${config.rpcPath}/`;

          if (!rpcRequest && url.pathname !== config.sessionPath) return;

          if (request.headers.has("upgrade")) return json(426, { code: "LIBRARY_HTTP_ONLY" });
          const handshakeRequest = url.pathname === config.sessionPath;

          if (request.method !== (handshakeRequest ? "GET" : "POST"))
            return json(405, { code: "METHOD_NOT_ALLOWED" });

          if (url.search !== "") return json(400, { code: "LIBRARY_QUERY_NOT_ALLOWED" });

          return yield* Effect.gen(function* () {
            const session = yield* authentication.verify(request);

            if (handshakeRequest)
              return yield* withinLibrarySession(
                session,
                handshake(session).pipe(
                  Effect.timeoutOrElse({
                    duration: config.authorityTimeoutMs,
                    orElse: unavailable,
                  }),
                ),
              );

            if (
              request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
              "application/x-ndjson"
            ) {
              return json(415, { code: "LIBRARY_NDJSON_REQUIRED" });
            }

            return yield* rpc(request, session);
          }).pipe(
            Effect.catchTag("LibrarySessionDenied", () =>
              Effect.succeed(json(403, { code: "LIBRARY_ACCESS_DENIED" })),
            ),
            Effect.catchTag("LibrarySessionExpired", () =>
              Effect.succeed(json(403, { code: "LIBRARY_SESSION_EXPIRED" })),
            ),
            Effect.catchTag("LibraryAdmissionDenied", () =>
              Effect.succeed(json(409, { code: "LIBRARY_RECOVERY_FENCED" })),
            ),
            Effect.catchTag("LibraryAdmissionUnavailable", () =>
              Effect.succeed(json(503, { code: "LIBRARY_RECOVERY_UNAVAILABLE" })),
            ),
          );
        }),
      });
    }),
  );
