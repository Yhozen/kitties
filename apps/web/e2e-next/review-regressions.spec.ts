import { expect, test, type Page } from "@playwright/test";

interface Source {
  url: string;
  closed: boolean;
  emit: (body: object, seq: number) => void;
}
interface Socket {
  url: string;
  readyState: number;
  sent: string[];
  emit: (body: object) => void;
}
type TestWindow = Window & { testSources: Source[]; testSockets: Socket[] };
const kitty = {
  id: "cat",
  name: "Luna",
  soul: "help",
  breed: "sitting",
  color: "mint",
  createdAt: 1,
  status: "ready",
};
const thread = (id: string) => ({ id, title: `Thread ${id}`, members: ["cat"], createdAt: 1 });
const message = (id: string, answer = "partial") => ({
  id,
  payload: { chatId: "one", messageId: id, kittyId: "cat", text: `Question ${id}` },
  status: "running",
  answer,
  at: 1,
  run_id: null,
  revision: { round: 0, attempt: 2 },
});

async function setup(page: Page) {
  await page.addInitScript(() => {
    const sources: Source[] = [],
      sockets: Socket[] = [];
    Object.assign(window, { testSources: sources, testSockets: sockets });
    class FakeSource {
      closed = false;
      onmessage?: (event: { data: string; lastEventId: string }) => void;
      constructor(public url: string) {
        sources.push(this);
      }
      emit(body: object, seq: number) {
        this.onmessage?.({ data: JSON.stringify(body), lastEventId: String(seq) });
      }
      close() {
        this.closed = true;
      }
    }
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      sent: string[] = [];
      onmessage?: (event: { data: string }) => void;
      onclose?: (event: { code: number }) => void;
      constructor(public url: string) {
        sockets.push(this);
      }
      emit(body: object) {
        this.onmessage?.({ data: JSON.stringify(body) });
      }
      send(body: string) {
        this.sent.push(body);
      }
      close() {
        this.readyState = 3;
        this.onclose?.({ code: 1000 });
      }
    }
    Object.assign(window, { EventSource: FakeSource, WebSocket: FakeSocket });
  });
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body =
      path === "/v1/health"
        ? { ok: true, version: "test", runtime: "boat", stage: "local" }
        : path === "/v1/features"
          ? { chatgpt: false }
          : path === "/v1/kitties"
            ? [kitty]
            : path === "/v1/chats"
              ? [thread("one"), thread("two")]
              : path === "/v1/providers"
                ? []
                : undefined;
    if (body === undefined) return route.fulfill({ status: 404 });
    return route.fulfill({ json: body });
  });
}

test("opening a running snapshot streams later deltas and ignores stale round and source events", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/v1/chats/one", (route) =>
    route.fulfill({
      json: { ...thread("one"), messages: [message("m")], cursor: 10, hasMore: false },
    }),
  );
  await page.route("**/v1/chats/two", (route) =>
    route.fulfill({
      json: {
        ...thread("two"),
        messages: [message("m", "other chat")],
        cursor: 20,
        hasMore: false,
      },
    }),
  );
  await page.goto("/?lang=en");
  await page.getByRole("button", { name: "Thread one", exact: true }).click();
  await expect(page.locator(".next-answer p")).toHaveText("partial");
  await page.evaluate(() => {
    const source = (window as unknown as TestWindow).testSources[0]!;
    source.emit({ type: "delta", messageId: "m", round: 0, attempt: 2, text: " continued" }, 11);
    source.emit({ type: "delta", messageId: "m", round: 0, attempt: 2, text: " duplicate" }, 11);
    source.emit(
      { type: "round_reset", messageId: "m", round: 1, attempt: 1, prefix: "partial continued" },
      12,
    );
    source.emit({ type: "delta", messageId: "m", round: 0, attempt: 1, text: " stale" }, 13);
    source.emit({ type: "delta", messageId: "m", round: 1, attempt: 1, text: " / round two" }, 14);
  });
  await expect(page.locator(".next-answer p")).toHaveText("partial continued / round two");
  await page.getByRole("button", { name: "Thread two", exact: true }).click();
  await expect(page.locator(".next-answer p")).toHaveText("other chat");
  expect(await page.evaluate(() => (window as unknown as TestWindow).testSources[0]!.closed)).toBe(
    true,
  );
  await page.evaluate(() =>
    (window as unknown as TestWindow).testSources[0]!.emit(
      { type: "delta", messageId: "m", round: 0, attempt: 2, text: " wrong chat" },
      15,
    ),
  );
  await expect(page.locator(".next-answer p")).toHaveText("other chat");
});

