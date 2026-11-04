import { expect, test } from "@playwright/test";

test("the protected manifest receives the Access session cookie", async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([
    {
      name: "CF_Authorization",
      value: "test-access-session",
      url: baseURL!,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  let manifestCookie: string | null = null;
  await page.route("**/manifest.webmanifest", async (route) => {
    manifestCookie = await route.request().headerValue("cookie");
    if (manifestCookie?.includes("CF_Authorization=test-access-session")) {
      await route.continue();
    } else {
      await route.fulfill({ status: 403, body: "Access session required" });
    }
  });
  await page.goto("/");
  const client = await context.newCDPSession(page);
  const manifest = await client.send("Page.getAppManifest");
  expect(manifestCookie).toContain("CF_Authorization=test-access-session");
  expect(manifest.errors).toEqual([]);
  expect(JSON.parse(manifest.data!)).toMatchObject({ name: "Kitties", start_url: "/" });
});
