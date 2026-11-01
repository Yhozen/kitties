import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { GATEWAY, HOOK_LOG, SHOTS, STATE } from "./playwright.config";

// Every screen of the desktop app, checked and photographed. The pictures go to
// docs/screenshots under the names the docs use, so the documentation is never stale.
const ids = JSON.parse(fs.readFileSync(STATE, "utf8")) as {
  single: string;
  group: string;
  desktop: string;
  post: string;
  tom: string;
  mimi: string;
  delegated: string;
};
const Q = "?theme=dark&motion=off";

test.beforeAll(() => fs.mkdirSync(SHOTS, { recursive: true }));

// kittyRow is a kitty's row in the sidebar (its hit button carries the name).
// A chat with one kitty is titled after it, so the kitty row is the last button of that name.
const kittyRow = (page: Page, name: string) =>
  page.locator("aside").getByRole("button", { name, exact: true }).last();

async function open(page: Page, hash: string, query = Q): Promise<void> {
  await page.goto(`/${query}${hash}`);
  await expect(kittyRow(page, "mimi")).toBeAttached();
}

async function shot(page: Page, name: string): Promise<void> {
  // The pixel cats breathe and the panels fade in: motion=off stills them; fonts land first.
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), animations: "disabled" });
}

test("the empty state lists the kitties", async ({ page }) => {
  await open(page, "");
  for (const name of ["mimi", "tom", "luna"]) {
    await expect(kittyRow(page, name)).toBeAttached();
  }
  await expect(page.getByText("connected")).toBeVisible();
  await shot(page, "01-empty");
});

test("a chat with one kitty: the answer, the skill and the saved artifact", async ({ page }) => {
  await open(page, `#chat/${ids.single}`);
  await expect(page.getByText("Here is how I would split it")).toBeVisible();
  await expect(page.getByText("skill · report-findings")).toBeVisible();
  await expect(page.getByText("launch-plan.md").first()).toBeVisible();
  await shot(page, "02-chat");
});

test("a group chat shows every member", async ({ page }) => {
  await open(page, `#chat/${ids.group}`);
  await expect(page.getByText("Launch team").first()).toBeVisible();
  await expect(page.getByText("I agree with the point above").first()).toBeVisible();
  await shot(page, "03-group");
});

test("a desktop task: the steps and their screenshots", async ({ page }) => {
  await open(page, `#chat/${ids.desktop}`);
  const trail = page.locator(".trail").first();
  // Each step reads as a sentence; the coordinates and the tokens are only on hover.
  await expect(trail.getByText("Opened example.com", { exact: true })).toBeVisible();
  await expect(trail.getByText("Clicked on the screen", { exact: true })).toBeVisible();
  await expect(trail.getByText("Finished", { exact: true })).toBeVisible();
  await expect(trail).not.toContainText("640, 420");
  await expect(page.locator(".msg .meta").first()).not.toContainText("tokens");
  await expect(page.locator(".desk-hero .shot-thumb img")).toBeVisible();
  await expect(page.getByTestId("step-detail")).toHaveCount(0);
  await shot(page, "04-desktop-task");
  await page.goto(`/?theme=light&motion=off#chat/${ids.desktop}`);
  await expect(trail.getByText("Finished", { exact: true })).toBeVisible();
  await shot(page, "11-light");
  await page.setViewportSize({ width: 430, height: 900 });
  await page.goto(`/${Q}#chat/${ids.desktop}`);
  // On a phone the chat shows first, with the latest picture and step in a strip under it.
  await expect(page.getByTestId("desk-strip")).toBeVisible();
  await expect(page.locator(".trail").first()).toBeHidden();
  await shot(page, "12-phone");
  await page.getByTestId("tab-desk").click();
  await expect(page.locator(".trail").first().getByText("Finished", { exact: true })).toBeVisible();
  await shot(page, "12-phone-desktop");
});

test("a desktop task: two columns, the latest screenshot in view and the earlier ones folded", async ({
  page,
}) => {
  await open(page, `#chat/${ids.desktop}`);
  const chat = page.locator(".conv-chat");
  const desk = page.getByTestId("desk");
  // The chat column has what the kitty said and no steps; the desktop column has the steps.
  await expect(chat.locator(".msg").first()).toBeVisible();
  await expect(chat.locator(".trail")).toHaveCount(0);
  await expect(desk.locator(".trail").getByText("Finished", { exact: true })).toBeVisible();
  const [c, d] = [await chat.boundingBox(), await desk.boundingBox()];
  expect(c!.x + c!.width).toBeLessThanOrEqual(d!.x + 1);
  // Phone tabs and the strip are for a narrow window only.
  await expect(page.getByTestId("tab-desk")).toBeHidden();
  await expect(page.getByTestId("desk-strip")).toBeHidden();
  // One screenshot is open (the latest); the earlier ones sit behind a button.
  await expect(desk.locator(".desk-hero .shot-thumb img")).toHaveCount(1);
  const folds = desk.locator(".shot-fold");
  const before = await desk.locator(".shot-thumb").count();
  if ((await folds.count()) > 0) {
    await folds.first().click();
    await expect(desk.locator(".shot-thumb")).toHaveCount(before + 1);
    await folds.first().click();
    await expect(desk.locator(".shot-thumb")).toHaveCount(before);
  }
  // A turn's chip in the chat points at its steps.
  await expect(chat.getByTestId("desk-link").first()).toBeVisible();
  // The arrows (and ← →) walk back through the screenshots; the counter says where.
  const walk = desk.getByTestId("desk-walk");
  if (await walk.isVisible()) {
    const last = (await walk.textContent())!.trim();
    const total = last.match(/\/\s*(\d+)/)![1];
    await expect(walk).toContainText(`${total} / ${total}`);
    await desk.getByRole("button", { name: "Previous screenshot" }).click();
    await expect(walk).toContainText(`${Number(total) - 1} / ${total}`);
    await desk.getByTestId("desk-latest").focus();
    await page.keyboard.press("ArrowRight");
    await expect(walk).toContainText(`${total} / ${total}`);
    await page.keyboard.press("ArrowLeft");
    await expect(walk).toContainText(`${Number(total) - 1} / ${total}`);
  }
  // The divider resizes the column (keys too) and the width is remembered; a double click resets.
  const bar = page.getByTestId("desk-bar");
  const wide = (await desk.boundingBox())!.width;
  await bar.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await desk.boundingBox())!.width).toBeGreaterThan(wide + 10);
  await page.reload();
  await expect
    .poll(async () => (await page.getByTestId("desk").boundingBox())?.width)
    .toBeGreaterThan(wide + 10);
  await page.getByTestId("desk-bar").dblclick();
  await expect
    .poll(async () => Math.abs(((await page.getByTestId("desk").boundingBox())?.width ?? 0) - wide))
    .toBeLessThan(6);
});

test("on a phone the desktop tab gives the chat back when the task ends", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/${Q}#chat/${ids.desktop}`);
  await page.getByTestId("tab-desk").click();
  await expect(page.getByTestId("tab-desk")).toHaveAttribute("aria-selected", "true");
  await page.getByPlaceholder("Say something…").fill("tom, open https://example.com again");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("tab-chat")).toHaveAttribute("aria-selected", "true", {
    timeout: 30000,
  });
  await expect(page.locator(".conv-chat .msg.agent").last()).toBeVisible();
  await shot(page, "12-phone-answer");
});

test("the technical details show only when asked for", async ({ page }) => {
  await open(page, "#new-preferences");
  const box = page.getByTestId("tech-details");
  await expect(box).not.toBeChecked();
  await box.check();
  await open(page, `#chat/${ids.desktop}`);
  const trail = page.locator(".trail").first();
  await expect(trail.getByTestId("step-detail").first()).toBeVisible();
  await expect(trail).toContainText("640, 420");
  await expect(page.getByTestId("tokens").first()).toContainText("tokens");
  // It is the person's choice in this browser: it stays after a reload, and goes when unticked.
  await page.reload();
  await expect(page.locator(".trail").first()).toContainText("640, 420");
  await open(page, "#new-preferences");
  await page.getByTestId("tech-details").uncheck();
  await open(page, `#chat/${ids.desktop}`);
  await expect(page.locator(".trail").first()).not.toContainText("640, 420");
});

