import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import { AccessJwtVerifier, accessJwtLayer, verifiedAccessIdentity } from "./access-jwt.ts";
import { LibraryAuthentication, libraryAuthenticationLayer } from "./library-session.ts";

// Publicly committed test-only RSA material. Fixed bytes make RS256 signatures reproducible.
const privateJwk = {
  key_ops: ["sign"],
  ext: true,
  alg: "RS256",
  kty: "RSA",
  n: "tYmGzRbcGOswK5MwCYbE1vxZEp-QsIwEiIAR73MbH1K1sGUxc9jJkKn1bBZMf1FlWI8eSVxjYD3VP-Y9DIRJjzXbBIiLERWBiEtPQBf8-N-YZnZVXY0MIt2_x9SjOQShJqWaKLdMUleT1ZLy6yoNwlX50gX_dgTqAnOXWDbKZhVIwBP-d6pLN4YnkJ_FutC81gwQaJBUxtoGsvgNN8vvSxMQ8l14U__HMikJff0E5YfgkajCkLVuZEEDmOB2Fq2RQHgfJduNFYtwchRxjMBm3-ywIDl_O0Sb1aZNpEtv6l4K2BqzIjqrbipOOVK12ppJBAtJC0cLeT-Rz7eVFeCqSw",
  e: "AQAB",
  d: "MJgSvH19BzKVn2Rz_GjV8hJ0qXaLHactY3ic1HMEdJsIRaKg3TjPo-jK6FcDvSUFsvIEknCnrVB_7-3qs5oJsssgyJLgXv9ZwCkgmrCRJ_F6cxsD-NnTwNWJC63Qz2d818KGhJWkWXpV-VqvqeGE81teVykB3A6usV9NyPBJt49RiLXkmjB3bEANJ1Hu0LsTgAbAJLFFLffa6qW67xDmNu2N9ymc8tsyf2CVlespyefUHV2QIt5Fs6ovnhwMYV2pQkOoK8M-YrnYvgI6i5bGv8uS8iCAW_2hHKAM4AabERcxkfX-ndnIBQ1bjPlUIB0jXlNp-lPDWjCvYdfxwDRPSQ",
  p: "3WYuZUMtDyaeso-gOYe17zn37iO7_S5BRw0FNHv43krVAr5xhx4SXMnpa_qELZzCJEhs-DTfptDpMVCPuMfyHPbRczKcrAFnhiqpapb6ic-xi0DzDTgrhh2wig9WLiU37da4zHrdoiWShg5O559J9AeMmEGzbD8IS72bqJ-ix68",
  q: "0eiI0DujfOBcoXKo3W12abEeIJ0JUMrafZCpuoedOtOBJ4K-OLy_U6JbAaB4r0jdlGa-po53QRcLP9Nfzn3hdYsz6ID6hldz_j5xqKZl_8GseY7c3-NYKusIOydJaWiKKnjjdhZ7LA94tIk2bSAUdzMPaqxWLT6QYhEChhAIkiU",
  dp: "qEC4L5J-ks4Juq9112KwO851AZA8lCrrxuA5PWqddemuubgbNNEAqW10q--lNbi0vbggv_wGn5KSNT0BDC8_aw2TnRUwhXNHxmlzeKKmYcbqKWbBjyFJylGT0UfYeZclSuVsaVFST6B4GtKS2mluXTrDeQ4tGa1JU64TtnEi1tc",
  dq: "kH4KV5UGGDr1aKld9naYUW77tyWCORw6RL8lJuKdZ9YaDNGiEbpT1cVn8fm9uaNl6_bB_DMLgkHTm47sX18lqN020TCfw4RFs1jWsmpAwkpWaKLgBjogAgMh-l4z2Zx9p3jp0ursxMqto1Dkpz-y9s6uKRcShziO-QKOgyxcSgU",
  qi: "WLtH7PLaVS6GoqYaqD0JmyhyXbJk7U4pvWnhaFJbnKKK_owUA5F5YYqygG_-28_76LFoStqm3rvO9VmW8QOgsD7G-wFgMqzdqI6ZOKZp_o1v56wp7-tUV3k-hZ97XNA_5ISS6OCkLD0pK1LqUtC6rV6or_HZf5LOJZtOsFlkito",
};

const issuer = "https://fixture.cloudflareaccess.com";
const audience = "fixture-audience";
const publicUrl = "https://kitties.example";

const claims = {
  iss: issuer,
  aud: [audience],
  exp: 60,
  nbf: 0,
  iat: 0,
  email: "OWNER@example.test",
};

const publicJwk = {
  kty: "RSA",
  kid: "fixture",
  n: privateJwk.n,
  e: privateJwk.e,
  alg: "RS256",
  use: "sig",
};

const encode = (value: Schema.Json) => Buffer.from(JSON.stringify(value)).toString("base64url");

const sign = async (value: Schema.Json, header: Schema.Json = { alg: "RS256", kid: "fixture" }) => {
  const input = `${encode(header)}.${encode(value)}`;

  const key = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(input),
  );

  return `${input}.${Buffer.from(signature).toString("base64url")}`;
};

