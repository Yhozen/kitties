import { expect, test } from "@playwright/test";

test("PWA shell loads the derived API and advertises installable icons", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Puppies" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Tu espacio está listo.");
  const response = await request.get("/manifest.webmanifest");
  expect(response.ok()).toBeTruthy();
  const manifest = await response.json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/");
  for (const icon of manifest.icons) {
    const response = await request.get(icon.src);
    expect(response.ok()).toBeTruthy();
    expect(response.headers()["content-type"]).toContain("image/png");
  }
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (process.env.KITTIES_SCREENSHOT)
    await page.screenshot({ path: process.env.KITTIES_SCREENSHOT, fullPage: true });
});

test("offline navigation uses the cached public shell without caching owner API responses", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("Tu espacio está listo.");
  const cachedPaths = await page.evaluate(async () => {
    const names = await caches.keys();
    const paths: string[] = [];
    for (const name of names)
      for (const request of await (await caches.open(name)).keys())
        paths.push(new URL(request.url).pathname);
    return paths;
  });
  expect(cachedPaths).not.toContain("/v1/health");
  expect(cachedPaths).not.toContain("/v1/session");
  await context.setOffline(true);
  await page.goto("/");
  await expect(
    page.getByText("Sin conexión. Vuelve a abrir la app cuando tengas conexión."),
  ).toBeVisible();
});

test("Portuguese and English preferences apply to application panels", async ({ page }) => {
  await page.goto("/?lang=pt");
  await expect(page.locator("html")).toHaveAttribute("lang", "pt");
  await expect(page.locator(".next-caption[role=status]")).toHaveText("Seu espaço está pronto.");
  await page.getByRole("button", { name: "Configurações", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Modelos e conexões", exact: true }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator(".next-caption[role=status]")).toHaveText("Your space is ready.");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Models and connections", exact: true }),
  ).toBeVisible();
});