// openConfig unfolds the configuration of the kitty's drawer, where its options are edited.
async function openConfig(page: Page) {
  const config = page.getByTestId("kitty-config");
  if (!(await config.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await config.locator("summary").click();
  }
}

test("a kitty's drawer shows its display", async ({ page }) => {
  await open(page, `#kitty/${ids.tom}`);
  await expect(page.getByRole("dialog").first()).toBeVisible();
  await shot(page, "05-kitty-drawer");
  const res = await page.request.get(`${GATEWAY}/v1/kitties/tom/screenshot`, {
    headers: { Authorization: "Bearer e2e-token" },
  });
  expect(res.ok()).toBeTruthy();
  const png = await res.body();
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  fs.writeFileSync(path.join(SHOTS, "13-tom-display.png"), png);
});

test("new chat and new kitty: pick the members, pick the pixel cat", async ({ page }) => {
  await open(page, `#chat/${ids.group}/new-chat`);
  await expect(page.getByText("New chat").first()).toBeVisible();
  await shot(page, "06-new-chat");
  await open(page, "#new-kitty");
  await expect(page.locator(".pixelcat").first()).toBeVisible();
  await shot(page, "07-new-kitty");
});

test("settings: models, connections and the gateway", async ({ page }) => {
  await open(page, "#new-settings");
  await expect(page.getByRole("tab", { name: "Models" })).toBeVisible();
  // A model reads as its provider and its model, with who uses it.
  const model = page.getByTestId("model-fast");
  await expect(model).toContainText("OpenAI");
  await expect(model).toContainText("gpt-5.5");
  await expect(page.getByRole("button", { name: "Add a model" })).toBeVisible();
  await shot(page, "08-settings-models");
  await open(page, "#new-connectors");
  // The connections come first, each saying which kitties may use it.
  await expect(page.getByTestId("connection-team-slack")).toContainText("Slack");
  await expect(page.getByText("sign in needed")).toBeVisible();
  await shot(page, "09-settings-connectors");
  // A sign-in that never ended is taken up from the list, without opening the form.
  await page.route("**/v1/oauth/workspace/start", (route) =>
    route.fulfill({ json: { url: "about:blank", redirect: "" } }),
  );
  await expect(page.getByTestId("finish-sign-in-team-slack")).toHaveCount(0);
  await page.getByTestId("finish-sign-in-workspace").click();
  await expect(page.getByTestId("finish-sign-in-workspace")).toHaveText("Waiting for the browser…");
  await expect(page.getByTestId("connection-form")).toHaveCount(0);
  await open(page, "#new-connect");
  await shot(page, "10-gateway-settings");
});

test("the gateway serves its own page", async ({ page }) => {
  await page.goto(GATEWAY + "/");
  await expect(page.getByText("Kitties").first()).toBeVisible();
  await shot(page, "14-gateway-page");
});

test("the library: skills with a proposal, and the artifacts", async ({ page }) => {
  await open(page, "#new-library");
  await expect(page.getByText("weekly-report").first()).toBeVisible();
  await expect(page.getByText("close-a-cookie-banner").first()).toBeVisible();
  await shot(page, "15-library-skills");
  await open(page, "#new-artifacts");
  await expect(page.getByText("competitor-notes.md").first()).toBeVisible();
  await shot(page, "16-library-artifacts");
});

test("picking a service opens its form; an OAuth kind offers the sign-in", async ({ page }) => {
  await open(page, "#new-connectors-add");
  // Every service in the catalogue is a button with its logo; a search and categories narrow it.
  const buttons = page.locator(".service-btn");
  expect(await buttons.count()).toBeGreaterThanOrEqual(30);
  expect(await buttons.locator("svg.logo, .logo-fallback").count()).toBe(await buttons.count());
  for (const cat of ["Chat & messages", "Social media", "Code", "Office & files", "Finance"]) {
    await expect(page.locator(".chip", { hasText: cat })).toBeVisible();
  }
  await shot(page, "17-connector-catalogue");
  await page.getByLabel("Search services").fill("google");
  await expect(page.locator(".service-btn", { hasText: "Slack" })).toHaveCount(0);
  await page.locator(".service-btn", { hasText: "Google Workspace" }).click();
  await expect(page.getByText("Gmail, Calendar, Drive, Sheets and Docs").first()).toBeVisible();
  // Without an app built into Kitties, signing in asks for the person's own, and says where.
  const signInBox = page.getByTestId("connection-sign-in");
  await expect(signInBox).toContainText("needs an app of your own");
  await expect(signInBox).toContainText("/v1/oauth/callback");
  await expect(signInBox.getByText("Client id of your own app")).toBeVisible();
  await expect(page.getByTestId("connection-sign-in-button")).toBeDisabled();
  // GitHub takes a sign-in, or a token instead.
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByLabel("Search services").fill("github");
  await page.locator(".service-btn", { hasText: "GitHub" }).click();
  // One question first, how to connect: the sign-in or a token; only that way's fields show.
  const gh = page.getByTestId("connection-form");
  await expect(gh.getByTestId("way-signin")).toHaveAttribute("aria-checked", "true");
  await expect(gh.locator("#field-token")).toHaveCount(0);
  // Without an account it cannot be saved, and the form says so under the button.
  await expect(gh.getByTestId("required-legend")).toBeVisible();
  const save = gh.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();
  await expect(gh.getByTestId("missing")).toHaveText("Still needed: sign in");
  await gh.getByTestId("way-token").click();
  await expect(gh.getByTestId("connection-sign-in")).toHaveCount(0);
  // The token is required in that way, and marked so.
  await expect(gh.locator("label[for=field-token] .req")).toBeVisible();
  await gh.locator("#field-token").fill("ghp_demo");
  await expect(save).toBeEnabled();
  await expect(gh.getByTestId("missing")).toHaveCount(0);
  // The saved Google connector shows the sign-in button, which asks the gateway for a consent URL.
  await open(page, "#connector/workspace");
  const signIn = page.getByRole("button", { name: "Sign in with Google" });
  await expect(signIn).toBeVisible();
  await shot(page, "18-connector-oauth");
  const res = await page.request.post(`${GATEWAY}/v1/oauth/workspace/start`, {
    headers: { Authorization: "Bearer e2e-token" },
  });
  expect(res.ok()).toBeTruthy();
  expect(((await res.json()) as { url: string }).url).toContain("accounts.google.com");
});

// hooked is what the outside world (the Slack webhook, the ntfy topic) has received so far.
const hooked = () => fs.readFileSync(HOOK_LOG, "utf8");

test("an action that reaches other people waits for a yes, and runs when it is approved", async ({
  page,
}) => {
  await open(page, `#chat/${ids.post}`);
  await expect(page.getByText("That needs your yes first").first()).toBeVisible();
  await expect(page.getByText("waiting for your yes: Send (team-slack)")).toBeVisible();
  await expect(page.getByTestId("approvals-button")).toContainText("1 waiting");
  expect(hooked()).not.toContain("Kitties launches next week");
  await shot(page, "23-waiting-for-a-yes");

  await open(page, "#new-approvals");
  const card = page.getByTestId("approval").first();
  await expect(card).toContainText("mimi wants to team-slack.send");
  await expect(card).toContainText("Kitties launches next week");
  await shot(page, "24-approvals");
  await card.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Nothing is waiting.")).toBeVisible();
  await expect(page.getByTestId("decided")).toContainText("approved");
  await expect.poll(hooked).toContain("Kitties launches next week");

  // The result is in the thread, with the service's logo.
  await open(page, `#chat/${ids.post}`);
  const turn = page.locator(".msg.approval-turn").first();
  await expect(turn).toContainText("Approved and done: team-slack.send");
  await expect(turn.locator(".tag-logo svg.logo")).toBeVisible();
  await expect(page.getByTestId("approvals-button")).not.toContainText("waiting");
  await shot(page, "19-connector-call");
});

test("a no with a reason goes to the kitty, which keeps it as a correction", async ({ page }) => {
  // Mimi is asked to post again; this time the person says no.
  const headers = { Authorization: "Bearer e2e-token" };
  const created = await page.request.post(`${GATEWAY}/v1/chats`, {
    headers,
    data: { members: ["mimi"], title: "Second announcement" },
  });
  const chat = ((await created.json()) as { chat: { id: string } }).chat.id;
  const sent = await page.request.post(`${GATEWAY}/v1/chats/${chat}/messages`, {
    headers,
    data: { text: "Mimi, post the announcement to the team again." },
  });
  expect(sent.ok()).toBeTruthy();
  await open(page, "#new-approvals");
  const card = page.getByTestId("approval").first();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Reject…" }).click();
  await card.getByLabel(/Why not/).fill("too informal for the team channel");
  await card.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.getByText("Nothing is waiting.")).toBeVisible();
  await expect(page.getByTestId("decided").first()).toContainText("rejected");
  await open(page, `#chat/${chat}`);
  await expect(page.locator(".msg.approval-turn").first()).toContainText(
    "Reason: too informal for the team channel",
  );
  expect(hooked().match(/Kitties launches next week/g)?.length).toBe(1);
});

test("the thumbs under an answer teach the kitty", async ({ page }) => {
  await open(page, `#chat/${ids.single}`);
  // What was said about these turns is kept: a thumb down on the first answer.
  const first = page.locator(".msg.agent").first();
  await expect(first.getByLabel("Not good")).toHaveAttribute("aria-pressed", "true");
  // A new verdict on a group chat: up on one answer, down with a word on another.
  await open(page, `#chat/${ids.group}`);
  const answers = page.locator(".msg.agent");
  await answers.nth(0).getByLabel("Good answer").click();
  await expect(answers.nth(0).getByLabel("Good answer")).toHaveAttribute("aria-pressed", "true");
  await answers.nth(1).getByLabel("Not good").click();
  await answers.nth(1).getByLabel("What was wrong").fill("a little wordy");
  await answers.nth(1).getByLabel("What was wrong").press("Enter");
  await expect(answers.nth(1).getByLabel("Not good")).toHaveAttribute("aria-pressed", "true");
  await shot(page, "25-feedback");
});

