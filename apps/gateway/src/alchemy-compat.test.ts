import { createHash } from "node:crypto";
import { makeOAuthClient } from "alchemy/Auth/OAuthFlow";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import { expect, test } from "vitest";

test("Alchemy produces fresh OAuth state and an RFC 7636 S256 challenge on Effect 4.1", async () => {
  const client = makeOAuthClient({
    clientId: "test-client",
    endpoints: {
      authorize: "https://issuer.example/authorize",
      token: "https://issuer.example/token",
    },
    redirectUri: "https://app.example/callback",
    localCallbackUri: "http://localhost:1455/callback",
    auth: { kind: "pkce" },
  });
  const authorize = () =>
    Effect.runPromise(client.authorize().pipe(Effect.provide(PlatformServices)));
  const first = await authorize();
  const second = await authorize();
  const url = new URL(first.url);
  expect(first.state).not.toEqual(second.state);
  expect(first.verifier).not.toEqual(second.verifier);
  expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  expect(url.searchParams.get("state")).toBe(first.state);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toBe(
    createHash("sha256").update(first.verifier!).digest("base64url"),
  );
});
