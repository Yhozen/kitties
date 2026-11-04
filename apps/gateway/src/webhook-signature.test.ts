import { it, expect } from "vitest";
import { verifyWebhook } from "./webhook-signature";
const secret = "a-test-secret-that-is-long";
async function sign(body: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
it("authenticates exact GitHub bytes and requires a delivery ID", async () => {
  const body = '{"action":"test"}',
    signature = await sign(body),
    headers = { "x-github-delivery": "delivery-1", "x-hub-signature-256": "sha256=" + signature };
  expect(await verifyWebhook("github", secret, headers, body)).toBe("delivery-1");
  expect(await verifyWebhook("github", secret, headers, body + " ")).toBeNull();
  expect(
    await verifyWebhook("github", secret, { "x-hub-signature-256": signature }, body),
  ).toBeNull();
});
it("rejects expired generic timestamps and supports Stripe key rotation", async () => {
  const timestamp = "1793552400",
    now = Number(timestamp) * 1000,
    body = '{"id":"evt_abc"}',
    signature = await sign(timestamp + "." + body);
  expect(
    await verifyWebhook(
      "generic",
      secret,
      {
        "x-kitties-delivery": "one",
        "x-kitties-timestamp": timestamp,
        "x-kitties-signature": signature,
      },
      body,
      now + 300001,
    ),
  ).toBeNull();
  expect(
    await verifyWebhook(
      "stripe",
      secret,
      { "stripe-signature": `t=${timestamp},v1=${"0".repeat(64)},v1=${signature}` },
      body,
      now,
    ),
  ).toBe("evt_abc");
});