test("what a kitty knows about you: its level of demand, its notes and how far it is trusted", async ({
  page,
}) => {
  await open(page, `#kitty/${ids.mimi}`);
  await openConfig(page);
  const memory = page.getByTestId("memory");
  await expect(memory).toBeVisible();
  // Four thumbs down with a word moved the level from balanced to demanding.
  await expect(memory.getByRole("button", { name: "4 · demanding" })).toBeVisible();
  await expect(page.getByTestId("level")).toContainText("They are demanding");
  const notes = page.getByTestId("notes");
  await expect(notes).toContainText("Answer in Spanish when I write in Spanish");
  await expect(notes.locator(".tag", { hasText: "yours" })).toHaveCount(1);
  await expect(notes).toContainText("Correction: Too long: two lines at most");
  await expect(notes).toContainText("I prefer short answers");
  // The yes it gave to Slack is on its way to being trusted: twelve in a row for a demanding person.
  await expect(page.getByTestId("trust")).toContainText("team-slack.send");
  await expect(page.getByTestId("trust")).toContainText("of 12 yeses in a row");
  // By default it acts on its own, as far as the account allows.
  await expect(page.getByLabel("When it wants to publish, send or spend")).toHaveValue("");
  // Today's spending against the daily limits.
  await expect(page.getByTestId("spent")).toContainText("of 5,000,000");
  await expect(page.getByTestId("spent")).toContainText("of 5");
  await memory.scrollIntoViewIfNeeded();
  await shot(page, "26-memory");
  // The person can write a note, correct the level and forget a note.
  await page.getByLabel("A note for it to keep").fill("Sign off with my first name");
  await memory.getByRole("button", { name: "Add note" }).click();
  await expect(notes).toContainText("Sign off with my first name");
  await memory.getByRole("button", { name: "Forget: Sign off with my first name" }).click();
  await expect(notes).not.toContainText("Sign off with my first name");
  await memory.getByRole("button", { name: "2 · easygoing" }).click();
  await expect(page.getByTestId("level")).toContainText("They are easygoing");
  await memory.getByRole("button", { name: "4 · demanding" }).click();
  await expect(page.getByTestId("level")).toContainText("They are demanding");
});

test("notifications: pick a channel, send a test and be told when something waits", async ({
  page,
}) => {
  await open(page, "#new-notifications");
  const form = page.getByTestId("notify");
  await expect(form).toBeVisible();
  await form.getByLabel("Send through").selectOption("phone");
  await expect(form.getByLabel("A kitty gave up and needs my help")).toBeChecked();
  await expect(form.getByLabel("An action is waiting for my yes")).toBeChecked();
  await expect(form.getByLabel("A goal finished")).not.toBeChecked();
  await shot(page, "27-notifications");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByText("Saved.")).toBeVisible();
  await form.getByRole("button", { name: "Send a test" }).click();
  await expect(form.getByText("Sent: look at your phone or channel.")).toBeVisible();
  await expect.poll(hooked).toContain('"topic":"kitties-e2e"');
  await expect.poll(hooked).toContain("Notifications work");
  // A daily summary at a time of the person's choice, and one on demand.
  await form.getByLabel("A summary of the last day, every day at").fill("08:30");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByText("Saved.")).toBeVisible();
  await form.getByTestId("send-digest").click();
  await expect(form.getByText("Summary sent.")).toBeVisible();
  await expect.poll(hooked).toContain("Your kitties, last 24 hours");
  await expect.poll(hooked).toContain("mimi:");
  await shot(page, "29-daily-summary");
  // An action that waits for the person now reaches their phone, with a link to the thread.
  const headers = { Authorization: "Bearer e2e-token" };
  const created = await page.request.post(`${GATEWAY}/v1/chats`, {
    headers,
    data: { members: ["mimi"], title: "Third announcement" },
  });
  const chat = ((await created.json()) as { chat: { id: string } }).chat.id;
  await page.request.post(`${GATEWAY}/v1/chats/${chat}/messages`, {
    headers,
    data: { text: "Mimi, post the announcement to the team once more." },
  });
  await expect.poll(hooked, { timeout: 20_000 }).toContain("mimi: needs your approval");
  await expect.poll(hooked).toContain(`#chat/${chat}`);
});

test("the catalogue marks what asks first, and the new services are there", async ({ page }) => {
  await open(page, "#new-connectors-add");
  for (const name of ["Stripe", "Zendesk", "ntfy (push)"]) {
    await expect(page.locator(".service-btn", { hasText: name })).toBeVisible();
  }
  await page.locator(".service-btn", { hasText: "Stripe" }).click();
  // The key is marked as required, and Save waits for it.
  const form = page.getByTestId("connection-form");
  await expect(form.locator("label[for=field-token] .req")).toBeVisible();
  const save = form.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();
  await form.locator("#field-token").fill("sk_test_demo");
  await expect(save).toBeEnabled();
  await page.getByText("What the kitties can do with it").click();
  // Nothing in the catalogue asks first: the account's own permissions are the limit.
  await expect(page.locator("li", { hasText: "Refund" })).toBeVisible();
  await expect(page.locator("li", { hasText: "Send invoice" })).not.toContainText("asks you first");
  await shot(page, "28-stripe");
});

test("a connection says which kitties may use it", async ({ page }) => {
  await open(page, "#connector/team-slack");
  const form = page.getByTestId("connection-form");
  await expect(form).toBeVisible();
  const who = page.getByTestId("connection-kitties");
  // The kitties of the demo may use every connection.
  for (const name of ["mimi", "tom", "luna"]) {
    await expect(who.locator(".chip", { hasText: name })).toHaveClass(/on/);
  }
  await shot(page, "33-connection-form");
});

test("adding a model: pick the provider, paste the key, keep the suggested model", async ({
  page,
}) => {
  await open(page, "#new-models-add");
  await expect(page.getByTestId("provider-picker")).toBeVisible();
  await shot(page, "32-pick-provider");
  await page.getByRole("button", { name: /^Anthropic Claude/ }).click();
  const form = page.getByTestId("model-form");
  await expect(form.getByText("Get a key from Anthropic Claude")).toBeVisible();
  await expect(page.getByLabel("Model")).toHaveValue("claude-sonnet-5-5");
  // The key and the model are marked as required; without a key there is nothing to save yet.
  await expect(form.locator("label[for=model-key] .req")).toBeVisible();
  await expect(form.locator("label[for=model-name] .req")).toBeVisible();
  await expect(form.getByTestId("missing")).toHaveText("Still needed: the API key");
  await expect(page.getByRole("button", { name: "Save and test" })).toBeDisabled();
  await page.getByLabel("API key").fill("sk-ant-demo");
  await expect(page.getByRole("button", { name: "Save and test" })).toBeEnabled();
  await page.getByLabel("Model").fill("");
  await expect(page.getByRole("button", { name: "Save and test" })).toBeDisabled();
  await expect(form.getByTestId("missing")).toHaveText("Still needed: the model");
  await page.getByLabel("Model").fill("claude-sonnet-5-5");
  await expect(page.getByRole("button", { name: "Save and test" })).toBeEnabled();
  await shot(page, "34-add-model");
});

test("a first run is a checklist, and nothing can be made out of order", async ({ page }) => {
  // A gateway with no model and no kitty yet.
  await page.route("**/v1/kitties", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { kitties: [] } })
      : route.continue(),
  );
  await page.route("**/v1/chats", (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: { chats: [] } }) : route.continue(),
  );
  await page.route("**/v1/providers", (route) =>
    route.fulfill({ json: { providers: [], kinds: [] } }),
  );
  await page.goto(`/${Q}`);
  const welcome = page.getByTestId("welcome");
  await expect(welcome).toContainText("Welcome to Kitties");
  await expect(welcome).toContainText("3 steps");
  await expect(welcome.getByRole("button", { name: "Create a kitty" })).toBeDisabled();
  await shot(page, "31-welcome");
  // A chat needs a kitty, and a kitty needs a model: each says so and leads to the next step.
  await page.locator("aside").getByRole("button", { name: "New chat" }).click();
  await expect(page.getByTestId("chat-needs-kitty")).toBeVisible();
  await page.locator("[data-modal]").getByRole("button", { name: "Create a kitty" }).click();
  await expect(page.getByTestId("kitty-needs-model")).toBeVisible();
  await page.locator("[data-modal]").getByRole("button", { name: "Add a model" }).click();
  await expect(page.getByTestId("provider-picker")).toBeVisible();
});

test("a kitty hands a subtask to another and the chip leads to their thread", async ({ page }) => {
  await open(page, `#chat/${ids.delegated}`);
  await expect(page.getByText("luna took care of it").first()).toBeVisible();
  const chip = page.locator(".tag", { hasText: "→ luna" }).first();
  await expect(chip).toBeVisible();
  await shot(page, "20-delegation");
  await chip.click();
  await expect(page.getByText("mimi → luna").first()).toBeVisible();
  await expect(page.getByText("summarise the launch plan").first()).toBeVisible();
});

test("a long list of goals shows its first few, and the rest on request", async ({ page }) => {
  const headers = { Authorization: "Bearer e2e-token" };
  const made: string[] = [];
  for (let n = 1; n <= 5; n++) {
    const res = await page.request.post(`${GATEWAY}/v1/goals`, {
      headers,
      data: { kitty: "luna", title: `Long list ${n}`, text: "x", every: "@daily" },
    });
    expect(res.ok()).toBeTruthy();
    made.push(((await res.json()) as { goal: { id: string } }).goal.id);
  }
  try {
    await open(page, `#chat/${ids.desktop}`);
    await kittyRow(page, "luna").click();
    const goals = page.getByTestId("goals");
    await expect(goals.locator(".goal")).toHaveCount(3);
    const more = page.getByTestId("goals-more");
    await expect(more).toHaveText("Show 2 more");
    await more.click();
    await expect(goals.locator(".goal")).toHaveCount(5);
    await expect(more).toHaveText("Show less");
    await more.click();
    await expect(goals.locator(".goal")).toHaveCount(3);
  } finally {
    for (const id of made) {
      await page.request
        .delete(`${GATEWAY}/v1/goals/${id}`, { headers, timeout: 5000 })
        .catch(() => undefined);
    }
  }
});

