import { expect, test } from "vitest";
import { validateConfig } from "./oauth-core.ts";
import { chatgptConfig, chatgptAccount } from "./chatgpt-config.ts";
test("only the retained exact Codex registration permits a loopback paste-back redirect", () => {
  expect(() => validateConfig(chatgptConfig)).not.toThrow();
  for (const config of [
    { ...chatgptConfig, clientId: "other" },
    { ...chatgptConfig, tokenEndpoint: "https://example.com/token" },
    { ...chatgptConfig, redirectUri: "http://localhost:1455/other" },
    { ...chatgptConfig, protectedUrl: "https://example.com" },
  ])
    expect(() => validateConfig(config)).toThrow();
});
test("account routing never accepts an invalid claim or includes a token in its error", () => {
  const token = `header.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } }))}.signature`;
  expect(chatgptAccount(token)).toBe("acct_123");
  expect(() => chatgptAccount("secret-invalid-token")).toThrow("CHATGPT_ACCOUNT_REQUIRED");
});
