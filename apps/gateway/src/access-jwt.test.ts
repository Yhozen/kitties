import { expect, test } from "vitest";
import { verifiedAccessIdentity } from "./access-jwt.ts";
test("Access fallback verifies signature, issuer, audience and expiry; email headers do not authenticate", async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const issuer = "https://identity.example",
    audience = "application-audience",
    kid = "rotation-key";
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid };
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return Response.json({ keys: [jwk] });
  }) as typeof fetch;
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const token = async (change: Record<string, unknown> = {}, algorithm = "RS256") => {
    const unsigned =
      encode({ alg: algorithm, kid }) +
      "." +
      encode({
        iss: issuer,
        aud: [audience],
        exp: Date.now() / 1000 + 60,
        email: "owner@example.org",
        ...change,
      });
    return (
      unsigned +
      "." +
      Buffer.from(
        await crypto.subtle.sign(
          "RSASSA-PKCS1-v1_5",
          pair.privateKey,
          new TextEncoder().encode(unsigned),
        ),
      ).toString("base64url")
    );
  };
  const request = (jwt: string) =>
    new Request("https://app.example/", { headers: { "Cf-Access-Jwt-Assertion": jwt } });
  const verify = (jwt: string) => verifiedAccessIdentity(request(jwt), issuer, audience, fetcher);
  expect(await verify(await token())).toEqual({ email: "owner@example.org" });
  expect(await verify(await token({ aud: ["wrong"] }))).toBeUndefined();
  expect(await verify(await token({ iss: "https://attacker.example" }))).toBeUndefined();
  expect(await verify(await token({ exp: 1 }))).toBeUndefined();
  expect(await verify(await token({ nbf: Date.now() / 1000 + 600 }))).toBeUndefined();
  expect(await verify(await token({}, "none"))).toBeUndefined();
  const valid = await token(),
    parts = valid.split(".");
  parts[1] = encode({
    iss: issuer,
    aud: [audience],
    exp: Date.now() / 1000 + 60,
    email: "attacker@example.org",
  });
  expect(await verify(parts.join("."))).toBeUndefined();
  expect(
    await verifiedAccessIdentity(
      new Request("https://app.example/", {
        headers: { "Cf-Access-Authenticated-User-Email": "owner@example.org" },
      }),
      issuer,
      audience,
      fetcher,
    ),
  ).toBeUndefined();
  expect(calls).toBe(1);
});
