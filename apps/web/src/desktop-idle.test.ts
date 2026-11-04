import { afterEach, expect, test, vi } from "vitest";
import { waitForDesktopIdle } from "./desktop-idle.ts";

afterEach(() => vi.useRealTimers());
test("sleep waits for viewer disconnect, grant release, pending receipts and file leases", async () => {
  vi.useFakeTimers();
  const channels = [
    { viewers: 1 }, { viewers: 0, grant: {} }, { viewers: 0, pending: 1 },
    { viewers: 0, fileTransfers: 1 }, { viewers: 0 },
  ];
  const read = vi.fn(async () => ({ channel: channels.shift()! }));
  const done = vi.fn();
  const waiting = waitForDesktopIdle(read, new AbortController().signal).then(done);
  await vi.advanceTimersByTimeAsync(1000);
  expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(250);
  await waiting;
  expect(done).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledTimes(5);
});

test("an occupied desktop times out and a closed panel cancels waiting", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => ({ channel: { viewers: 1 } }));
  const timeout = expect(waitForDesktopIdle(read, new AbortController().signal)).rejects.toThrow("DESKTOP_STILL_IN_USE");
  await vi.advanceTimersByTimeAsync(20000);
  await timeout;
  const controller = new AbortController();
  const aborted = expect(waitForDesktopIdle(read, controller.signal)).rejects.toThrow();
  controller.abort();
  await aborted;
  expect(vi.getTimerCount()).toBe(0);
});