const request = (token: string) =>
  new Request(`${publicUrl}/v1/library/rpc`, {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": token, authorization: "Bearer opaque-user-token" },
  });

const keys: typeof fetch = async () => Response.json({ keys: [publicJwk] });

it.effect(
  "verifies RSA owner assertion and exact expiry through the production authentication Layers",
  () =>
    Effect.gen(function* () {
      const calls: Array<{ url: string; redirect: string | undefined; hasAuthorization: boolean }> =
        [];

      const fetcher: typeof fetch = async (input, init) => {
        calls.push({
          url: new Request(input).url,
          redirect: init?.redirect,
          hasAuthorization: new Headers(init?.headers).has("authorization"),
        });

        return Response.json({ keys: [publicJwk] });
      };

      const token = yield* Effect.promise(() => sign(claims));

      const actual = yield* Effect.gen(function* () {
        const authentication = yield* LibraryAuthentication;

        return yield* authentication.verify(request(token));
      }).pipe(
        Effect.provide(
          libraryAuthenticationLayer({
            publicUrl,
            issuer,
            audience,
            ownerEmail: "owner@example.test",
            nativeOrigins: [],
          }).pipe(Layer.provide(accessJwtLayer(fetcher))),
        ),
      );

      expect(actual).toEqual({ libraryId: "owner", expiresAt: 60000 });
      expect(calls).toEqual([
        { url: `${issuer}/cdn-cgi/access/certs`, redirect: "manual", hasAuthorization: false },
      ]);
    }),
);

const invalidClaims = [
  { name: "exact expiry", change: { exp: 0 } },
  { name: "negative expiry", change: { exp: -1 } },
  { name: "fractional expiry", change: { exp: 0.5 } },
  { name: "string expiry", change: { exp: "60" } },
  { name: "null expiry", change: { exp: null } },
  { name: "unsafe milliseconds", change: { exp: 9007199254741 } },
  { name: "future not-before", change: { nbf: 1 } },
  { name: "malformed not-before", change: { nbf: "0" } },
  { name: "future issued-at", change: { iat: 1 } },
  { name: "wrong issuer", change: { iss: "https://attacker.example" } },
  { name: "wrong audience", change: { aud: ["other"] } },
  { name: "mixed audience types", change: { aud: [audience, 7] } },
  { name: "invalid email", change: { email: "owner" } },
];

for (const { name, change } of invalidClaims) {
  it.effect(`denies signed claims with ${name} before key discovery`, () =>
    Effect.gen(function* () {
      let fetched = 0;

      const fetcher: typeof fetch = async () => {
        fetched++;

        return Response.json({ keys: [publicJwk] });
      };

      const token = yield* Effect.promise(() => sign({ ...claims, ...change }));

      const denied = yield* Effect.gen(function* () {
        const verifier = yield* AccessJwtVerifier;

        return yield* verifier.verify(request(token), issuer, audience).pipe(Effect.flip);
      }).pipe(Effect.provide(accessJwtLayer(fetcher)));

      expect(denied._tag).toBe("AccessAssertionRejected");
      expect(fetched).toBe(0);
    }),
  );
}

it.effect("denies modified signed content and missing assertions rather than trusting bearer", () =>
  Effect.gen(function* () {
    const signed = yield* Effect.promise(() => sign(claims));
    const parts = signed.split(".");
    const tampered = `${parts[0]}.${encode({ ...claims, email: "attacker@example.test" })}.${parts[2]}`;
    const verifier = yield* AccessJwtVerifier;
    const result = yield* verifier.verify(request(tampered), issuer, audience).pipe(Effect.flip);

    const missing = yield* verifier
      .verify(
        new Request(publicUrl, { headers: { authorization: "Bearer fabricated" } }),
        issuer,
        audience,
      )
      .pipe(Effect.flip);

    expect([result._tag, missing._tag]).toEqual([
      "AccessAssertionRejected",
      "AccessAssertionRejected",
    ]);
  }).pipe(Effect.provide(accessJwtLayer(keys))),
);

const invalidIssuers = [
  "http://access.example",
  `${issuer}/`,
  `${issuer}/path`,
  `${issuer}?x=1`,
  "https://user:password@access.example",
];

for (const configuredIssuer of invalidIssuers) {
  it.effect(`rejects noncanonical issuer configuration ${configuredIssuer} without fetching`, () =>
    Effect.gen(function* () {
      let fetched = 0;

      const fetcher: typeof fetch = async () => {
        fetched++;

        return Response.json({ keys: [] });
      };

      const denied = yield* Effect.gen(function* () {
        const verifier = yield* AccessJwtVerifier;

        return yield* verifier
          .verify(request("x.y.z"), configuredIssuer, audience)
          .pipe(Effect.flip);
      }).pipe(Effect.provide(accessJwtLayer(fetcher)));

      expect(denied._tag).toBe("AccessConfigurationInvalid");
      expect(fetched).toBe(0);
    }),
  );
}

