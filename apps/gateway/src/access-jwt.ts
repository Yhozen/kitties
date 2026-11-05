import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const HttpsOrigin = Schema.String.check(
  Schema.makeFilter((value) => {
    const url = Schema.decodeUnknownOption(Schema.URLFromString)(value);

    return Option.isSome(url) && url.value.protocol === "https:" && url.value.origin === value;
  }),
);

export const AccessAudience = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isTrimmed(),
);

const AccessHeader = Schema.Struct({
  alg: Schema.Literal("RS256"),
  kid: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});

const NumericDate = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Math.floor(Number.MAX_SAFE_INTEGER / 1000)),
);

const AccessClaims = Schema.Struct({
  iss: HttpsOrigin,
  exp: NumericDate,
  nbf: Schema.optional(NumericDate),
  iat: Schema.optional(NumericDate),
  email: Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+$/), Schema.isMaxLength(254)),
  aud: Schema.Union([
    AccessAudience,
    Schema.Array(AccessAudience).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  ]),
});

const AccessKeySet = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      kty: Schema.Literal("RSA"),
      kid: Schema.String,
      alg: Schema.optional(Schema.Literal("RS256")),
      use: Schema.optional(Schema.Literal("sig")),
      key_ops: Schema.optional(Schema.mutable(Schema.Array(Schema.Literal("verify")))),
      ext: Schema.optional(Schema.Boolean),
      n: Schema.String.check(Schema.isMinLength(1)),
      e: Schema.String.check(Schema.isMinLength(1)),
    }),
  ).check(Schema.isMaxLength(100)),
});

export type AccessIdentity = { readonly email: string; readonly expiresAt: number };

export class AccessAssertionRejected extends Schema.TaggedError<
  AccessAssertionRejected,
  { readonly brand: unique symbol }
>()("AccessAssertionRejected", {}) {}

export class AccessKeysUnavailable extends Schema.TaggedError<
  AccessKeysUnavailable,
  { readonly brand: unique symbol }
>()("AccessKeysUnavailable", {}) {}

export class AccessConfigurationInvalid extends Schema.TaggedError<
  AccessConfigurationInvalid,
  { readonly brand: unique symbol }
>()("AccessConfigurationInvalid", {}) {}

export const AccessKeyTimeoutMs = Context.Reference<number>("@kitties/gateway/AccessKeyTimeoutMs", {
  defaultValue: () => 5000,
});

export class AccessJwtVerifier extends Context.Service<
  AccessJwtVerifier,
  {
    readonly verify: (
      request: Request,
      issuer: string,
      audience: string,
    ) => Effect.Effect<
      AccessIdentity,
      AccessAssertionRejected | AccessKeysUnavailable | AccessConfigurationInvalid
    >;
  }
>()("@kitties/gateway/AccessJwtVerifier") {}

type KeySet = typeof AccessKeySet.Type;

type KeyCache = Map<string, { readonly expires: number; readonly keys: KeySet }>;

const Segment = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/));

const decodeBytes = (segment: string) =>
  Effect.try({
    try: () => {
      const value = Schema.decodeUnknownSync(Segment)(segment);

      return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (character) =>
        character.charCodeAt(0),
      );
    },
    catch: () => new AccessAssertionRejected(),
  });

const decodeSegment = Effect.fnUntraced(function* (segment: string) {
  const bytes = yield* decodeBytes(segment);

  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () => new AccessAssertionRejected(),
  });

  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(text).pipe(
    Effect.mapError(() => new AccessAssertionRejected()),
  );
});

