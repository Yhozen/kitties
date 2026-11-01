import { expect, test } from "vitest";
import { open, seal } from "./secrets.ts";
import { publicHttps } from "./outbound.ts";

test("secret envelopes authenticate their row and purpose, with fresh nonces", async () => {
  const kek = "ab".repeat(32),
    aad = "providers:p1:api-key";
  const first = await seal(kek, aad, "secret-value"),
    second = await seal(kek, aad, "secret-value");
  expect(first.iv).not.toBe(second.iv);
  expect(JSON.stringify(first)).not.toContain("secret-value");
  expect(await open(kek, aad, first)).toBe("secret-value");
  await expect(open(kek, "providers:p2:api-key", first)).rejects.toThrow();
  await expect(open("cd".repeat(32), aad, first)).rejects.toThrow();
});
test("outbound URLs reject local, numeric, credential-bearing and non-TLS destinations", () => {
  for (const url of [
    "http://example.com",
    "https://127.0.0.1",
    "https://2130706433",
    "https://0x7f000001",
    "https://[::1]",
    "https://thing.local",
    "https://me:secret@example.com",
    "https://localhost",
  ])
    expect(() => publicHttps(url)).toThrow();
  expect(publicHttps("https://api.openai.com/v1").hostname).toBe("api.openai.com");
});