it.effect(
  "refreshes a missing kid once and caches completed keys without retaining a failed load",
  () =>
    Effect.gen(function* () {
      let fetched = 0;

      const fetcher: typeof fetch = async () => {
        fetched++;

        return fetched === 1
          ? new Response("offline", { status: 503 })
          : Response.json({ keys: [publicJwk] });
      };

      const token = yield* Effect.promise(() => sign(claims));

      const outcomes = yield* Effect.gen(function* () {
        const verifier = yield* AccessJwtVerifier;

        const unavailable = yield* verifier
          .verify(request(token), issuer, audience)
          .pipe(Effect.flip);

        const valid = yield* verifier.verify(request(token), issuer, audience);
        const cached = yield* verifier.verify(request(token), issuer, audience);

        const missingKid = yield* Effect.promise(() =>
          sign(claims, { alg: "RS256", kid: "absent" }),
        );

        const unknown = yield* verifier
          .verify(request(missingKid), issuer, audience)
          .pipe(Effect.flip);

        return { unavailable: unavailable._tag, valid, cached, unknown: unknown._tag };
      }).pipe(Effect.provide(accessJwtLayer(fetcher)));

      expect(outcomes).toEqual({
        unavailable: "AccessKeysUnavailable",
        valid: { email: "OWNER@example.test", expiresAt: 60000 },
        cached: { email: "OWNER@example.test", expiresAt: 60000 },
        unknown: "AccessAssertionRejected",
      });
      expect(fetched).toBe(3);
    }),
);

it.effect("discovers keys with a Workers redirect mode and refuses redirected key responses", () =>
  Effect.gen(function* () {
    // Mirrors workerd, which throws for any redirect mode other than follow or manual.
    const workers =
      (respond: () => Response): typeof fetch =>
      async (_input, init) => {
        if (init?.redirect !== undefined && !["follow", "manual"].includes(init.redirect))
          throw new TypeError("Invalid redirect value");

        return respond();
      };

    const token = yield* Effect.promise(() => sign(claims));

    const verify = (fetcher: typeof fetch) =>
      Effect.gen(function* () {
        const verifier = yield* AccessJwtVerifier;

        return yield* verifier.verify(request(token), issuer, audience);
      }).pipe(Effect.provide(accessJwtLayer(fetcher)));

    const valid = yield* verify(workers(() => Response.json({ keys: [publicJwk] })));

    const redirected = yield* verify(
      workers(
        () =>
          new Response(null, { status: 302, headers: { location: "https://attacker.example/" } }),
      ),
    ).pipe(Effect.flip);

    expect(valid).toEqual({ email: "OWNER@example.test", expiresAt: 60000 });
    expect(redirected._tag).toBe("AccessKeysUnavailable");
  }),
);

it.effect("bounds a hung key request and aborts its owned fetch at the deadline", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const aborted = yield* Deferred.make<void>();

    const fetcher: typeof fetch = (_input, init) =>
      new Promise<Response>(() => {
        Effect.runSync(Deferred.succeed(started, undefined));
        init?.signal?.addEventListener(
          "abort",
          () => Effect.runSync(Deferred.succeed(aborted, undefined)),
          { once: true },
        );
      });

    const token = yield* Effect.promise(() => sign(claims));

    const fiber = yield* Effect.gen(function* () {
      const verifier = yield* AccessJwtVerifier;

      return yield* verifier.verify(request(token), issuer, audience).pipe(Effect.flip);
    }).pipe(Effect.provide(accessJwtLayer(fetcher)), Effect.forkChild);

    yield* Deferred.await(started);
    yield* TestClock.adjust(5000);
    const denied = yield* Fiber.join(fiber);
    yield* Deferred.await(aborted);
    expect(denied._tag).toBe("AccessKeysUnavailable");
  }),
);

it.effect(
  "rechecks expiry after key discovery and denies an assertion expiring during discovery",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      const fetcher: typeof fetch = async () => {
        Effect.runSync(Deferred.succeed(started, undefined));
        await Effect.runPromise(Deferred.await(release));

        return Response.json({ keys: [publicJwk] });
      };

      const token = yield* Effect.promise(() => sign({ ...claims, exp: 1 }));

      const fiber = yield* Effect.gen(function* () {
        const verifier = yield* AccessJwtVerifier;

        return yield* verifier.verify(request(token), issuer, audience).pipe(Effect.flip);
      }).pipe(Effect.provide(accessJwtLayer(fetcher)), Effect.forkChild);

      yield* Deferred.await(started);
      yield* TestClock.adjust(1000);
      yield* Deferred.succeed(release, undefined);
      const denied = yield* Fiber.join(fiber);
      expect(denied._tag).toBe("AccessAssertionRejected");
    }),
);

it.effect(
  "legacy verifier callers receive undefined for invalid assertion without network access",
  () =>
    Effect.gen(function* () {
      let fetched = 0;

      const fetcher: typeof fetch = async () => {
        fetched++;

        return Response.json({ keys: [] });
      };

      const identity = yield* Effect.promise(() =>
        verifiedAccessIdentity(request("not-a-jwt"), issuer, audience, fetcher),
      );

      expect(identity).toBeUndefined();
      expect(fetched).toBe(0);
    }),
);
