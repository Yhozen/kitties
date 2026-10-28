import { expect, test } from "@playwright/test";
import fs from "node:fs";
import { STATE } from "./playwright.config";

const ids = JSON.parse(fs.readFileSync(STATE, "utf8")) as { tom: string; desktop: string };

test("a cloud viewer survives readiness status changes and a slow first frame", async ({
  page,
}) => {
  let status = "running";
  let streams = 0;
  const fallbacks: string[] = [];
  await page.route("**/v1/kitties", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.kitties = body.kitties.map((kitty: { id: string }) =>
      kitty.id === ids.tom
        ? { ...kitty, status, computer: { runtime: "boat", id: "fixture" } }
        : kitty,
    );
    await route.fulfill({ json: body });
  });
  await page.route(`**/v1/kitties/${ids.tom}/rects*`, async (route) => {
    streams++;
    status = "starting";
    await new Promise((resolve) => setTimeout(resolve, 18_000));
    status = "running";
    await route.continue();
  });
  page.on("request", (request) => {
    if (/\/stream(?:\?|$)|\/screenshot\?live=/.test(request.url())) fallbacks.push(request.url());
  });
  await page.goto(`/?lang=en&motion=off#kitty/${ids.tom}`);
  const live = page.getByTestId("live-desktop");
  await expect(live).toBeVisible();
  await expect(live.getByTestId("live-state")).toHaveText("Connecting to the desktop…");
  await expect(live.getByTestId("take-control")).toBeDisabled();
  await expect(page.getByTestId("lifecycle-progress")).toContainText("Starting the computer", {
    timeout: 20_000,
  });
  await expect(live).toBeVisible();
  await expect(live.getByTestId("live-frame")).toBeVisible({ timeout: 20_000 });
  await expect(live.getByTestId("live-frame")).toHaveAttribute("data-mode", "rects");
  await expect(live.getByTestId("live-state")).toHaveText("Watching live");
  expect(streams).toBe(1);
  expect(fallbacks).toEqual([]);
  await page.route(`**/v1/kitties/${ids.tom}/stop`, (route) =>
    route.fulfill({ status: 202, json: { ok: true } }),
  );
  await page
    .getByTestId("kitty-actions")
    .getByRole("button", { name: "Stop", exact: true })
    .click();
  await expect(live).toHaveCount(0);
});

test("a failed desktop shows the server error and returns to live only after a valid frame", async ({
  page,
}) => {
  let available = false;
  const error = "Saved desktop is temporarily unavailable";
  await page.route("**/v1/kitties/*/rects*", (route) =>
    route.fulfill({ status: 503, json: { error } }),
  );
  await page.route("**/v1/kitties/*/stream*", (route) =>
    route.fulfill({ status: 503, json: { error } }),
  );
  await page.route("**/v1/kitties/*/screenshot?live=*", (route) =>
    available ? route.continue() : route.fulfill({ status: 503, json: { error } }),
  );
  await page.goto(`/?lang=en&motion=off#chat/${ids.desktop}`);
  await page.getByTestId("open-desktop").first().click();
  const live = page.getByTestId("live-desktop");
  await expect(live.getByTestId("live-error")).toHaveText(error);
  await expect(live.getByTestId("live-state")).toHaveText("The desktop did not answer");
  await expect(live.getByTestId("take-control")).toBeDisabled();
  available = true;
  await expect(live.getByTestId("live-frame")).toBeVisible();
  await expect(live.getByTestId("live-frame")).toHaveAttribute("data-mode", "poll");
  await expect(live.getByTestId("live-state")).toHaveText("Watching live");
  await expect(live.getByTestId("live-error")).toHaveCount(0);
  await expect(live.getByTestId("take-control")).toBeEnabled();
});