test("the kitty's drawer: goals, the journal, limits and the backup", async ({ page }) => {
  await open(page, `#kitty/${ids.mimi}`);
  // What it does is in view; its brain, who it is and what it may use are edited under
  // its configuration.
  await expect(page.getByTestId("kitty-basics")).toBeHidden();
  await openConfig(page);
  const basics = page.getByTestId("kitty-basics");
  await expect(basics.getByLabel("Brain")).toHaveValue("strong");
  await expect(basics.getByLabel("Who is it?")).toHaveValue(/patient researcher/);
  await expect(page.getByTestId("kitty-connections").locator(".chip.on").first()).toContainText(
    "All, new ones too",
  );
  const goals = page.getByTestId("goals");
  await expect(goals.getByText("Inbox check")).toBeVisible();
  await expect(goals.getByText("Triage new issues")).toBeVisible();
  await expect(goals.getByText("hourly").first()).toBeVisible();
  await expect(goals.getByText("on events from github")).toBeVisible();
  await expect(goals.locator(".tag", { hasText: "done" })).toHaveCount(2);
  const journal = page.getByTestId("journal");
  // Only the first lines show: the rest are a click away.
  if (await page.getByTestId("journal-more").count()) {
    await page.getByTestId("journal-more").click();
  }
  await expect(journal.locator(".tag", { hasText: "event" }).first()).toBeVisible();
  await expect(journal.locator(".tag", { hasText: "done" }).first()).toBeVisible();
  await expect(journal.locator(".tag", { hasText: "delegated" }).first()).toBeVisible();
  await expect(page.getByLabel("Backup (takes over a task mimi gives up on)")).toHaveValue("luna");
  await expect(page.getByLabel("Retries (another way)")).toHaveValue("2");
  await expect(page.getByLabel("Tokens per day")).toHaveValue("5000000");
  await expect(page.getByLabel("Actions per day")).toHaveValue("5");
  // The action limits: the one the person set, and one added and taken away here.
  const limits = page.getByTestId("action-limits");
  await expect(limits.getByTestId("kitty-rules")).toContainText("asks first");
  await expect(limits.getByTestId("kitty-rules")).toContainText("Send on team-slack");
  await expect(limits.getByTestId("add-limit")).toBeDisabled();
  await limits.locator("#rule-connector").selectOption("github");
  await limits.locator("#rule-mode").selectOption("never");
  await limits.getByTestId("add-limit").click();
  const never = limits.getByTestId("kitty-rules").locator("div", { hasText: "anything on github" });
  await expect(never).toContainText("never");
  await never.getByRole("button", { name: "remove" }).click();
  await expect(limits.getByText("anything on github")).toHaveCount(0);
  await goals.scrollIntoViewIfNeeded();
  await shot(page, "21-goals-journal");
  // The sidebar marks the goal chats, and a goal's chat shows the scheduler's call.
  await expect(page.locator("aside .tag", { hasText: "goal" }).first()).toBeVisible();
  await goals.getByText("open chat").first().click();
  await expect(page.locator(".msg.scheduler").first()).toBeVisible();
  await expect(page.getByText("Checked Inbox check").first()).toBeVisible();
  await shot(page, "22-goal-chat");
});

test("in the macOS app the top bars leave room for the window buttons and drag the window", async ({
  page,
}) => {
  await open(page, "");
  // The Wails app adds this class on macOS, where the title bar is hidden and the red, yellow
  // and green buttons float over the page; a browser never has it.
  await page.evaluate(() => document.documentElement.classList.add("mac-inset"));
  const bar = page.locator("aside .titlebar");
  await expect(bar).toHaveCSS("padding-left", "88px");
  await expect(bar).toHaveCSS("--wails-draggable", "drag");
  await expect(page.locator("header.titlebar")).toHaveCSS("--wails-draggable", "drag");
  // What is on a bar stays clickable.
  await expect(page.getByRole("button", { name: "Theme" })).not.toHaveCSS(
    "--wails-draggable",
    "drag",
  );
  // The logo and the name start to the right of the buttons (about 76px wide).
  const logo = await page.locator("aside .titlebar span").first().boundingBox();
  expect(logo!.x).toBeGreaterThan(80);
  await page.screenshot({
    path: "e2e/test-results/mac-inset.png",
    clip: { x: 0, y: 0, width: 600, height: 120 },
  });
});

test("settings still draw against an older gateway that leaves fields out", async ({ page }) => {
  // A gateway from before the catalogue and the notifications: the lists are missing or null.
  await page.route("**/v1/settings", async (route) => {
    await route.fulfill({
      json: { providers: null, connectors: null, default_provider: "", kinds: null },
    });
  });
  await open(page, "#new-settings");
  await expect(page.getByText("No model yet")).toBeVisible();
  await page.getByRole("tab", { name: "Connections" }).click();
  await expect(page.getByText("None yet: pick a service below.")).toBeVisible();
  await page.getByRole("tab", { name: "Notifications" }).click();
  await expect(page.getByTestId("notify")).toBeVisible();
  await expect(page.getByText("Settings could not be drawn")).toHaveCount(0);
});

