import { expect, test } from "@playwright/test";
import fs from "node:fs";
import { STATE } from "./playwright.config";

const ids = JSON.parse(fs.readFileSync(STATE, "utf8")) as { tom: string };

test("giving back controls discards queued input before a later grant", async ({ page }) => {
  let generation = 0;
  const sent: { control_id?: string; action: string }[] = [];
  let releaseFirst: (() => void) | undefined;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  await page.route(`**/v1/kitties/${ids.tom}/control`, (route) => {
    const body = route.request().postDataJSON();
    return route.fulfill({
      json: body.hold ? { held: true, control_id: `grant-${++generation}` } : { held: false },
    });
  });
  await page.route(`**/v1/kitties/${ids.tom}/input`, async (route) => {
    sent.push(route.request().postDataJSON());
    if (sent.length === 1) await first;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto(`/?lang=en&motion=off#kitty/${ids.tom}`);
  const live = page.getByTestId("live-desktop");
  await expect(live.getByTestId("take-control")).toBeEnabled();
  await live.getByTestId("take-control").click();
  await live.getByTestId("quick-keys").getByRole("button", { name: "Enter", exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("ArrowLeft");
  await live.getByRole("button", { name: /Give it back/ }).click();
  releaseFirst!();
  await expect(live.getByTestId("take-control")).toContainText("Take control");
  await page.waitForTimeout(200);
  expect(sent).toHaveLength(1);
  await live.getByTestId("take-control").click();
  await live.getByTestId("quick-keys").getByRole("button", { name: "Enter", exact: true }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent.map((item) => item.control_id)).toEqual(["grant-1", "grant-2"]);
});

for (const ending of ["unmount", "display failure"] as const) {
  test(`a late control grant is released after ${ending}`, async ({ page }) => {
    let available = true;
    let grantRequested = false;
    let grantReady!: () => void;
    const waitGrant = new Promise<void>((resolve) => {
      grantReady = resolve;
    });
    const released: string[] = [];
    await page.route("**/v1/kitties/*/rects*", (route) => route.fulfill({ status: 503 }));
    await page.route("**/v1/kitties/*/stream*", (route) => route.fulfill({ status: 503 }));
    await page.route("**/v1/kitties/*/screenshot?live=*", (route) =>
      available ? route.continue() : route.fulfill({ status: 503 }),
    );
    await page.route(`**/v1/kitties/${ids.tom}/control`, async (route) => {
      const body = route.request().postDataJSON();
      if (body.hold) {
        grantRequested = true;
        await waitGrant;
        await route.fulfill({ json: { held: true, control_id: "late-grant" } });
      } else {
        released.push(body.control_id);
        await route.fulfill({ json: { held: false } });
      }
    });
    await page.goto(`/?lang=en&motion=off#kitty/${ids.tom}`);
    const live = page.getByTestId("live-desktop");
    await live.getByTestId("take-control").click();
    await expect.poll(() => grantRequested).toBe(true);
    if (ending === "unmount") {
      await page.getByRole("button", { name: "Close desktop view", exact: true }).click();
      await expect(live).toHaveCount(0);
    } else {
      available = false;
      await expect(live.getByTestId("live-state")).toHaveText("The desktop did not answer");
    }
    grantReady();
    await expect.poll(() => released).toEqual(["late-grant"]);
    await expect(page.getByTestId("give-back")).toHaveCount(0);
  });
}

test("a failed input discards its queue without retry or a success indicator", async ({ page }) => {
  await page.route(`**/v1/kitties/${ids.tom}/control`, (route) =>
    route.fulfill({
      json: route.request().postDataJSON().hold
        ? { held: true, control_id: "queue-fixture" }
        : { held: false },
    }),
  );
  let fail!: () => void;
  const failure = new Promise<void>((resolve) => {
    fail = resolve;
  });
  const sent: unknown[] = [];
  await page.route(`**/v1/kitties/${ids.tom}/input`, async (route) => {
    sent.push(route.request().postDataJSON());
    await failure;
    await route.fulfill({
      status: 409,
      json: { error: "take control again before sending input" },
    });
  });
  await page.goto(`/?lang=en&motion=off#kitty/${ids.tom}`);
  const live = page.getByTestId("live-desktop");
  await live.getByTestId("take-control").click();
  await live.getByTestId("quick-keys").getByRole("button", { name: "Enter", exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  await page.keyboard.press("Backspace");
  fail();
  await expect(live.getByTestId("take-control")).toBeVisible();
  await expect(live).toContainText("take control again before sending input");
  await expect(live.getByTestId("live-activity")).toHaveCount(0);
  expect(sent).toHaveLength(1);
});

test("byte backpressure keeps a following Enter behind unsent text", async ({ page }) => {
  await page.route(`**/v1/kitties/${ids.tom}/control`, (route) =>
    route.fulfill({
      json: route.request().postDataJSON().hold
        ? { held: true, control_id: "queue-fixture" }
        : { held: false },
    }),
  );
  let finish!: () => void;
  const first = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const sent: { action: string; args: Record<string, unknown> }[] = [];
  await page.route(`**/v1/kitties/${ids.tom}/input`, async (route) => {
    sent.push(route.request().postDataJSON());
    if (sent.length === 1) await first;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto(`/?lang=en&motion=off#kitty/${ids.tom}`);
  const live = page.getByTestId("live-desktop");
  await live.getByTestId("take-control").click();
  await expect(live.getByTestId("give-back")).toBeVisible();
  await live.locator(".live-surface").evaluate((surface) => {
    for (let i = 0; i < 8; i++) {
      const data = new DataTransfer();
      data.setData("text", "a".repeat(1900));
      surface.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: data }));
    }
    for (let i = 0; i < 1900; i++)
      surface.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true }));
    surface.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await expect(live).toContainText("Too many inputs are waiting. Wait for them to finish.");
  await live.getByTestId("quick-keys").getByRole("button", { name: "Enter", exact: true }).click();
  finish();
  await expect.poll(() => sent.length).toBe(8);
  expect(
    sent.every((input) => input.action === "type" && input.args.text === "a".repeat(1900)),
  ).toBe(true);
  await live.getByTestId("quick-keys").getByRole("button", { name: "Enter", exact: true }).click();
  await expect.poll(() => sent.length).toBe(10);
  expect(sent[8]).toMatchObject({ action: "type", args: { text: "b".repeat(1900) } });
  expect(sent[9]).toMatchObject({ action: "key", args: { keys: "Return" } });
});

test("changing kitty releases the old viewer and clears unsent input", async ({ page }) => {
  const state = JSON.parse(fs.readFileSync(STATE, "utf8")) as { tom: string; mimi: string };
  const released: string[] = [];
  const sent: string[] = [];
  await page.route("**/v1/kitties", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.kitties = body.kitties.map((kitty: { id: string }) =>
      kitty.id === state.mimi ? { ...kitty, desktop: true, status: "running" } : kitty,
    );
    await route.fulfill({ json: body });
  });
  await page.route("**/v1/kitties/*/control", (route) => {
    const body = route.request().postDataJSON();
    const id = route.request().url().split("/").at(-2)!;
    if (!body.hold) released.push(body.control_id);
    return route.fulfill({ json: body.hold ? { held: true, control_id: id } : { held: false } });
  });
  await page.route("**/v1/kitties/*/input", (route) => {
    sent.push(route.request().postDataJSON().control_id);
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(`/?lang=en&motion=off#kitty/${state.tom}`);
  const live = page.getByTestId("live-desktop");
  await live.getByTestId("take-control").click();
  await expect(live.getByTestId("give-back")).toBeVisible();
  await live.locator(".live-surface").evaluate((surface, id) => {
    surface.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
    location.hash = `kitty/${id}`;
  }, state.mimi);
  await expect.poll(() => released).toEqual([state.tom]);
  await expect(live.getByTestId("take-control")).toBeEnabled();
  await expect(live.getByTestId("give-back")).toHaveCount(0);
  await live.getByTestId("take-control").click();
  await live.getByTestId("quick-keys").getByRole("button", { name: "Enter", exact: true }).click();
  await expect.poll(() => sent).toEqual([state.mimi]);
});

test("Wails input stays bounded and a closed viewer never dispatches its backlog", async ({
  page,
}) => {
  await page.goto("/?lang=en&motion=off");
  await expect(page.getByRole("button", { name: "tom", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const state = window as unknown as {
      go: unknown;
      runtime: unknown;
      streamError?: (data: unknown) => void;
      rejectWatch?: (reason: Error) => void;
    };
    state.runtime = {
      EventsOn: (_name: string, callback: (data: unknown) => void) => {
        state.streamError = callback;
        return () => {
          state.streamError = undefined;
        };
      },
    };
    state.go = {
      main: {
        App: {
          WatchDesktop: () =>
            new Promise<void>((_resolve, reject) => {
              state.rejectWatch = reject;
            }),
          UnwatchDesktop: async () => undefined,
          Gateway: async () => ({ url: location.origin, token: "e2e-token" }),
          GatewayNote: async () => "",
          Request: async (method: string, path: string, body: string) => {
            const response = await fetch(path, {
              method,
              headers: { Authorization: "Bearer e2e-token", "Content-Type": "application/json" },
              ...(body ? { body } : {}),
            });
            if (path.includes("/screenshot")) {
              const bytes = new Uint8Array(await response.arrayBuffer());
              return JSON.stringify({
                status: response.status,
                body: "",
                base64: btoa(String.fromCharCode(...bytes)),
              });
            }
            return JSON.stringify({ status: response.status, body: await response.text() });
          },
        },
      },
    };
  });
  await page.route("**/v1/kitties/*/stream*", (route) => route.fulfill({ status: 503 }));
  let finish!: () => void;
  const first = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const sent: unknown[] = [];
  let released = false;
  await page.route(`**/v1/kitties/${ids.tom}/control`, async (route) => {
    const body = route.request().postDataJSON();
    if (!body.hold) released = true;
    return route.fulfill({
      json: body.hold ? { held: true, control_id: "wails-grant" } : { held: false },
    });
  });
  await page.route(`**/v1/kitties/${ids.tom}/input`, async (route) => {
    sent.push(route.request().postDataJSON());
    await first;
    await route.fulfill({ json: { ok: true } });
  });
  await page.evaluate((id) => {
    location.hash = `kitty/${id}`;
  }, ids.tom);
  await expect
    .poll(() => page.evaluate(() => !!(window as unknown as { streamError?: unknown }).streamError))
    .toBe(true);
  await page.evaluate(() =>
    (window as unknown as { streamError: (data: unknown) => void }).streamError({
      error: "fallback to polling",
    }),
  );
  const live = page.getByTestId("live-desktop");
  await live.getByTestId("take-control").click();
  await expect(live.getByTestId("give-back")).toBeVisible();
  await page.evaluate(async () => {
    (window as unknown as { rejectWatch: (reason: Error) => void }).rejectWatch(
      new Error("old WatchDesktop failure"),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect(live.getByTestId("give-back")).toBeVisible();
  expect(released).toBe(false);
  await live.locator(".live-surface").evaluate((surface) => {
    for (let i = 0; i < 33; i++)
      surface.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await expect(live).toContainText("Too many inputs are waiting. Wait for them to finish.");
  await expect.poll(() => sent.length).toBe(1);
  await page.getByRole("button", { name: "Close desktop view", exact: true }).click();
  await expect.poll(() => released).toBe(true);
  finish();
  await expect(live).toHaveCount(0);
  await page.getByRole("button", { name: "Open desktop", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => !!(window as unknown as { streamError?: unknown }).streamError))
    .toBe(true);
  await page.evaluate(() =>
    (window as unknown as { streamError: (data: unknown) => void }).streamError({
      error: "fallback to polling",
    }),
  );
  await expect(live.getByTestId("take-control")).toBeEnabled();
  expect(sent).toHaveLength(1);
});
