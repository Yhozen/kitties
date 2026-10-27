import { expect, test } from "@playwright/test";
import fs from "node:fs";
import { STATE } from "./playwright.config";

const ids = JSON.parse(fs.readFileSync(STATE, "utf8")) as { mimi: string; single: string };

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test("cloud sleep stays distinct from Stop and persistent computers cannot be replaced", async ({
  page,
}) => {
  let status = "sleeping";
  let availability = "sleeping";
  let operation = "";
  let checkpoint = "saved-checkpoint-test";
  const actions: string[] = [];
  const overlay = () => ({
    status,
    availability,
    operation: { kind: operation },
    computer: { runtime: "boat", id: "bx-test", checkpoint_id: checkpoint },
  });
  await page.route("**/v1/kitties", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.kitties = body.kitties.map((k: { id: string }) =>
      k.id === ids.mimi ? { ...k, ...overlay() } : k,
    );
    await route.fulfill({ json: body });
  });
  await page.route(`**/v1/kitties/${ids.mimi}/desktop`, (route) =>
    route.fulfill({
      json: {
        image: "",
        update_available: true,
        auto_update: true,
        capabilities: {
          kind: "boat",
          persistent_disk: true,
          guest_workspace: true,
          image_updates: false,
        },
      },
    }),
  );
  await page.route(`**/v1/kitties/${ids.mimi}/stop`, async (route) => {
    actions.push("stop");
    status = "stopping";
    availability = "disabled";
    operation = "stop";
    await route.fulfill({ status: 202, json: { kitty: overlay() } });
  });
  await page.goto(`/?lang=en&motion=off#kitty/${ids.mimi}`);
  const care = page.getByTestId("desktop-care");
  await expect(care.getByTestId("recovery-state")).toContainText(checkpoint);
  await expect(care.getByTestId("update-desktop")).toHaveCount(0);
  await expect(care.getByTestId("purge-recovery")).toHaveCount(0);
  await expect(page.getByTestId("live-desktop")).toHaveCount(0);
  await page
    .getByTestId("kitty-actions")
    .getByRole("button", { name: "Stop", exact: true })
    .click();
  await expect(page.getByTestId("lifecycle-progress")).toContainText("Saving and stopping");
  status = "stopped";
  operation = "";
  await expect(
    page.getByText("Stopped. Tasks will not wake this kitty until you choose Start."),
  ).toBeVisible();
  expect(actions).toEqual(["stop"]);
  await expect(care.getByTestId("recovery-state")).toContainText(checkpoint);
});

test("an interrupted task waits for deliberate continuation", async ({ page }) => {
  const sent: string[] = [];
  await page.route(`**/v1/chats/${ids.single}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const turns = body.chat.turns;
    turns[turns.length - 1] = {
      ...turns[turns.length - 1],
      working: false,
      resumable: false,
      interrupted: true,
    };
    await route.fulfill({ json: body });
  });
  await page.route(`**/v1/chats/${ids.single}/messages`, async (route) => {
    sent.push(route.request().postDataJSON().text);
    await route.fulfill({ json: { turns: [] } });
  });
  await page.goto(`/?lang=en&motion=off#chat/${ids.single}`);
  await expect(page.getByTestId("resume-callout")).toContainText(
    "Review its last actions before continuing",
  );
  expect(sent).toEqual([]);
  await page.getByTestId("resume").click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toContain("Do not repeat actions that already succeeded");
});

test("removed computers retain independently managed recovery checkpoints", async ({ page }) => {
  let removed = true;
  const purged: string[] = [];
  await page.route("**/v1/recoveries", (route) =>
    route.fulfill({
      json: {
        recoveries: [
          {
            name: "kitty-live",
            computer: { runtime: "boat" },
            checkpoint_name: "live-checkpoint",
            removed: false,
          },
          ...(removed
            ? [
                {
                  name: "kitty-removed",
                  computer: { runtime: "boat" },
                  checkpoint_name: "retained-checkpoint",
                  checkpoint_at: "2026-10-27T12:00:00Z",
                  removed: true,
                },
              ]
            : []),
        ],
      },
    }),
  );
  await page.route("**/v1/recoveries/kitty-removed/purge", async (route) => {
    purged.push("kitty-removed");
    removed = false;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/?lang=en&motion=off#new-preferences");
  const section = page.getByTestId("retained-recoveries");
  await expect(section.getByTestId("recovery-entry")).toHaveCount(2);
  const live = section.getByTestId("recovery-entry").filter({ hasText: "kitty-live" });
  await expect(live.getByTestId("purge-recovery")).toBeDisabled();
  const retained = section.getByTestId("recovery-entry").filter({ hasText: "kitty-removed" });
  await retained.getByTestId("purge-recovery").click();
  await expect(page.getByTestId("confirm")).toContainText("Independent backups remain");
  expect(purged).toEqual([]);
  await page.getByTestId("confirm").getByRole("button", { name: "Cancel", exact: true }).click();
  expect(purged).toEqual([]);
  await retained.getByTestId("purge-recovery").click();
  await page
    .getByTestId("confirm")
    .getByRole("button", { name: "Delete recovery checkpoint", exact: true })
    .click();
  await expect.poll(() => purged).toEqual(["kitty-removed"]);
  await expect(section.getByTestId("recovery-entry")).toHaveCount(1);
});

test("independent backup status reports overdue capture and manual completion", async ({
  page,
}) => {
  let running = false;
  let completed = false;
  let captures = 0;
  const status = () => ({
    enabled: true,
    running,
    phase: running ? "capturing" : "idle",
    overdue: !completed,
    last_success: completed ? "2026-10-27T12:00:00Z" : "0001-01-01T00:00:00Z",
    snapshot_id: completed ? "independent-recovery-test" : "",
  });
  await page.route("**/v1/backups/status", (route) => route.fulfill({ json: status() }));
  await page.route("**/v1/backups", (route) => {
    captures++;
    running = true;
    return route.fulfill({ status: 202, json: status() });
  });
  await page.goto("/?lang=en&motion=off#new-preferences");
  const section = page.getByTestId("independent-backups");
  await expect(section).toContainText("A backup is overdue");
  await expect(section).toContainText("Seven daily and four weekly");
  await section.getByTestId("backup-now").click();
  await expect(section).toContainText("Backup in progress");
  await expect(section.getByTestId("backup-now")).toBeDisabled();
  expect(captures).toBe(1);
  completed = true;
  running = false;
  await expect(section).toContainText("independent-recovery-test");
  await expect(section).toContainText("Last successful backup");
  await expect(section.getByTestId("backup-now")).toBeEnabled();
});

test("Cloudflare sign out closes the Access session", async ({ page }) => {
  await page.route("**/v1/**", (route) =>
    route.continue({
      headers: { ...route.request().headers(), Authorization: "Bearer e2e-token" },
    }),
  );
  await page.route("**/v1/local-token", (route) =>
    route.fulfill({ status: 404, json: { error: "Not found" } }),
  );
  await page.route("**/v1/session", (route) =>
    route.fulfill({
      json: { signed_in: true, local_token: false, logout_url: "/cdn-cgi/access/logout" },
    }),
  );
  await page.route("**/cdn-cgi/access/logout", (route) =>
    route.fulfill({ contentType: "text/plain", body: "Access session ended" }),
  );
  await page.goto("/?lang=en&motion=off");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/cdn-cgi\/access\/logout$/);
});