const makeVerifier = (fetcher: typeof fetch, cache: KeyCache): AccessJwtVerifier["Service"] => ({
  verify: Effect.fnUntraced(function* (request, issuer, audience) {
    if (!Schema.is(HttpsOrigin)(issuer) || !Schema.is(AccessAudience)(audience))
      return yield* new AccessConfigurationInvalid();
    const token = request.headers.get("Cf-Access-Jwt-Assertion");

    if (!token || token.length > 32768) return yield* new AccessAssertionRejected();
    const parts = token.split(".");
    const [headerPart, claimsPart, signaturePart] = parts;

    if (parts.length !== 3 || !headerPart || !claimsPart || !signaturePart)
      return yield* new AccessAssertionRejected();

    const header = yield* decodeSegment(headerPart).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(AccessHeader)),
      Effect.mapError(() => new AccessAssertionRejected()),
    );

    const claims = yield* decodeSegment(claimsPart).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(AccessClaims)),
      Effect.mapError(() => new AccessAssertionRejected()),
    );

    const now = yield* Clock.currentTimeMillis;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

    if (
      claims.iss !== issuer ||
      claims.exp * 1000 <= now ||
      (claims.nbf !== undefined && claims.nbf * 1000 > now) ||
      (claims.iat !== undefined && claims.iat * 1000 > now) ||
      !audiences.includes(audience)
    ) {
      return yield* new AccessAssertionRejected();
    }

    const timeout = yield* AccessKeyTimeoutMs;

    const load = Effect.tryPromise({
      try: async (signal) => {
        const response = await fetcher(`${issuer}/cdn-cgi/access/certs`, {
          // Workers reject "error"; manual mode leaves any 3xx response for the ok check below.
          redirect: "manual",
          signal,
        });

        if (!response.ok || response.redirected) return undefined;
        const text = await response.text();

        return text.length <= 131072
          ? Schema.decodeUnknownOption(Schema.fromJsonString(AccessKeySet))(text)
          : undefined;
      },
      catch: () => new AccessKeysUnavailable(),
    }).pipe(
      Effect.flatMap((decoded) =>
        decoded !== undefined && Option.isSome(decoded)
          ? Effect.succeed(decoded.value)
          : Effect.fail(new AccessKeysUnavailable()),
      ),
      Effect.timeoutOrElse({ duration: timeout, orElse: () => new AccessKeysUnavailable() }),
      Effect.tap((keys) =>
        Effect.gen(function* () {
          const loadedAt = yield* Clock.currentTimeMillis;

          if (cache.size >= 8) cache.clear();
          cache.set(issuer, { expires: loadedAt + 300000, keys });
        }),
      ),
    );

    const saved = cache.get(issuer);
    let keys = saved && saved.expires > now ? saved.keys : yield* load;
    let jwk = keys.keys.find((candidate) => candidate.kid === header.kid);

    if (!jwk && saved && saved.expires > now) {
      keys = yield* load;
      jwk = keys.keys.find((candidate) => candidate.kid === header.kid);
    }

    if (!jwk) return yield* new AccessAssertionRejected();
    const selected = jwk;
    const signature = yield* decodeBytes(signaturePart);

    const valid = yield* Effect.tryPromise({
      try: async () => {
        const key = await crypto.subtle.importKey(
          "jwk",
          selected,
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        );

        return crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          key,
          signature,
          new TextEncoder().encode(`${headerPart}.${claimsPart}`),
        );
      },
      catch: () => new AccessAssertionRejected(),
    });

    // Discovery and cryptography may cross the assertion's exact expiry.
    const verifiedAt = yield* Clock.currentTimeMillis;

    if (!valid || claims.exp * 1000 <= verifiedAt) return yield* new AccessAssertionRejected();

    return { email: claims.email, expiresAt: claims.exp * 1000 };
  }),
});

/** Constructed layers own completed key values, never shared in-flight waiters. */
export const accessJwtLayer = (fetcher: typeof fetch = fetch) =>
  Layer.effect(
    AccessJwtVerifier,
    Effect.sync(() => makeVerifier(fetcher, new Map())),
  );

const legacyCaches = new WeakMap<typeof fetch, KeyCache>();

/** Legacy caller contract; the added expiry is verified, in epoch milliseconds. */
export function verifiedAccessIdentity(
  request: Request,
  issuer: string,
  audience: string,
  fetcher: typeof fetch = fetch,
): Promise<AccessIdentity | undefined> {
  let cache = legacyCaches.get(fetcher);

  if (!cache) {
    cache = new Map();
    legacyCaches.set(fetcher, cache);
  }

  return Effect.runPromise(
    makeVerifier(fetcher, cache)
      .verify(request, issuer, audience)
      .pipe(Effect.catch(() => Effect.succeed(undefined))),
  );
}
