import { expect, test } from "vitest";
import { validGrant, canGrant, type Fence, type Grant } from "./control.ts";
const fence: Fence = { kittyId: "kitty-1", generation: 1, remoteId: "bx_123", epoch: 3 };
const grant: Grant = {
  ...fence,
  nonce: "nonce",
  clientId: "client",
  expiresAt: 200,
  lastInputAt: 0,
  draining: false,
};
test("control receipts fail closed for every fence and holder change", () => {
  expect(validGrant(grant, fence, "client", "nonce", 100)).toBe(true);
  for (const changed of [
    { ...fence, kittyId: "kitty-2" },
    { ...fence, generation: 2 },
    { ...fence, remoteId: "bx_456" },
    { ...fence, epoch: 4 },
  ])
    expect(validGrant(grant, changed, "client", "nonce", 100)).toBe(false);
  expect(validGrant(grant, fence, "other", "nonce", 100)).toBe(false);
  expect(validGrant(grant, fence, "client", "stale", 100)).toBe(false);
  expect(validGrant(grant, fence, "client", "nonce", 200)).toBe(false);
  expect(validGrant({ ...grant, draining: true }, fence, "client", "nonce", 100)).toBe(false);
});
test("a grant waits for agent dispatch and release keeps the existing grant until drained", () => {
  expect(canGrant(1, null, 100)).toBe(false);
  expect(canGrant(0, { ...grant, draining: true }, 100)).toBe(false);
  expect(canGrant(0, null, 100)).toBe(true);
});
