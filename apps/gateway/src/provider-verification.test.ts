import { expect, test } from "vitest";
import { providerVerificationRequest } from "./providers.ts";

test("Anthropic verifies against /v1/models with its API key and version headers", () => {
  expect(providerVerificationRequest({ kind: "anthropic" }, "key")).toEqual({
    base: "https://api.anthropic.com",
    endpoint: "https://api.anthropic.com/v1/models",
    headers: { "x-api-key": "key", "anthropic-version": "2023-06-01" },
  });
  expect(
    providerVerificationRequest(
      { kind: "anthropic", baseUrl: "https://proxy.example/anthropic/" },
      "key",
    ).endpoint,
  ).toBe("https://proxy.example/anthropic/v1/models");
});

test.each([
  ["openai", "https://api.openai.com/v1/models"],
  ["openrouter", "https://openrouter.ai/api/v1/models"],
  ["gemini", "https://generativelanguage.googleapis.com/v1beta/openai/models"],
  ["compat", "https://api.groq.com/openai/v1/models"],
] as const)(
  "%s verification keeps its models endpoint and Bearer credentials",
  (kind, endpoint) => {
    expect(providerVerificationRequest({ kind }, "key")).toMatchObject({
      endpoint,
      headers: { Authorization: "Bearer key" },
    });
  },
);
