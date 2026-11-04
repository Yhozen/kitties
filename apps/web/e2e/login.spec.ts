import { expect, test } from "@playwright/test";
import path from "node:path";
import { LOGIN_PAGE, SHOTS } from "./playwright.config";

// A gateway served on a network hands its token to nobody: the page asks for it, trades it for
// a session cookie and keeps only that. This runs against a second gateway (local_token: false).
const TOKEN = "login-e2e-token";

test("a gateway on a network asks for the token, keeps a session, and signs out", async ({
  page,
}) => {
  await page.goto(`${LOGIN_PAGE}/?theme=dark&motion=off`);
  const login = page.getByTestId("login");
  await expect(login).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(SHOTS, "30-sign-in.png"), animations: "disabled" });

  // Enter without a token sends nothing.
  await login.getByLabel("Token").press("Enter");
  await expect(login.getByTestId("missing")).toHaveText("Still needed: the token");
  await expect(login.getByRole("alert")).toHaveCount(0);

  // A wrong token is refused and says so; nothing is stored.
  await login.getByLabel("Token").fill("not-the-token");
  await login.getByRole("button", { name: "Sign in" }).click();
  await expect(login.getByRole("alert")).toContainText("not the gateway's token");
  expect(await page.evaluate(() => localStorage.getItem("kitties.gateway"))).toBeNull();

  // The right one opens the page (Enter works like the button), and the token is not kept by
  // the browser, only a cookie.
  await login.getByLabel("Token").fill(TOKEN);
  await login.getByLabel("Token").press("Enter");
  await expect(login).toBeHidden();
  await expect(
    page.locator("aside").getByRole("button", { name: "mimi", exact: true }),
  ).toBeAttached();
  expect(await page.evaluate(() => localStorage.getItem("kitties.gateway"))).toBeNull();
  const cookies = await page.context().cookies(LOGIN_PAGE);
  expect(cookies.find((c) => c.httpOnly && c.sameSite === "Strict")).toBeTruthy();

  // Reloading keeps the session; signing out asks again.
  await page.reload();
  await expect(
    page.locator("aside").getByRole("button", { name: "mimi", exact: true }),
  ).toBeAttached();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(login).toBeVisible();
  await page.reload();
  await expect(login).toBeVisible();
});