test("loading earlier messages preserves live text that arrives during pagination", async ({
  page,
}) => {
  await setup(page);
  let finishPage!: () => void;
  await page.route("**/v1/chats/one*", async (route) => {
    if (new URL(route.request().url()).searchParams.has("before")) {
      await new Promise<void>((resolve) => {
        finishPage = resolve;
      });
      return route.fulfill({
        json: {
          ...thread("one"),
          messages: [message("old", "old answer")],
          cursor: 99,
          hasMore: false,
        },
      });
    }
    return route.fulfill({
      json: { ...thread("one"), messages: [message("recent")], cursor: 10, hasMore: true },
    });
  });
  await page.goto("/?lang=en");
  await page.getByRole("button", { name: "Thread one", exact: true }).click();
  await page.getByRole("button", { name: "Load earlier messages" }).click();
  await expect.poll(() => !!finishPage).toBe(true);
  await page.evaluate(() =>
    (window as unknown as TestWindow).testSources[0]!.emit(
      { type: "delta", messageId: "recent", round: 0, attempt: 2, text: " live" },
      11,
    ),
  );
  finishPage();
  await expect(page.locator(".next-answer p")).toHaveText(["old answer", "partial live"]);
  await expect(page.getByRole("button", { name: "Load earlier messages" })).toHaveCount(0);
});

test("Sleep closes both viewer sockets, releases control and drops queued input before waiting for leases", async ({
  page,
}) => {
  await setup(page);
  let checks = 0,
    slept = false;
  await page.route("**/v1/kitties/cat/computer**", async (route) => {
    if (route.request().method() === "POST") {
      const peers = await page.evaluate(() =>
        (window as unknown as TestWindow).testSockets
          .filter((s) => s.url.includes("/desktop/"))
          .map((s) => ({ readyState: s.readyState, sent: s.sent })),
      );
      expect(peers).toHaveLength(2);
      expect(peers.every((s) => s.readyState === 3)).toBe(true);
      expect(peers[0]!.sent.filter((s) => s.includes('"type":"input"'))).toHaveLength(1);
      expect(peers[0]!.sent.some((s) => s.includes('"type":"release"'))).toBe(true);
      expect(checks).toBeGreaterThanOrEqual(5);
      slept = true;
      return route.fulfill({ status: 202, json: { executionId: "run" } });
    }
    const channel = [
      { viewers: 2, grant: {} },
      { viewers: 1, grant: {} },
      { viewers: 0, grant: {} },
      { viewers: 0, pending: 1 },
      { viewers: 0, fileTransfers: 1 },
      { viewers: 0 },
    ][Math.min(checks++, 5)];
    return route.fulfill({
      json: {
        state: { phase: slept ? "sleeping" : "ready", generation: 1 },
        channel: { guestConnected: !slept, ...channel },
      },
    });
  });
  await page.goto("/?lang=en");
  await page.getByRole("button", { name: "Abrir escritorio de Luna" }).click();
  await expect(page.locator(".ws-desktop canvas")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as TestWindow).testSockets.some((s) => s.url.endsWith("/control")),
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    const control = (window as unknown as TestWindow).testSockets.find((s) =>
      s.url.endsWith("/control"),
    )!;
    control.emit({ type: "connected", generation: 1, epoch: 1 });
    control.emit({ type: "grant", receipt: { nonce: "nonce", generation: 1, epoch: 1 } });
  });
  await expect(page.getByRole("button", { name: "Devolver control" })).toBeVisible();
  await page.locator(".ws-desktop canvas").press("a");
  await page.locator(".ws-desktop canvas").press("b");
  await page.getByRole("button", { name: "Sleep and save" }).click();
  await expect(page.locator(".ws-desktop")).toHaveCount(0);
  await expect.poll(() => slept).toBe(true);
  // Cross the viewer reconnect delay; cleanup must have canceled it.
  await page.waitForTimeout(1600);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as TestWindow).testSockets.filter((s) => s.url.includes("/desktop/"))
          .length,
    ),
  ).toBe(2);
});
