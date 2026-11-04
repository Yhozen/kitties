import { afterEach, expect, test, vi } from "vitest";
import { executeNative, nativeTools } from "./native-tools.ts";
import { needsApproval } from "./tools.ts";
import type { Connection } from "./entities.ts";
const connection: Connection = {
  id: "google",
  kind: "google",
  url: "https://www.googleapis.com",
  name: "Work",
  allowReads: true,
};
afterEach(() => vi.unstubAllGlobals());
test("native tools bind bearer tokens to their fixed API origin and keep writes behind approval", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const tools = nativeTools(connection),
    write = tools.find((tool) => tool.remoteName === "create_event")!;
  expect(needsApproval(connection, write, {})).toBe(true);
  expect(needsApproval(connection, tools[0]!, {})).toBe(false);
  await expect(
    executeNative({ ...connection, url: "https://evil.example.com" }, "private-token", tools[0]!, {
      id: "1",
      name: tools[0]!.name,
      params: {},
    }),
  ).rejects.toThrow();
  await expect(
    executeNative(connection, "private-token", write, {
      id: "2",
      name: write.name,
      params: {
        title: "Test",
        start: "2026-11-01T10:00:00Z",
        end: "2026-11-01T09:00:00Z",
        timezone: "UTC",
      },
    }),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
