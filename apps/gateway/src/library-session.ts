import { Library } from "@kitties/domain/Library/Library.aggregate";
import { LibraryId } from "@kitties/domain/Library/Library.id";
import { FinalizedImport } from "@kitties/domain/Library/Library.state";
import { LibraryActor } from "@kitties/domain/LibraryActor.context";
import {
  LibraryImportSession,
  LibraryRequestPayload,
  LibrarySession,
  LibraryUnauthorized,
  ownsLibraryPayload,
} from "@kitties/domain/LibrarySession.middleware";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { AccessAudience, AccessJwtVerifier, HttpsOrigin } from "./access-jwt.ts";

export const LibraryEpoch = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const LibraryOperationId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:-]{1,128}$/));

const EncodedCommandId = Schema.String.check(
  Schema.isPattern(/^library:(0|[1-9][0-9]*):[A-Za-z0-9_.:-]{1,128}$/),
);

const CommandMetadata = Schema.Struct({ commandId: EncodedCommandId });

const MiddlewarePayload = Schema.Struct({
  ...LibraryRequestPayload.fields,
  commandId: Schema.optional(Schema.String),
});

const EpochHeader = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/));
export const LIBRARY_EPOCH_HEADER = "x-kitties-library-epoch";
export const LIBRARY_OWNER = LibraryId.make("owner");

export const libraryCommandId = (epoch: number, operationId: string): string =>
  `library:${LibraryEpoch.make(epoch)}:${LibraryOperationId.make(operationId)}`;

export const LibraryScope = Schema.Struct({ libraryId: LibraryId, epoch: LibraryEpoch });

export type LibraryScope = typeof LibraryScope.Type;

/** Per-call provider selection; never fill this with the current epoch on retry. */
export class LibraryRequestScope extends Context.Service<LibraryRequestScope, LibraryScope>()(
  "@kitties/gateway/LibraryRequestScope",
) {}

export class LibraryAdmissionDenied extends Schema.TaggedError<
  LibraryAdmissionDenied,
  { readonly brand: unique symbol }
>()("LibraryAdmissionDenied", {}) {}

export class LibraryAdmissionUnavailable extends Schema.TaggedError<
  LibraryAdmissionUnavailable,
  { readonly brand: unique symbol }
>()("LibraryAdmissionUnavailable", {}) {}

/** Supplied by the authoritative recovery adapter. No default or cached permit. */
export class LibraryAdmission extends Context.Service<
  LibraryAdmission,
  {
    readonly check: (
      scope: LibraryScope,
    ) => Effect.Effect<void, LibraryAdmissionDenied | LibraryAdmissionUnavailable>;
  }
>()("@kitties/gateway/LibraryAdmission") {}

/** Reads authoritative recovery control; never infer an epoch from a request. */
export class LibraryEpochSource extends Context.Service<
  LibraryEpochSource,
  {
    readonly current: (
      libraryId: LibraryId,
    ) => Effect.Effect<number, LibraryAdmissionDenied | LibraryAdmissionUnavailable>;
  }
>()("@kitties/gateway/LibraryEpochSource") {}

export const VerifiedLibrarySession = Schema.Struct({
  libraryId: LibraryId,
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
});

export type VerifiedLibrarySession = typeof VerifiedLibrarySession.Type;

/** Set by the verified HTTP/upgrade boundary; RPC headers cannot replace it. */
export class LibraryTransportSession extends Context.Service<
  LibraryTransportSession,
  VerifiedLibrarySession
>()("@kitties/gateway/LibraryTransportSession") {}

/** Only a trusted in-process import composition supplies this grant. */
export class LibraryImportGrant extends Context.Service<LibraryImportGrant, LibraryScope>()(
  "@kitties/gateway/LibraryImportGrant",
) {}

export class LibrarySessionExpired extends Schema.TaggedError<
  LibrarySessionExpired,
  { readonly brand: unique symbol }
>()("LibrarySessionExpired", {}) {}

export class LibrarySessionDenied extends Schema.TaggedError<
  LibrarySessionDenied,
  { readonly brand: unique symbol }
>()("LibrarySessionDenied", {
  reason: Schema.Literals(["configuration", "endpoint", "assertion", "owner", "origin", "expired"]),
}) {}

const NativeOrigin = Schema.Literals([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
]);

const AccessConfiguration = Schema.Struct({
  publicUrl: HttpsOrigin,
  issuer: HttpsOrigin,
  audience: AccessAudience,
  ownerEmail: Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+$/), Schema.isMaxLength(254)),
  nativeOrigins: Schema.Array(NativeOrigin),
});

export type LibraryAccessConfiguration = typeof AccessConfiguration.Type;

