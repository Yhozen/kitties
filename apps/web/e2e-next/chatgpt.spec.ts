import { expect, test } from "@playwright/test";

const account = {
  id: "account_one",
  label: "Owner · workspace",
  clientId: "oaiapp_workspace",
  issuer: "https://auth.openai.com",
  subject: "owner",
  hostId: "urn:uuid:test",
  status: "connected",
  updatedAt: 1,
};
test.beforeEach(async ({ page }) => {
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body =
      path === "/v1/health"
        ? { ok: true, version: "test" }
        : path === "/v1/features"
          ? { chatgpt: false }
          : path === "/v1/chatgpt/accounts"
            ? [account]
            : path === "/v1/chatgpt/accounts/account_one/probe"
              ? {
                  ok: false,
                  error: {
                    reason: "usage_limit",
                    code: "subscription_sharing_usage_limit_exceeded",
                    requestId: "req_limit",
                  },
                }
              : path === "/v1/chatgpt/accounts/account_one"
                ? { revocationConfirmed: false }
                : path === "/v1/notifications"
                  ? { settings: { enabled: false, events: [] }, subscriptions: 0, batches: [] }
                  : [];
    await route.fulfill({ json: body });
  });
});
test("disabled inference still offers helper-based account linking, verification and usage recovery", async ({
  page,
}) => {
  await page.goto("/?panel=settings&lang=en");
  await expect(page.getByRole("heading", { name: "Use your ChatGPT plan" })).toBeVisible();
  await expect(page.getByText("pnpm chatgpt:connect --stage prod")).toBeVisible();
  await expect(page.getByText("Owner · workspace")).toBeVisible();
  await expect(page.getByLabel("Callback address")).toHaveCount(0);
  await page.getByRole("button", { name: "Verify connection", exact: true }).click();
  await expect(
    page.getByText(/usage_limit: subscription_sharing_usage_limit_exceeded/),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Manage usage" })).toHaveAttribute(
    "href",
    "https://chatgpt.com/settings/usage",
  );
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByText(/Remote revocation was not confirmed/)).toBeVisible();
  const secrets = await page.evaluate(() =>
    JSON.stringify({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
    }),
  );
  expect(secrets).not.toContain("token");
});
test("helper landing starts an authenticated attempt and redirects through the server", async ({
  page,
}) => {
  await page.route("**/v1/chatgpt/link-attempts", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({
      redirectUri: "http://127.0.0.1:45678/auth/callback",
    });
    await route.fulfill({
      status: 201,
      json: {
        id: "attempt_one",
        accountId: "account_two",
        status: "pending",
        expiresAt: Date.now() + 600000,
      },
    });
  });
  await page.route("**/v1/chatgpt/link-attempts/attempt_one/authorize", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "Authorization redirect" }),
  );
  await page.goto(
    "/?panel=settings&lang=en&chatgptCallback=" +
      encodeURIComponent("http://127.0.0.1:45678/auth/callback"),
  );
  await page.getByRole("button", { name: "Continue with ChatGPT", exact: true }).click();
  await expect(page).toHaveURL(/\/v1\/chatgpt\/link-attempts\/attempt_one\/authorize$/);
});
test("a completed helper callback verifies Responses and shows the sanitized failure", async ({
  page,
}) => {
  await page.goto("/?panel=settings&lang=en&chatgptProbe=account_one");
  await expect(page.getByText(/req_limit/)).toBeVisible();
  await expect(page).not.toHaveURL(/chatgptProbe/);
});
