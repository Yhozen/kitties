import { expect, test } from "vitest";
import { FakeKittyd } from "./kittyd.ts";
test("a lost acknowledgment can reconcile a completed effect without dispatching it again", () => {
  const guest = new FakeKittyd();
  const intent = { id: "click-1", generation: 1, epoch: 1, deadline: Date.now() + 10000 };
  guest.dispatch(intent);
  // The actor lost the response; another actor reads the guest's receipt.
  expect(guest.reconcile(intent.id)?.status).toBe("completed");
  expect(guest.dispatch(intent).status).toBe("completed");
  expect(guest.effects).toEqual(["click-1"]);
});
test("a guest crash inside a side effect leaves an unknown outcome and never repeats it", () => {
  const guest = new FakeKittyd();
  const intent = { id: "click-2", generation: 1, epoch: 1, deadline: Date.now() + 10000 };
  expect(() => guest.dispatch(intent, true)).toThrow("CONNECTION_LOST");
  const restarted = new FakeKittyd(guest.disk);
  expect(restarted.dispatch(intent).status).toBe("unknown");
  expect(restarted.effects).toEqual([]);
});
