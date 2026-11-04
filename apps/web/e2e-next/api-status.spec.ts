import { expect, test } from "@playwright/test";

test("creating a kitty and conversation and sending a message accepts gateway success statuses", async ({
  page,
}) => {
  let kitty: Record<string, unknown> | undefined;
  let chat: Record<string, unknown> | undefined;
  let sent: Record<string, unknown> | undefined;
  await page.route("**/v1/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === "/v1/kitties" && request.method() === "POST") {
      kitty = { ...request.postDataJSON(), id: "kitty_one", createdAt: 1, status: "created" };
      return route.fulfill({ status: 201, json: kitty });
    }
    if (path === "/v1/chats" && request.method() === "POST") {
      chat = { ...request.postDataJSON(), id: "chat_one", createdAt: 1 };
      return route.fulfill({ status: 201, json: chat });
    }
    if (path === "/v1/chats/chat_one/messages") {
      sent = request.postDataJSON();
      return route.fulfill({ status: 202, json: { duplicate: false } });
    }
    if (path === "/v1/chats/chat_one/events")
      return route.fulfill({ contentType: "text/event-stream", body: ": connected\n\n" });
    if (path === "/v1/chats/chat_one" && request.method() === "DELETE") {
      chat = undefined;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({
      json:
        path === "/v1/health"
          ? { ok: true, version: "test", runtime: "boat", stage: "next" }
          : path === "/v1/features"
            ? { chatgpt: false }
            : path === "/v1/kitties"
              ? kitty
                ? [kitty]
                : []
              : path === "/v1/chats"
                ? chat
                  ? [chat]
                  : []
                : path === "/v1/chats/chat_one"
                  ? { ...chat, messages: [], cursor: 0 }
                  : [],
    });
  });
  await page.goto("/?lang=en");
  await page.getByRole("button", { name: "Create a puppy", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Companion");
  await page
    .locator(".next-form form")
    .getByRole("button", { name: "Create puppy", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "New conversation", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("First task");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("heading", { name: "First task", exact: true })).toBeVisible();
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Hello");
  await page.getByRole("button", { name: "Send ↑", exact: true }).click();
  await expect(composer).toHaveValue("");
  expect(sent).toMatchObject({ text: "Hello", kittyId: "kitty_one" });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Delete conversation", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "What shall we do today?", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