test("a Wails screenshot recovers after failure even when its pixels are unchanged", async ({
  page,
}) => {
  await page.route("**/v1/kitties/*/stream*", (route) =>
    route.fulfill({ status: 503, json: { error: "no stream" } }),
  );
  await page.goto(`/?lang=en&motion=off#chat/${ids.desktop}`);
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 24;
    canvas.getContext("2d")!.fillRect(0, 0, 32, 24);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.evaluate((base64) => {
    const bridge = window as unknown as { go: unknown; screenshotFails: boolean };
    bridge.screenshotFails = false;
    bridge.go = {
      main: {
        App: {
          Request: async (method: string, path: string, body: string) => {
            if (path.includes("/screenshot")) {
              return JSON.stringify(
                bridge.screenshotFails
                  ? { status: 503, body: "" }
                  : { status: 200, body: "", base64 },
              );
            }
            const response = await fetch(path, {
              method,
              ...(body ? { body, headers: { "Content-Type": "application/json" } } : {}),
            });
            return JSON.stringify({ status: response.status, body: await response.text() });
          },
        },
      },
    };
  }, base64);
  await page.getByTestId("open-desktop").first().click();
  const live = page.getByTestId("live-desktop");
  await expect(live.getByTestId("live-state")).toHaveText("Watching live");
  const first = await live.locator("img").getAttribute("src");
  expect(first).toMatch(/^data:image\/png;base64,/);
  await page.evaluate(() => {
    (window as unknown as { screenshotFails: boolean }).screenshotFails = true;
  });
  await expect(live.getByTestId("live-state")).toHaveText("The desktop did not answer");
  await expect(live.getByTestId("take-control")).toBeDisabled();
  await page.evaluate(() => {
    (window as unknown as { screenshotFails: boolean }).screenshotFails = false;
  });
  await expect(live.getByTestId("live-state")).toHaveText("Watching live");
  await expect(live.getByTestId("take-control")).toBeEnabled();
  await expect(live.locator("img")).toHaveAttribute("src", first!);
});

test("an old canvas decode cannot mark a replacement view live", async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as unknown as { releaseBitmap?: () => void; bitmapPending?: boolean };
    const decode = window.createImageBitmap.bind(window);
    let first = true;
    window.createImageBitmap = ((...args: unknown[]) => {
      const result = Reflect.apply(decode, window, args) as Promise<ImageBitmap>;
      if (!first) return result;
      first = false;
      return result.then(
        (picture) =>
          new Promise<ImageBitmap>((resolve) => {
            state.bitmapPending = true;
            state.releaseBitmap = () => resolve(picture);
          }),
      );
    }) as typeof window.createImageBitmap;
  });
  let streams = 0;
  await page.route(`**/v1/kitties/${ids.tom}/rects*`, (route) => {
    streams++;
    if (streams === 1) return route.continue();
  });
  await page.goto(`/?lang=en&motion=off#kitty/${ids.tom}`);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { bitmapPending?: boolean }).bitmapPending),
    )
    .toBe(true);
  await page.getByTestId("live-enlarge").click();
  await expect.poll(() => streams).toBe(2);
  await page.evaluate(async () => {
    (window as unknown as { releaseBitmap: () => void }).releaseBitmap();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  const live = page.getByTestId("live-desktop");
  await expect(live.getByTestId("live-state")).toHaveText("Connecting to the desktop…");
  await expect(live.getByTestId("take-control")).toBeDisabled();
  await expect(live.getByTestId("live-frame")).not.toBeVisible();
});

test("a cold desktop waits for lifecycle readiness beyond the viewer deadline", async ({
  page,
}) => {
  let status = "starting";
  const attempts: string[] = [];
  await page.clock.install();
  await page.route("**/v1/kitties", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.kitties = body.kitties.map((kitty: { id: string }) =>
      kitty.id === ids.tom
        ? { ...kitty, status, computer: { runtime: "boat", id: "cold-fixture" } }
        : kitty,
    );
    await route.fulfill({ json: body });
  });
  page.on("request", (request) => {
    if (/\/(rects|stream|screenshot)(?:\?|$)/.test(request.url())) attempts.push(request.url());
  });
  await page.goto(`/?lang=en&motion=off#kitty/${ids.tom}`);
  const live = page.getByTestId("live-desktop");
  await expect(live.getByTestId("live-state")).toHaveText("Starting the computer…");
  await page.clock.fastForward(35_000);
  await expect(live.getByTestId("live-state")).toHaveText("Starting the computer…");
  await expect(live.getByTestId("live-error")).toHaveCount(0);
  await expect(live.getByTestId("take-control")).toBeDisabled();
  expect(attempts).toEqual([]);
  status = "running";
  await page.clock.fastForward(5_000);
  await expect(live.getByTestId("live-state")).toHaveText("Watching live");
  await expect(live.getByTestId("live-frame")).toHaveAttribute("data-mode", "rects");
  expect(attempts).toHaveLength(1);
});