export class LibraryAuthentication extends Context.Service<
  LibraryAuthentication,
  {
    readonly verify: (
      request: Request,
    ) => Effect.Effect<VerifiedLibrarySession, LibrarySessionDenied>;
  }
>()("@kitties/gateway/LibraryAuthentication") {}

const requireFreshSession = Effect.fnUntraced(function* (session: VerifiedLibrarySession) {
  const now = yield* Clock.currentTimeMillis;

  if (!Schema.is(VerifiedLibrarySession)(session) || session.expiresAt <= now) {
    return yield* new LibrarySessionExpired();
  }
});

/** An absolute deadline, including idle work. Changing credentials cannot extend it. */
export const awaitLibrarySessionExpiry = Effect.fnUntraced(function* (
  session: VerifiedLibrarySession,
) {
  yield* requireFreshSession(session);
  const now = yield* Clock.currentTimeMillis;
  yield* Effect.sleep(session.expiresAt - now);

  return yield* new LibrarySessionExpired();
});

export const withinLibrarySession = <A, E, R>(
  session: VerifiedLibrarySession,
  effect: Effect.Effect<A, E, R>,
) =>
  requireFreshSession(session).pipe(
    Effect.andThen(Effect.raceFirst(effect, awaitLibrarySessionExpiry(session))),
  );

// Browser requests retain same-origin/CSRF protection. Native requests must not
// carry browser cookies or Fetch Metadata, even when a caller invents a bearer.
const allowedTransport = (
  request: Request,
  publicUrl: string,
  nativeOrigins: ReadonlyArray<string>,
) => {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");

  if (origin === publicUrl) return site === null || site === "same-origin";
  const bearer = request.headers.get("authorization");

  if (bearer !== null) {
    return (
      /^Bearer [^\s,]+$/i.test(bearer) &&
      (origin === null || nativeOrigins.includes(origin)) &&
      !request.headers.has("cookie") &&
      ![...request.headers.keys()].some((name) => name.startsWith("sec-fetch-"))
    );
  }

  return (
    ["GET", "HEAD"].includes(request.method) &&
    origin === null &&
    (site === null || site === "same-origin" || site === "none")
  );
};

export const libraryAuthenticationLayer = (configuration: LibraryAccessConfiguration) =>
  Layer.effect(
    LibraryAuthentication,
    Effect.gen(function* () {
      const config = yield* Schema.decodeUnknownEffect(AccessConfiguration)(configuration).pipe(
        Effect.mapError(() => new LibrarySessionDenied({ reason: "configuration" })),
      );

      const assertions = yield* AccessJwtVerifier;

      return LibraryAuthentication.of({
        verify: Effect.fnUntraced(function* (request) {
          const url = new URL(request.url);

          if (url.origin !== config.publicUrl || url.username !== "" || url.password !== "") {
            return yield* new LibrarySessionDenied({ reason: "endpoint" });
          }

          // No Access context shortcut: the assertion supplies both owner and expiry.
          const identity = yield* assertions
            .verify(request, config.issuer, config.audience)
            .pipe(Effect.mapError(() => new LibrarySessionDenied({ reason: "assertion" })));

          if (identity.email.toLowerCase() !== config.ownerEmail.toLowerCase()) {
            return yield* new LibrarySessionDenied({ reason: "owner" });
          }

          if (!allowedTransport(request, config.publicUrl, config.nativeOrigins)) {
            return yield* new LibrarySessionDenied({ reason: "origin" });
          }

          const session = { libraryId: LIBRARY_OWNER, expiresAt: identity.expiresAt };
          yield* requireFreshSession(session).pipe(
            Effect.mapError(() => new LibrarySessionDenied({ reason: "expired" })),
          );

          return Object.freeze(session);
        }),
      });
    }),
  );

/** Alchemy plan-phase composition: bindings are absent, so every request is refused. */
export const planLibraryAuthenticationLayer = Layer.succeed(
  LibraryAuthentication,
  LibraryAuthentication.of({
    verify: () => Effect.fail(new LibrarySessionDenied({ reason: "configuration" })),
  }),
);

/** Explicit local composition only: no request flag/header activates this layer. */
export const localLibraryAuthenticationLayer = (publicUrl: string, expiresAt: number) =>
  Layer.effect(
    LibraryAuthentication,
    Effect.gen(function* () {
      const url = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(publicUrl).pipe(
        Effect.mapError(() => new LibrarySessionDenied({ reason: "configuration" })),
      );

      const session = { libraryId: LIBRARY_OWNER, expiresAt };

      if (
        url.origin !== publicUrl ||
        url.protocol !== "http:" ||
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        !Schema.is(VerifiedLibrarySession)(session)
      ) {
        return yield* new LibrarySessionDenied({ reason: "configuration" });
      }

      return LibraryAuthentication.of({
        verify: Effect.fnUntraced(function* (request) {
          if (new URL(request.url).origin !== publicUrl)
            return yield* new LibrarySessionDenied({ reason: "endpoint" });

          if (!allowedTransport(request, publicUrl, []))
            return yield* new LibrarySessionDenied({ reason: "origin" });
          yield* requireFreshSession(session).pipe(
            Effect.mapError(() => new LibrarySessionDenied({ reason: "expired" })),
          );

          return Object.freeze(session);
        }),
      });
    }),
  );