test("a model can think on a subscription: Claude through Claude Code, Copilot with a code", async ({
  page,
}) => {
  // Nothing is signed in yet (whatever this computer has), until Copilot is.
  let polls = 0;
  await page.route("**/v1/settings", async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    json.accounts = [
      { kind: "claude-code", signed_in: false, available: true },
      { kind: "copilot", signed_in: polls > 1, who: "octocat", available: true },
    ];
    return route.fulfill({ json });
  });
  await open(page, "#new-models-add");
  await page.getByRole("button", { name: /^Anthropic Claude/ }).click();
  const form = page.getByTestId("model-form");
  // A key is the default; the subscription is one click away and walks through Claude Code.
  await expect(form.getByRole("radio", { name: /API key/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await form.getByRole("radio", { name: /Claude subscription/ }).click();
  const signIn = form.getByTestId("sign-in");
  await expect(signIn).toContainText("claude auth login");
  await expect(page.getByLabel("Model")).toHaveValue("sonnet");
  await expect(form.getByLabel("API key")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save and test" })).toBeDisabled();
  await shot(page, "35-claude-subscription");

  // Copilot signs in with a code typed on GitHub; the panel follows it until it is done.
  await page.route("**/v1/settings/accounts/copilot/login", (route) =>
    route.fulfill({
      json: {
        id: "f1",
        kind: "copilot",
        method: "device",
        url: "about:blank",
        code: "ABCD-1234",
        status: "pending",
      },
    }),
  );
  await page.route("**/v1/settings/logins/f1", (route) => {
    polls++;
    return route.fulfill({
      json: {
        id: "f1",
        kind: "copilot",
        method: "device",
        status: polls > 1 ? "connected" : "pending",
        who: "octocat",
      },
    });
  });
  await form.getByRole("button", { name: "change" }).click();
  await page.getByRole("button", { name: /^GitHub Copilot/ }).click();
  await expect(form.getByRole("radio", { name: /GitHub Copilot/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await form.getByTestId("sign-in-start").click();
  await expect(form.getByTestId("sign-in-code")).toContainText("ABCD-1234");
  await shot(page, "36-copilot-code");
  await expect(form.getByTestId("sign-in")).toContainText("Signed in as octocat", {
    timeout: 10_000,
  });
  await expect(page.getByRole("button", { name: "Save and test" })).toBeEnabled();

  // Qwen's sign-in ended: the page says so and points at a key.
  await form.getByRole("button", { name: "change" }).click();
  await page.getByRole("button", { name: /^Qwen/ }).click();
  await form.getByRole("radio", { name: /qwen.ai account/ }).click();
  await expect(form.getByTestId("sign-in")).toContainText("DashScope");
});

test("the Android app asks for the gateway first, then works as a remote", async ({
  page,
  request,
}) => {
  // The app is this page in a WebView with a bridge; it has no gateway of its own.
  await page.addInitScript(() => {
    (window as unknown as { KittiesAndroid: { open(u: string): void } }).KittiesAndroid = {
      open: (u: string) => ((window as unknown as { opened: string }).opened = u),
    };
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/${Q}`);
  const connect = page.getByTestId("android-connect");
  await expect(connect).toContainText("KITTIES_LISTEN=0.0.0.0:7488");
  await expect(page.getByLabel("Address")).toHaveAttribute(
    "placeholder",
    "http://192.168.1.20:7488",
  );
  await shot(page, "37-android-connect");
  const { token } = (await (await request.get(`${GATEWAY}/v1/local-token`)).json()) as {
    token: string;
  };
  // Only an http(s) address is taken; a bare host:port is read as http.
  await page.getByLabel("Address").fill("ftp://example.com");
  await page.getByLabel("Token").fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("The address has to be like")).toBeVisible();
  await page.getByLabel("Address").fill("http://203.0.113.5:7488");
  await expect(page.getByTestId("clear-warning")).toBeVisible();
  await page.getByLabel("Address").fill(new URL(page.url()).host);
  await expect(page.getByTestId("clear-warning")).toHaveCount(0);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("banner").getByText("connected")).toBeVisible();
  // The kitties are a tap away, in the menu.
  await page.getByRole("button", { name: "Menu" }).click();
  await expect(kittyRow(page, "mimi")).toBeVisible();
  await shot(page, "38-android-app");
});

test("Facebook and Instagram: a Page or a professional account, and what waits for a yes", async ({
  page,
}) => {
  await open(page, "#new-connectors-add");
  await page.getByRole("button", { name: "Social media" }).click();
  for (const name of ["Facebook Page", "Instagram"]) {
    await expect(page.locator(".service-btn", { hasText: name })).toBeVisible();
  }
  await page.locator(".service-btn", { hasText: "Instagram" }).click();
  // Signing in with Facebook finds the Page and the Instagram account: nothing to look up.
  await expect(page.getByTestId("connection-sign-in-button")).toContainText(
    "Sign in with Facebook",
  );
  await expect(page.getByTestId("way-token")).toBeVisible();
  await page.getByText("What the kitties can do with it").click();
  await expect(page.locator("li", { hasText: /^Post/ }).first()).toBeVisible();
  await shot(page, "39-instagram");
});

test("creating a kitty closes the dialog at once, and a desktop that cannot start is only a note", async ({
  page,
}) => {
  await open(page, "");
  await page.locator("aside").getByRole("button", { name: "New kitty" }).click();
  // The name is marked as required, and Create waits for it.
  await expect(page.locator("label[for=kitty-name] .req")).toBeVisible();
  await expect(page.locator("#kitty-name")).toHaveAttribute("aria-required", "true");
  await expect(page.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  await expect(page.getByTestId("missing")).toHaveText("Still needed: a name");
  // A name another kitty has is said at once, and Create waits for another.
  await page.getByLabel("Name").fill("Mimi");
  await expect(page.locator("#kitty-name-taken")).toContainText("already a kitty called mimi");
  await expect(page.locator("#kitty-name")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  await page.getByLabel("Name").fill("Nube");
  await expect(page.locator("#kitty-name-taken")).toHaveCount(0);
  // The brain picker is drawn like the other fields, not as the system's button.
  const brain = page.locator("#kitty-brain");
  await expect(brain).toHaveCSS("appearance", "none");
  // Enter in the name creates it, like the button.
  await page.locator("#kitty-name").press("Enter");
  await expect(page.locator("#kitty-name")).toHaveCount(0);
  await expect(kittyRow(page, "nube")).toBeAttached();

  // A gateway whose desktop could not start: the kitty exists, the page says why and moves on.
  await page.route("**/v1/kitties", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 201,
          json: {
            kitty: { id: "x1", name: "bruma", status: "error" },
            warning: "created but not started: docker is not running",
          },
        })
      : route.continue(),
  );
  await page.locator("aside").getByRole("button", { name: "New kitty" }).click();
  await page.getByLabel("Name").fill("bruma");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator("#kitty-name")).toHaveCount(0);
  await expect(page.getByTestId("note")).toContainText(
    "bruma was created, but not started: docker is not running",
  );
});

test("calendars, reminders and contacts: iCloud and others over CalDAV, the Mac's own apps, and home", async ({
  page,
}) => {
  await open(page, "#new-connectors-add");
  await page.getByRole("button", { name: "Calendar, reminders & contacts", exact: true }).click();
  for (const name of [
    "Calendar & reminders (CalDAV)",
    "Contacts (CardDAV)",
    "Mac Calendar, Reminders & Contacts",
  ]) {
    await expect(page.locator(".service-btn", { hasText: name })).toBeVisible();
  }
  await page.locator(".service-btn", { hasText: "Calendar & reminders (CalDAV)" }).click();
  await expect(page.getByLabel("App password")).toBeVisible();
  await expect(page.getByText("caldav.icloud.com").first()).toBeVisible();
  await page.getByText("What the kitties can do with it").click();
  await expect(page.locator("li", { hasText: "Add reminder" })).toBeVisible();
  await shot(page, "40-calendars");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Home, news & weather", exact: true }).click();
  for (const name of ["Home Assistant", "News feeds (RSS)", "Weather"]) {
    await expect(page.locator(".service-btn", { hasText: name })).toBeVisible();
  }
});

test("music, files and the Mac's task managers; the summary can start with the day", async ({
  page,
}) => {
  await open(page, "#new-connectors-add");
  await page.getByRole("button", { name: "Music", exact: true }).click();
  for (const name of ["Spotify", "TIDAL"]) {
    await expect(page.locator(".service-btn", { hasText: name })).toBeVisible();
  }
  await page.locator(".service-btn", { hasText: "TIDAL" }).click();
  await expect(page.getByText("no remote playback")).toBeVisible();
  // TIDAL takes only a sign-in: until then there is nothing to save.
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(page.getByTestId("missing")).toHaveText("Still needed: sign in");
  await shot(page, "41-music");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "All", exact: true }).click();
  for (const name of ["Dropbox", "Things (Mac)", "OmniFocus (Mac)"]) {
    await expect(page.locator(".service-btn", { hasText: name })).toBeVisible();
  }

  // The daily summary can open with the person's day, and keeps the choice.
  await page.getByRole("tab", { name: "Notifications" }).click();
  const day = page.getByTestId("notify-day");
  await expect(day).not.toBeChecked();
  await day.check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.reload();
  await page.getByRole("tab", { name: "Notifications" }).click();
  await expect(page.getByTestId("notify-day")).toBeChecked();
});

test("Mastodon and Home Assistant sign in without an app: the address is all they need", async ({
  page,
}) => {
  await open(page, "#new-connectors-add");
  await page.getByLabel("Search services").fill("mastodon");
  await page.locator(".service-btn", { hasText: "Mastodon" }).click();
  const button = page.getByTestId("connection-sign-in-button");
  await expect(button).toContainText("Sign in with Mastodon");
  // The instance first; then nothing to copy.
  await expect(button).toBeDisabled();
  await page.getByLabel("Instance").fill("https://mastodon.social");
  await expect(button).toBeEnabled();
  await expect(page.getByTestId("connection-sign-in")).toContainText("Nothing to copy");
  await expect(page.getByText("Client id of your own app")).toBeHidden();
  await shot(page, "42-sign-in");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByLabel("Search services").fill("home assistant");
  await page.locator(".service-btn", { hasText: "Home Assistant" }).click();
  await expect(page.getByTestId("connection-sign-in-button")).toContainText(
    "Sign in with Home Assistant",
  );
});

test("a connection is removed after the page's own question, and a saved key can be cleared", async ({
  page,
}) => {
  await page.request.put(`${GATEWAY}/v1/settings/connectors/scratch`, {
    headers: { Authorization: "Bearer e2e-token" },
    data: { kind: "webhook", url: "http://127.0.0.1:1/x" },
  });
  await open(page, "#new-connectors");
  const row = page.getByTestId("connection-scratch");
  await expect(row).toBeVisible();
  // The question is the page's own (a webview may not show the browser's): Cancel keeps it.
  await page.getByRole("button", { name: "Remove scratch" }).click();
  const dialog = page.getByTestId("confirm");
  await expect(dialog).toContainText("Remove the connection");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(row).toBeVisible();
  await page.getByRole("button", { name: "Remove scratch" }).click();
  await dialog.getByRole("button", { name: "Remove" }).click();
  await expect(row).toHaveCount(0);

  // A saved key is never shown; clearing it on purpose leaves the connection without an
  // account, which the form says, until the key is kept again.
  await open(page, "#connector/wiki");
  const form = page.getByTestId("connection-form");
  // The connection has a token: the form opens on that way.
  await expect(form.getByTestId("way-token")).toHaveAttribute("aria-checked", "true");
  const save = form.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeEnabled();
  await form.getByTestId("clear-token").click();
  await expect(form.locator("#field-token")).toHaveAttribute(
    "placeholder",
    "removed when you save",
  );
  await expect(save).toBeDisabled();
  await expect(form.getByTestId("missing")).toBeVisible();
  await form.getByTestId("clear-token").click();
  await expect(save).toBeEnabled();
});

test("X: the callback address, the app's fields stay put, and the OAuth 1.0 keys", async ({
  page,
}) => {
  await open(page, "#new-connectors-add");
  await page.getByLabel("Search services").fill("x (twitter)");
  await page.locator(".service-btn", { hasText: "X (Twitter)" }).click();
  const form = page.getByTestId("connection-form");
  await expect(form.getByTestId("callback-address")).toContainText("/v1/oauth/callback");
  // Typing the client id does not move the field away: the keys go on in the same box.
  const id = form.locator("#field-client_id");
  await id.click();
  await id.pressSequentially("abc");
  await expect(id).toHaveValue("abc");
  await expect(id).toBeFocused();
  await expect(form.getByTestId("callback-address")).toBeVisible();
  await expect(page.getByTestId("connection-sign-in-button")).toBeEnabled();
  await id.fill("");
  // Two ways: the sign-in or the app's keys; the two-hour token is not offered.
  await expect(form.getByTestId("way-token")).toHaveCount(0);
  const save = form.getByRole("button", { name: "Save", exact: true });
  await expect(form.getByTestId("missing")).toHaveText("Still needed: sign in");
  // The keys that do not expire stand for the sign-in: all four, or Save waits.
  await form.getByTestId("way-oauth1").click();
  await expect(form.getByTestId("callback-address")).toHaveCount(0);
  await expect(form.getByTestId("missing")).toContainText("Consumer Key");
  for (const [name, value] of [
    ["consumer_key", "ck"],
    ["consumer_secret", "cs"],
    ["access_token", "42-at"],
  ]) {
    await form.locator(`#field-${name}`).fill(value);
  }
  await expect(save).toBeDisabled();
  await form.locator("#field-access_secret").fill("as");
  await expect(save).toBeEnabled();
  await expect(form.getByText("OAuth 1.0 Keys → Consumer Key")).toBeVisible();
  await shot(page, "43-x-keys");
});

test("a connection says what it uses, is tested from the list and after saving, and a short token counts down", async ({
  page,
}) => {
  const headers = { Authorization: "Bearer e2e-token" };
  await page.request.put(`${GATEWAY}/v1/settings/connectors/tw`, {
    headers,
    data: { kind: "x", settings: { token: "pasted-oauth2-token" } },
  });
  await open(page, "#new-connectors");
  // What each one uses, and the two hours of X's pasted token.
  await expect(page.getByTestId("connection-team-slack")).toContainText("uses a webhook");
  const tw = page.getByTestId("connection-tw");
  await expect(tw).toContainText("uses a token");
  await expect(page.getByTestId("expiry-tw")).toContainText(/token expires in (1h 5\d|2h 0)m/);
  // A webhook cannot be tested without posting: the row says so instead of posting.
  await page.getByTestId("test-team-slack").click();
  await expect(page.getByTestId("test-result-team-slack")).toContainText(
    "cannot be tested without acting",
  );
  await shot(page, "44-connection-test");
  // A service's refusal reads in plain words, not as the service wrote it.
  await page.route("**/v1/settings/connectors/github/test", (route) =>
    route.fulfill({ json: { ok: false, tested: true, error: "HTTP 401: Bad credentials" } }),
  );
  await page.getByTestId("test-github").click();
  await expect(page.getByTestId("test-result-github")).toContainText(
    "did not accept the key or the sign-in",
  );
  await expect(page.getByTestId("test-result-github")).not.toContainText("HTTP 401");

  // Hours later the token is gone: the row and the form say so.
  await page.clock.setFixedTime(Date.now() + 3 * 60 * 60 * 1000);
  await page.reload();
  await expect(kittyRow(page, "mimi")).toBeAttached();
  await expect(page.getByTestId("expiry-tw")).toHaveText("token expired");
  await open(page, "#connector/tw");
  await expect(page.getByTestId("token-expired")).toContainText("use the app keys");

  // Saving runs the test by itself; its answer shows on the row.
  await page.route("**/v1/settings/connectors/tw/test", (route) =>
    route.fulfill({ json: { ok: true, tested: true, account: "madkoding" } }),
  );
  const form = page.getByTestId("connection-form");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("test-result-tw")).toHaveText("✓ It works as madkoding.");
  await page.request.delete(`${GATEWAY}/v1/settings/connectors/tw`, { headers });
});

test("a message sent shows once, while the kitties are still answering", async ({ page }) => {
  const headers = { Authorization: "Bearer e2e-token" };
  const r = await page.request.post(`${GATEWAY}/v1/chats`, {
    headers,
    data: { members: ["mimi"], title: "Once" },
  });
  const chat = ((await r.json()) as { chat: { id: string } }).chat.id;
  // The answer is held back: the message reaches the chat live before the sending ends.
  let release: () => void = () => {};
  const held = new Promise<void>((done) => (release = done));
  await page.route(`**/v1/chats/${chat}/messages`, async (route) => {
    const answer = await route.fetch();
    await held;
    await route.fulfill({ response: answer });
  });
  await open(page, `#chat/${chat}`);
  const box = page.locator("textarea");
  await box.fill("hello there, only once");
  await box.press("Enter");
  const mine = page.locator(".msg.user", { hasText: "hello there, only once" });
  await expect(mine).toHaveCount(1);
  // Long enough for the live message to have arrived next to the one being sent.
  await page.waitForTimeout(1500);
  await expect(mine).toHaveCount(1);
  release();
  await expect(page.getByTestId("thinking")).toHaveCount(0);
  await expect(mine).toHaveCount(1);
  await page.request.delete(`${GATEWAY}/v1/chats/${chat}`, { headers });
});

test("the page speaks Spanish: the system's language, or the one picked", async ({ page }) => {
  // ?lang=es stands for a Spanish system for one visit.
  await page.goto(`/?theme=dark&motion=off&lang=es#chat/${ids.desktop}`);
  await expect(page.locator("aside").getByRole("button", { name: "Nuevo chat" })).toBeVisible();
  await expect(page.locator("textarea")).toHaveAttribute("placeholder", "Escribe algo…");
  const trail = page.locator(".trail").first();
  await expect(trail.getByText("Abrió example.com", { exact: true })).toBeVisible();
  await expect(trail.getByText("Terminó", { exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await shot(page, "45-spanish");
  await page.goto(`/?theme=dark&motion=off&lang=es#new-connectors-add`);
  await expect(page.getByRole("tab", { name: "Conexiones" })).toBeVisible();
  await page.getByLabel("Buscar servicios").fill("github");
  await page.locator(".service-btn", { hasText: "GitHub" }).click();
  await expect(page.getByText("¿Cómo te conectas?")).toBeVisible();
  await shot(page, "46-spanish-connection");

  // What the gateway itself wrote in a chat reads in the page's language too.
  await page.goto(`/?theme=dark&motion=off&lang=es#chat/${ids.post}`);
  await expect(page.getByText(/^Aprobado y hecho: team-slack\.send/).first()).toBeVisible();
  // A Portuguese system gets Portuguese.
  await page.goto(`/?theme=dark&motion=off&lang=pt#chat/${ids.post}`);
  await expect(page.locator("aside").getByRole("button", { name: "Novo chat" })).toBeVisible();
  await expect(page.getByText(/^Aprovado e feito: team-slack\.send/).first()).toBeVisible();

  // Picked in Preferences, it stays; English is a choice away.
  await open(page, "#new-preferences");
  await page.getByLabel("Language").selectOption("es");
  await expect(page.getByRole("tab", { name: "Preferencias" })).toBeVisible();
  await page.goto(`/?theme=dark&motion=off#new-preferences`);
  await expect(page.getByRole("tab", { name: "Preferencias" })).toBeVisible();
  await page.getByLabel("Idioma").selectOption("en");
  await expect(page.getByRole("tab", { name: "Preferences" })).toBeVisible();
});

test("a kitty asked to hold back limits itself, says so in the chat, and it can be undone", async ({
  page,
}) => {
  const headers = { Authorization: "Bearer e2e-token" };
  const r = await page.request.post(`${GATEWAY}/v1/chats`, {
    headers,
    data: { members: ["luna"], title: "Hold back" },
  });
  const chat = ((await r.json()) as { chat: { id: string } }).chat.id;
  await open(page, `#chat/${chat}`);
  const box = page.locator("textarea");
  await box.fill("Please ask me before posting to the team");
  await box.press("Enter");
  const note = page.getByTestId("limit-note");
  await expect(note).toContainText("Limit set: Send on team-slack · asks first");
  const rules = async () =>
    (
      (await (await page.request.get(`${GATEWAY}/v1/approvals/rules`, { headers })).json()) as {
        rules: { kitty_name: string; connector: string }[];
      }
    ).rules.filter((x) => x.kitty_name === "luna");
  expect(await rules()).toHaveLength(1);
  await shot(page, "47-limit-note");
  // Undone, the limit is gone, as if it had never been set.
  await note.getByTestId("limit-undo").click();
  await expect(note).toContainText("undone");
  await expect.poll(rules).toHaveLength(0);
  await page.request.delete(`${GATEWAY}/v1/chats/${chat}`, { headers });
});

test("every dialog closes: its X, Escape or the backdrop, and the address forgets it", async ({
  page,
}) => {
  const dialog = page.locator("[data-modal]");
  const chatHash = `#chat/${ids.single}`;
  await open(page, chatHash);
  const closeX = () => dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  // Opened by a button, closed by its X: Approvals, the library, settings, a new chat.
  for (const [button, how] of [
    [page.getByTestId("approvals-button"), "x"],
    [page.locator("aside").getByRole("button", { name: "Library" }), "escape"],
    [page.locator("aside").getByRole("button", { name: "Settings" }), "x"],
    [page.locator("aside").getByRole("button", { name: "New chat" }), "backdrop"],
  ] as const) {
    await button.click();
    await expect(dialog).toHaveCount(1);
    if (how === "x") {
      await closeX();
    } else if (how === "escape") {
      await page.keyboard.press("Escape");
    } else {
      await dialog.click({ position: { x: 5, y: 5 } });
    }
    await expect(dialog).toHaveCount(0);
  }
  // Opened by its address, closed by its X: the address goes back to the chat, which stayed
  // behind the dialog, and a reload opens nothing.
  for (const route of [
    "#new-approvals",
    "#new-settings",
    "#new-library",
    "#new-chat",
    "#new-kitty",
    "#new-preferences",
  ]) {
    await page.goto(`/${Q}${route}`);
    await expect(dialog).toHaveCount(1);
    await closeX();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`${chatHash}$`));
    await expect(page.locator(".msg").first()).toBeVisible();
    await page.reload();
    // Wait for the page to be up before looking at it (and before the next route is typed): a
    // dialog count of 0 is also true of a page that has not drawn yet, and a hash changed before
    // the app listens for it opens nothing.
    await expect(kittyRow(page, "mimi")).toBeAttached();
    await expect(page.locator(".msg").first()).toBeVisible();
    await expect(dialog).toHaveCount(0);
  }
  // A kitty's drawer goes back to the chat it was opened from.
  await kittyRow(page, "mimi").click();
  await expect(dialog).toHaveCount(1);
  await closeX();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${chatHash}$`));
  // A screenshot opened big closes with Escape.
  await open(page, `#chat/${ids.desktop}`);
  await page.locator(".desk-hero .shot-thumb").click();
  await expect(page.getByTestId("zoom")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("zoom")).toHaveCount(0);
});

test("the buttons of a kitty's drawer never sit over its model and container", async ({ page }) => {
  await open(page, `#chat/${ids.desktop}`);
  await kittyRow(page, "tom").click();
  const header = page.getByTestId("kitty-header");
  await expect(header).toBeVisible();
  // The drawer is opened wide, then the window is narrowed under it.
  for (const width of [1440, 900, 420]) {
    await page.setViewportSize({ width, height: 900 });
    const actions = (await page.getByTestId("kitty-actions").boundingBox())!;
    for (const tag of await header.locator(".tag").all()) {
      const t = (await tag.boundingBox())!;
      const apart =
        t.x + t.width <= actions.x + 1 ||
        actions.x + actions.width <= t.x + 1 ||
        t.y + t.height <= actions.y + 1 ||
        actions.y + actions.height <= t.y + 1;
      expect(apart, `${width}px: a tag is over the buttons`).toBe(true);
    }
    const edge = (await header.boundingBox())!;
    expect(actions.x + actions.width).toBeLessThanOrEqual(edge.x + edge.width + 1);
  }
});

test("a kitty's desktop opens live from the chat, and the person can take control and give it back", async ({
  page,
}) => {
  // The demo draws its desktop: the pictures of the docs (48, 49) are of a real container, taken
  // with desktop/frontend/scripts/live-desktop-shots.mjs, so this test takes none.
  await open(page, `#chat/${ids.desktop}`);
  await page.getByTestId("open-desktop").first().click();
  const live = page.getByTestId("live-desktop");
  await expect(live).toBeVisible();
  await expect(live.getByTestId("live-frame")).toBeVisible();
  await expect(live.getByTestId("live-state")).toHaveText("Watching live");
  // The picture is what changed on the display, drawn on a canvas (the gateway's rectangles,
  // like VNC), not screenshots one by one.
  const frame = live.getByTestId("live-frame");
  await expect(frame).toHaveAttribute("data-mode", "rects");
  await expect
    .poll(() => frame.evaluate((c: HTMLCanvasElement) => c.width * c.height))
    .toBeGreaterThan(0);
  // Taking control: the clicks, the keys and the text reach the display through the gateway.
  const held = page.waitForResponse((r) => r.url().includes("/control") && r.status() === 200);
  await live.getByTestId("take-control").click();
  await held;
  await expect(live.getByTestId("live-state")).toContainText("You have the controls");
  await expect(live.getByTestId("quick-keys")).toBeVisible();
  const inputs: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/input")) {
      inputs.push(JSON.parse(r.postData() || "{}").action);
    }
  });
  const clicked = page.waitForResponse((r) => r.url().includes("/input") && r.status() === 200);
  await live.getByTestId("live-frame").click({ position: { x: 40, y: 30 } });
  // The click is seen to land: a ring where it went and a line that says it is on its way.
  await expect(live.getByTestId("live-ring")).toBeVisible();
  await expect(live.getByTestId("live-activity")).toContainText(/Sending|waiting|Ready/);
  await clicked;
  await page.keyboard.type("hola");
  await expect(live.getByTestId("live-activity")).toContainText("Typing 4 characters");
  await page.keyboard.press("Enter");
  await live.getByRole("button", { name: "Alt+Tab" }).click();
  await expect.poll(() => inputs).toEqual(["click", "type", "key", "key"]);
  await expect(live.getByTestId("live-activity")).toContainText("Ready", { timeout: 8000 });
  // A drag shows what is being dragged while the button is down, and is sent when it is let go.
  const box = (await frame.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await expect(live.getByTestId("live-activity")).toContainText("Button down");
  await page.mouse.move(box.x + 140, box.y + 90, { steps: 4 });
  await expect(live.getByTestId("live-activity")).toContainText("Dragging");
  await expect(live.locator(".live-gesture line")).toHaveCount(1);
  await page.mouse.up();
  await expect.poll(() => inputs).toContain("drag");
  await expect(live.locator(".live-gesture")).toHaveCount(0);
  // The window keeps its margins, and the picture stays inside its frame.
  const view = page.viewportSize()!;
  const dialog = (await live.getByRole("dialog").boundingBox())!;
  expect(dialog.x).toBeGreaterThanOrEqual(8);
  expect(dialog.y).toBeGreaterThanOrEqual(8);
  expect(dialog.x + dialog.width).toBeLessThanOrEqual(view.width - 8);
  expect(dialog.y + dialog.height).toBeLessThanOrEqual(view.height - 8);
  const surface = (await live.locator(".live-surface").boundingBox())!;
  const shown = (await frame.boundingBox())!;
  expect(shown.x).toBeGreaterThanOrEqual(surface.x);
  expect(shown.y).toBeGreaterThanOrEqual(surface.y);
  expect(shown.x + shown.width).toBeLessThanOrEqual(surface.x + surface.width + 1);
  expect(shown.y + shown.height).toBeLessThanOrEqual(surface.y + surface.height + 1);
  // The clipboard both ways: the person's text goes to the kitty's, and comes back.
  const clipboard = live.getByTestId("clipboard");
  await clipboard.getByRole("textbox").fill("my coupon code");
  await clipboard.getByRole("button", { name: "Send to tom" }).click();
  await expect(live.getByTestId("clip-note")).toContainText("On tom's clipboard");
  await clipboard.getByRole("textbox").fill("");
  await clipboard.getByRole("button", { name: "Copy from tom" }).click();
  await expect(clipboard.getByRole("textbox")).toHaveValue("my coupon code");
  // Escape is a key of the display while the person has it, not a way out.
  await page.keyboard.press("Escape");
  await expect(live).toBeVisible();
  await live.getByTestId("give-back").click();
  await expect(live.getByTestId("live-state")).toHaveText("Watching live");
  await page.keyboard.press("Escape");
  await expect(live).toHaveCount(0);
});

test("in a kitty's drawer the desktop is there, live, and one click on it takes the controls", async ({
  page,
}) => {
  await open(page, `#chat/${ids.desktop}`);
  await kittyRow(page, "tom").click();
  const drawer = page.locator("[data-modal]");
  const live = drawer.getByTestId("live-desktop");
  await expect(live).toBeVisible();
  // The desktop comes right after the header, above the goals and the journal: those grow and
  // must not push it down.
  const deskBox = (await live.boundingBox())!;
  const goalsBox = (await drawer.getByText("Goals", { exact: true }).first().boundingBox())!;
  const journalBox = (await drawer.getByText("Journal", { exact: true }).first().boundingBox())!;
  expect(deskBox.y).toBeLessThan(goalsBox.y);
  expect(deskBox.y).toBeLessThan(journalBox.y);
  // One picture of the desktop, and it is the live one: nothing else shows it, nothing to open.
  await expect(drawer.getByTestId("live-frame")).toHaveCount(1);
  await expect(drawer.getByTestId("open-desktop")).toHaveCount(0);
  await expect(live.getByTestId("live-state")).toHaveText("Watching live");
  await expect(live.getByText("Click the picture to take control")).toBeVisible();
  // A click on the picture takes the controls; Escape is then a key of the display, not a way out.
  await live.getByTestId("live-frame").click({ position: { x: 60, y: 40 } });
  await expect(live.getByTestId("live-state")).toContainText("You have the controls");
  await expect(live.getByTestId("live-activity")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer.getByTestId("kitty-header")).toBeVisible();
  // It can be enlarged into a window and reduced back, keeping the controls.
  await live.getByTestId("live-enlarge").click();
  const big = page.getByRole("dialog", { name: "tom's desktop" });
  await expect(big).toBeVisible();
  await expect(big.getByTestId("live-state")).toContainText("You have the controls");
  await expect(big.getByTestId("live-frame")).toHaveAttribute("data-mode", "rects");
  await big.getByRole("button", { name: "Reduce", exact: true }).click();
  await expect(big).toHaveCount(0);
  await expect(live.getByTestId("live-state")).toContainText("You have the controls");
  // Giving it back, and Escape from the window only reduces it: the drawer stays.
  await live.getByTestId("give-back").click();
  await expect(live.getByTestId("live-state")).toHaveText("Watching live");
  await live.getByTestId("live-enlarge").click();
  await expect(big).toBeVisible();
  // The size the person likes is remembered for this kitty: the drawer opens enlarged next time.
  await page.reload();
  await expect(big).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(big).toHaveCount(0);
  await expect(drawer.getByTestId("kitty-header")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
});

test("a desktop that cannot give rectangles is followed as a stream of whole pictures", async ({
  page,
}) => {
  await page.route("**/v1/kitties/*/rects*", (route) => route.fulfill({ status: 404, body: "no" }));
  await open(page, `#chat/${ids.desktop}`);
  await page.getByTestId("open-desktop").first().click();
  const frame = page.getByTestId("live-desktop").getByTestId("live-frame");
  await expect(frame).toHaveAttribute("data-mode", "stream");
  await expect(frame).toHaveAttribute("src", /^blob:/);
});

test("a kitty that needs the person asks for help: a window shows what it sees, and giving the desktop back lets it finish", async ({
  page,
}) => {
  await open(page, `#chat/${ids.desktop}`);
  await page.getByPlaceholder("Say something…").fill("tom, sign in to the shop for me");
  await page.keyboard.press("Enter");
  // The window opens on its own, with what the kitty sees and what it asked for.
  const modal = page.getByTestId("help-modal");
  await expect(modal).toBeVisible({ timeout: 15000 });
  await expect(modal).toContainText("the shop's sign-in needs your password");
  await expect(modal.getByRole("img", { name: "What tom sees" })).toBeVisible();
  await shot(page, "50-help-modal");
  // Not now: the window closes and the chat keeps a button for it.
  await modal.getByRole("button", { name: "Not now" }).click();
  await expect(modal).toHaveCount(0);
  const callout = page.getByTestId("help-callout");
  await expect(callout).toBeVisible();
  await expect(
    page.locator(".trail").getByText("Asked you for help: the shop's sign-in needs your password"),
  ).toBeVisible();
  await callout.getByTestId("help-take-control").click();
  const live = page.getByTestId("live-desktop");
  await expect(live.getByTestId("live-state")).toContainText("You have the controls");
  await live.getByTestId("give-back").click();
  await live.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByText("Signed in to the shop: thank you for the password.")).toBeVisible({
    timeout: 15000,
  });
  await expect(callout).toHaveCount(0);
});

test("a kitty that needs the person gets what it asked for typed in the window, told or in secret", async ({
  page,
}) => {
  await open(page, `#chat/${ids.desktop}`);
  const typed: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/help")) {
      typed.push(r.postData() || "");
    }
  });
  await page.getByPlaceholder("Say something…").fill("tom, log in to the shop again");
  await page.keyboard.press("Enter");
  const modal = page.getByTestId("help-modal");
  await expect(modal).toBeVisible({ timeout: 15000 });
  const send = modal.getByTestId("help-send");
  await expect(send).toBeDisabled();
  await modal.getByTestId("help-input").fill("hunter2");
  await expect(modal.getByTestId("help-input")).toHaveAttribute("type", "text");
  await expect(send).toHaveText("Tell tom");
  // A secret is hidden, and typed on the desktop instead of told to the kitty.
  await modal.getByTestId("help-secret").check();
  await modal.getByTestId("help-save").fill("Shop password");
  await expect(modal.getByTestId("help-input")).toHaveAttribute("type", "password");
  await expect(send).toHaveText("Type it on the desktop");
  await send.click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByText("You typed it on its desktop").first()).toBeVisible();
  await expect(
    page.getByText("Signed in to the shop: thank you for the password.").last(),
  ).toBeVisible({
    timeout: 15000,
  });
  expect(JSON.parse(typed[0])).toEqual({
    text: "hunter2",
    secret: true,
    enter: false,
    save: "Shop password",
  });
  // It was kept for tom, and the vault never says a value.
  const vault = await page.request.get(`${GATEWAY}/v1/vault`, {
    headers: { Authorization: "Bearer e2e-token" },
  });
  const listed = await vault.text();
  expect(listed).toContain("Shop password");
  expect(listed).not.toContain("hunter2");
  await expect(page.getByText("hunter2")).toHaveCount(0);
});

test("a kitty's cookies, sessions and passwords are backed up, and a newer desktop can be updated", async ({
  page,
}) => {
  await open(page, `#kitty/${ids.tom}`);
  const care = page.getByTestId("desktop-care");
  await expect(care).toBeVisible();
  await expect(care.getByTestId("backup-state")).toContainText("are not backed up yet");
  await expect(care.getByTestId("update-callout")).toHaveCount(0);
  await expect(care.getByTestId("auto-update")).toContainText(
    "downloaded and installed by themselves",
  );
  // Backing up keeps them sealed away from the desktop, and says when.
  const done = page.waitForResponse((r) => r.url().includes("/backup") && r.status() === 200);
  await care.getByTestId("backup-now").click();
  await done;
  await expect(care.getByTestId("backup-state")).toContainText("backed up");
  await expect(care.getByTestId("backup-state")).not.toContainText("not backed up");
  await shot(page, "52-desktop-backup");
  // A newer image: the page offers the update, asks first, and the kitty comes back from it.
  await page.route("**/v1/kitties/*/desktop", (route) =>
    route.fulfill({
      json: { image: "ghcr.io/madkoding/kitty-desktop:latest", update_available: true },
    }),
  );
  let updated = "";
  await page.route("**/v1/kitties/*/update", (route) => {
    updated = route.request().url();
    return route.fulfill({ status: 202, json: { kitty: {} } });
  });
  await page.reload();
  const callout = page.getByTestId("update-callout");
  await expect(callout).toContainText("A newer desktop is available for tom");
  await shot(page, "53-desktop-update");
  await callout.getByTestId("update-desktop").click();
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await expect.poll(() => updated).toContain("/update");
});

test("the version of Kitties: a newer one is offered, asked about and installed, and the page follows the restart", async ({
  page,
}) => {
  let status = {
    current: "v1.0.0",
    latest: "v1.1.0",
    available: true,
    mode: "notify",
    can_apply: true,
    checked_at: new Date().toISOString(),
  };
  let applied = 0;
  await page.route("**/v1/update**", (route) =>
    route.request().method() === "POST"
      ? ((applied += 1),
        route.fulfill({ status: 202, json: { updated_to: "v1.1.0", restarting: true } }))
      : route.fulfill({ json: status }),
  );
  await open(page, `#chat/${ids.desktop}`);
  await page.locator("aside").getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Preferences" }).click();
  const box = page.getByTestId("updates");
  await expect(box).toContainText("Kitties v1.0.0");
  await expect(box.getByTestId("update-available")).toContainText("Kitties v1.1.0 is available");
  await expect(box).toContainText("tells you; you decide when to update");
  // Without a signing key the update is only checksummed, and the page says so.
  await expect(box.getByTestId("update-unsigned")).toContainText("updates.public_key");
  await shot(page, "54-updates");
  // It asks first, installs, and says it is restarting.
  await box.getByTestId("update-apply").click();
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await expect(box.getByTestId("update-restarting")).toContainText("Updated to v1.1.0");
  expect(applied).toBe(1);
});

test("a gateway that cannot replace itself says how it is updated, and one that is up to date says so", async ({
  page,
}) => {
  let status: Record<string, unknown> = {
    current: "v1.0.0",
    latest: "v1.1.0",
    available: true,
    mode: "auto",
    can_apply: false,
    why: "this gateway runs in a container: update it with `docker compose pull && docker compose up -d`",
  };
  await page.route("**/v1/update**", (route) => route.fulfill({ json: status }));
  await open(page, `#chat/${ids.desktop}`);
  await page.locator("aside").getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Preferences" }).click();
  const box = page.getByTestId("updates");
  await expect(box.getByTestId("update-available")).toContainText("runs in a container");
  await expect(box.getByTestId("update-apply")).toHaveCount(0);
  await expect(box).toContainText("installs them by itself");
  status = {
    current: "v1.1.0",
    latest: "v1.2.0",
    available: false,
    skipped: "v1.2.0",
    mode: "off",
    can_apply: true,
  };
  await page.getByRole("tab", { name: "Models" }).click();
  await page.getByRole("tab", { name: "Preferences" }).click();
  await expect(box.getByTestId("update-skipped")).toContainText("v1.2.0 did not hold here");
  await expect(box).toContainText("does not look for new versions");
  await expect(box.getByTestId("update-check")).toBeDisabled();
});

test("the secrets a kitty may type: saved with who may use them, changed and removed, never shown", async ({
  page,
}) => {
  await open(page, `#chat/${ids.desktop}`);
  await page.locator("aside").getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Secrets" }).click();
  const secrets = page.getByTestId("secrets");
  await expect(secrets).toBeVisible();
  const save = secrets.getByTestId("secret-save");
  await expect(save).toBeDisabled();
  await secrets.locator("#secret-name").fill("Bank code");
  await secrets.locator("#secret-value").fill("4821");
  await expect(secrets.locator("#secret-value")).toHaveAttribute("type", "password");
  await secrets.getByRole("group", { name: "Kitties that may use it" }).getByText("tom").click();
  await save.click();
  const row = secrets.locator('[data-secret="Bank code"]');
  await expect(row).toContainText("May be used by tom");
  await expect(secrets).not.toContainText("4821");
  await shot(page, "51-secrets");
  // Who may use it changes in place.
  await row.getByRole("group").getByText("mimi").click();
  await expect(row).toContainText("tom, mimi");
  await row.getByRole("group").getByText("tom").click();
  await row.getByRole("group").getByText("mimi").click();
  await expect(row).toContainText("No kitty may use it yet");
  // Removing asks first.
  await row.getByRole("button", { name: "Remove the secret Bank code" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(row).toHaveCount(0);
});

test("a kitty's desktop wears the theme picked in its drawer", async ({ page }) => {
  await open(page, `#chat/${ids.desktop}`);
  await kittyRow(page, "tom").click();
  await openConfig(page);
  const pick = page.locator("[data-modal]").getByTestId("desktop-theme");
  await expect(pick).toHaveValue("");
  const saved = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().includes("/v1/kitties/"),
  );
  await pick.selectOption("Greybird-dark");
  expect(JSON.parse((await saved).request().postData() || "{}")).toEqual({
    theme: "Greybird-dark",
  });
  await expect(page.getByText("tom's desktop now wears Greybird.")).toBeVisible();
  await expect(pick).toHaveValue("Greybird-dark");
  await pick.selectOption("");
  await expect(pick).toHaveValue("");
});
