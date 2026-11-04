import * as Schema from "effect/Schema";

const AccessHeader = Schema.Struct({
  alg: Schema.Literal("RS256"),
  kid: Schema.String.check(Schema.isMaxLength(256)),
});

const AccessClaims = Schema.Struct({
  iss: Schema.String,
  exp: Schema.Number,
  nbf: Schema.optional(Schema.Unknown),
  email: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.Json)]),
});

const AccessKeySet = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      kty: Schema.optional(Schema.String),
      kid: Schema.optional(Schema.String),
      alg: Schema.optional(Schema.String),
      use: Schema.optional(Schema.String),
      key_ops: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
      ext: Schema.optional(Schema.Boolean),
      n: Schema.optional(Schema.String),
      e: Schema.optional(Schema.String),
    }),
  ).check(Schema.isMaxLength(100)),
});

export type AccessIdentity = { email: string };

type KeySet = typeof AccessKeySet.Type;

const cached = new Map<string, { expires: number; value: Promise<KeySet> }>();

const bytes = (value: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error("INVALID_JWT");

  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
};

const decode = (value: string) => JSON.parse(new TextDecoder().decode(bytes(value)));

// ctx.access.getIdentity is not available on every deployed Access path. Verify
// the edge assertion against a pinned issuer and audience before trusting claims.
export async function verifiedAccessIdentity(
  request: Request,
  issuer: string,
  audience: string,
  fetcher: typeof fetch = fetch,
): Promise<AccessIdentity | undefined> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");

  if (!token || token.length > 32768 || !audience || !issuer.startsWith("https://")) return;
  const parts = token.split(".");

  if (parts.length !== 3) return;

  try {
    const header = Schema.decodeUnknownSync(AccessHeader)(decode(parts[0]!)),
      claims = Schema.decodeUnknownSync(AccessClaims)(decode(parts[1]!));

    const now = Date.now() / 1000;

    if (
      claims.iss !== issuer ||
      claims.exp <= now ||
      (Schema.is(Schema.Number)(claims.nbf) && claims.nbf > now) ||
      !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(audience)
    )
      return;

    const load = () => {
      const value = fetcher(issuer + "/cdn-cgi/access/certs").then(async (r) => {
        if (!r.ok) throw Error("ACCESS_KEYS_UNAVAILABLE");
        const value = Schema.decodeUnknownSync(AccessKeySet)(await r.json());

        return value;
      });

      cached.set(issuer, { expires: Date.now() + 300000, value });
      void value.catch(() => {
        if (cached.get(issuer)?.value === value) cached.delete(issuer);
      });

      return value;
    };

    const saved = cached.get(issuer);
    let set = await (saved && saved.expires > Date.now() ? saved.value : load());

    let jwk = set.keys.find(
      (k) => k.kid === header.kid && k.kty === "RSA" && (!k.alg || k.alg === "RS256"),
    );

    if (!jwk && saved) {
      set = await load();
      jwk = set.keys.find(
        (k) => k.kid === header.kid && k.kty === "RSA" && (!k.alg || k.alg === "RS256"),
      );
    }

    if (!jwk) return;

    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );

    if (
      !(await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        bytes(parts[2]!),
        new TextEncoder().encode(parts[0] + "." + parts[1]),
      ))
    )
      return;

    return { email: claims.email };
  } catch {
    return;
  }
}