const epochFromDecimal = (value: string) =>
  Schema.decodeUnknownEffect(EpochHeader)(value).pipe(
    Effect.flatMap((text) => Schema.decodeUnknownEffect(LibraryEpoch)(Number(text))),
    Effect.mapError(() => new LibraryUnauthorized()),
  );

/** Parse immutable command metadata; reads use an explicitly supplied scope header. */
const requestEpoch = Effect.fnUntraced(function* (
  payload: typeof MiddlewarePayload.Type,
  epochHeader: string | undefined,
) {
  if (payload.target !== undefined) {
    const metadata = yield* Schema.decodeUnknownEffect(CommandMetadata)(payload).pipe(
      Effect.mapError(() => new LibraryUnauthorized()),
    );

    const epoch = yield* epochFromDecimal(metadata.commandId.split(":")[1]);

    // A fresh global header must not silently adopt a pre-restore intent.
    if (epochHeader !== undefined && (yield* epochFromDecimal(epochHeader)) !== epoch)
      return yield* new LibraryUnauthorized();

    return epoch;
  }

  if (epochHeader === undefined) return yield* new LibraryUnauthorized();

  return yield* epochFromDecimal(epochHeader);
});

export const LibrarySessionLive = Layer.effect(
  LibrarySession,
  Effect.gen(function* () {
    const session = Object.freeze(VerifiedLibrarySession.make(yield* LibraryTransportSession));
    const admission = yield* LibraryAdmission;
    const libraries = yield* Library;

    return LibrarySession.of((next, { rpc, payload, headers }) =>
      withinLibrarySession(
        session,
        Effect.gen(function* () {
          const decoded = yield* Schema.decodeUnknownEffect(MiddlewarePayload)(payload).pipe(
            Effect.mapError(() => new LibraryUnauthorized()),
          );

          const actor = {
            libraryId: session.libraryId,
            authority: "owner" as const,
            importFinalized: false,
          };

          if (!ownsLibraryPayload(actor, rpc._tag, decoded))
            return yield* new LibraryUnauthorized();
          const epoch = yield* requestEpoch(decoded, headers[LIBRARY_EPOCH_HEADER]);
          const scope = Object.freeze({ libraryId: session.libraryId, epoch });
          yield* admission.check(scope).pipe(Effect.mapError(() => new LibraryUnauthorized()));

          return yield* Effect.gen(function* () {
            const state = yield* libraries.state(session.libraryId);
            yield* requireFreshSession(session);

            return yield* Effect.provideService(next, LibraryActor, {
              ...actor,
              importFinalized: Schema.is(FinalizedImport)(state.importProgress),
            });
          }).pipe(Effect.provideService(LibraryRequestScope, scope));
        }),
      ).pipe(Effect.catchTag("LibrarySessionExpired", () => new LibraryUnauthorized())),
    );
  }),
);

export const LibraryImportSessionLive = Layer.effect(
  LibraryImportSession,
  Effect.gen(function* () {
    const supplied = yield* LibraryImportGrant;
    const grant = Object.freeze(LibraryScope.make(supplied));
    const admission = yield* LibraryAdmission;
    const libraries = yield* Library;

    return LibraryImportSession.of((next, { rpc, payload }) =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknownEffect(MiddlewarePayload)(payload).pipe(
          Effect.mapError(() => new LibraryUnauthorized()),
        );

        const actor = {
          libraryId: grant.libraryId,
          authority: "import" as const,
          importFinalized: false,
        };

        if (!ownsLibraryPayload(actor, rpc._tag, decoded)) return yield* new LibraryUnauthorized();
        const epoch = yield* requestEpoch(decoded, undefined);

        if (epoch !== grant.epoch) return yield* new LibraryUnauthorized();
        yield* admission.check(grant).pipe(Effect.mapError(() => new LibraryUnauthorized()));

        return yield* Effect.gen(function* () {
          const state = yield* libraries.state(grant.libraryId);

          return yield* Effect.provideService(next, LibraryActor, {
            ...actor,
            importFinalized: Schema.is(FinalizedImport)(state.importProgress),
          });
        }).pipe(Effect.provideService(LibraryRequestScope, grant));
      }),
    );
  }),
);
