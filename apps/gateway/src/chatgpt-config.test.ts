import { expect, test } from "vitest";
import { validateConfig } from "./oauth-core.ts";
import { chatgptConfig, loopbackRedirect } from "./chatgpt-config.ts";
test("subscription callbacks accept only the exact numeric loopback host and fixed path", () => {
  expect(loopbackRedirect("http://127.0.0.1:45678/auth/callback")).toBe(
    "http://127.0.0.1:45678/auth/callback",
  );
  for (const uri of [
    "http://localhost:1455/auth/callback",
    "https://127.0.0.1:1455/auth/callback",
    "http://127.0.0.1/auth/callback",
    "http://127.0.0.1:1455/other",
    "http://127.0.0.1:1455/auth/callback?code=secret",
    "http://127.0.0.1:1455/auth/callback#fragment",
    "http://user@127.0.0.1:1455/auth/callback",
    "https://evil.example/auth/callback",
  ])
    expect(() => loopbackRedirect(uri)).toThrow();
});
test("generic OAuth no longer permits the legacy Codex loopback exception", () => {
  expect(() =>
    validateConfig({ ...chatgptConfig, redirectUri: "http://localhost:1455/auth/callback" }),
  ).toThrow();
});
