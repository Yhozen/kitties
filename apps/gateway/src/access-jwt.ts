export type AccessIdentity = { email: string };
type KeySet = { keys: (JsonWebKey & { kid?: string; alg?: string })[] };
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
    const header = decode(parts[0]!),
      claims = decode(parts[1]!);
    const now = Date.now() / 1000;
    if (
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      header.kid.length > 256 ||
      claims.iss !== issuer ||
      typeof claims.exp !== "number" ||
      claims.exp <= now ||
      (typeof claims.nbf === "number" && claims.nbf > now) ||
      typeof claims.email !== "string" ||
      !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(audience)
    )
      return;
    const load = () => {
      const value = fetcher(issuer + "/cdn-cgi/access/certs").then(async (r) => {
        if (!r.ok) throw Error("ACCESS_KEYS_UNAVAILABLE");
        const value = (await r.json()) as KeySet;
        if (!Array.isArray(value.keys) || value.keys.length > 100)
          throw Error("ACCESS_KEYS_UNAVAILABLE");
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
