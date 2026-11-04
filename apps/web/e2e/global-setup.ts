import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { GATEWAY, HOOK_LOG, ROOT, STATE, WEBHOOK_PORT } from "./playwright.config";

// The seed: what the screens show. Connectors and models through the settings API, a skill, an
// artifact, a proposed skill as a file, and four chats whose turns the scripted brain answers.
const H = { Authorization: "Bearer e2e-token", "Content-Type": "application/json" };

async function api<T = unknown>(
  method: string,
  p: string,
  body?: unknown,
  ctype?: string,
): Promise<T> {
  const res = await fetch(GATEWAY + p, {
    method,
    headers: ctype ? { ...H, "Content-Type": ctype } : H,
    body: body === undefined ? undefined : ctype ? (body as string) : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${method} ${p}: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

interface Chat {
  id: string;
  turns: { from: string; working?: boolean }[] | null;
}

const turnsOf = async (chat: string) =>
  (await api<{ chat: Chat }>("GET", `/v1/chats/${chat}`)).chat.turns || [];

async function newChat(members: string[], title?: string): Promise<string> {
  const r = await api<{ chat: Chat }>("POST", "/v1/chats", { members, title });
  return r.chat.id;
}

// say sends a message and waits for every kitty to have answered it.
async function say(chat: string, text: string): Promise<void> {
  const before = (await turnsOf(chat)).length;
  await api("POST", `/v1/chats/${chat}/messages`, { text });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const turns = await turnsOf(chat);
    const last = turns[turns.length - 1];
    if (turns.length > before + 1 && last && last.from !== "user" && !last.working) {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`chat ${chat}: no answer to ${JSON.stringify(text)}`);
}

// A Slack webhook of our own, so the post the brain makes lands somewhere and says ok.
function webhookStub(): Promise<http.Server> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        fs.appendFileSync(
          HOOK_LOG,
          `${req.method} ${req.url} ${Buffer.concat(chunks).toString("utf8")}\n`,
        );
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      });
    });
    srv.listen(WEBHOOK_PORT, "127.0.0.1", () => resolve(srv));
  });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  fs.writeFileSync(HOOK_LOG, "");
  const stub = await webhookStub();
  const dataDir = path.join(ROOT, "desktop/frontend/e2e/.data/demo");

  await api("PUT", "/v1/settings/providers/fast", { kind: "openai", model: "gpt-5.5" });
  await api("PUT", "/v1/settings/connectors/team-slack", {
    kind: "slack",
    url: `http://127.0.0.1:${WEBHOOK_PORT}/hook`,
    description: "posts to the #launch channel",
  });
  await api("PUT", "/v1/settings/connectors/coder", {
    kind: "motita",
    description: "runs a coding task in motita and returns the result",
    url: "http://127.0.0.1:7477",
  });
  await api("PUT", "/v1/settings/connectors/github", {
    kind: "github",
    description: "issues and pull requests of the kitties repository",
    settings: { token: "ghp_demo", repo: "madkoding/kitties" },
  });
  await api("PUT", "/v1/settings/connectors/diagrams", {
    kind: "kroki",
    description: "renders diagrams to SVG",
  });
  await api("PUT", "/v1/settings/connectors/wiki", {
    kind: "notion",
    description: "the team wiki",
    settings: { token: "secret_demo", parent: "abc123" },
  });
  // Saved as the step before its sign-in: it has no account yet, and the page offers it.
  await api("PUT", "/v1/settings/connectors/workspace?sign_in=1", {
    kind: "google-workspace",
    description: "mail, calendar and drive of the team account",
    settings: { client_id: "1234-demo.apps.googleusercontent.com" },
  });
  await api("PUT", "/v1/skills/weekly-report", {
    body: "# Weekly report\n\nHow the Friday report is written.\n\n1. Collect the numbers from the dashboard.\n2. Three bullets: what shipped, what slipped, what is next.\n3. Post it to #launch with the slack connector.",
  });
  await api(
    "PUT",
    "/v1/artifacts/competitor-notes.md",
    "# Competitor notes\n\n| Name | Price | Notes |\n| --- | --- | --- |\n| Acme | 12 | fast |",
    "text/markdown",
  );
  fs.mkdirSync(path.join(dataDir, "skills/proposed"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "skills/proposed/close-a-cookie-banner.md"),
    "# Close a cookie banner\n\nWhat worked on three sites.\n\n1. Look for a button named Accept, OK or Got it in the lower third of the page.\n2. Click it, wait one second and take a screenshot.\n",
  );

  const single = await newChat(["mimi"]);
  await say(single, "Hello Mimi! What can you do?");
  await say(single, "Could you **plan** a small launch for the kitties project?");
  const group = await newChat(["mimi", "tom", "luna"], "Launch team");
  await say(group, "Team, let us plan the launch. Who takes what?");
  await say(group, "@luna can you summarise the plan and @tom check the numbers?");
  const desktop = await newChat(["tom"], "Tom on the desktop");
  await say(desktop, "Tom, open https://example.com and tell me what the page says.");
  // Nothing is limited by default: the person asked mimi to show posts to the team first.
  await api("POST", "/v1/approvals/rules", {
    kitty: "mimi",
    connector: "team-slack",
    action: "send",
    mode: "ask",
  });
  const post = await newChat(["mimi"], "Announcement");
  await say(post, "Mimi, please post the launch announcement to the team.");
  const tom = (await api<{ kitty: { id: string } }>("GET", "/v1/kitties/tom")).kitty.id;
  const mimi = (await api<{ kitty: { id: string } }>("GET", "/v1/kitties/mimi")).kitty.id;

  // What mimi has learned about the person: a note of the person's own, one she took herself,
  // and four thumbs down (with a word) that make the person look more demanding to her.
  await api("POST", "/v1/kitties/mimi/memory", {
    text: "Answer in Spanish when I write in Spanish",
    scope: "user",
  });
  const memo = await newChat(["mimi"], "Preferences");
  await say(memo, "Mimi, remember that I prefer short answers.");
  await api("POST", `/v1/chats/${single}/turns/1/feedback`, {
    rating: "down",
    note: "Too long: two lines at most",
  });
  await api("POST", `/v1/chats/${single}/turns/3/feedback`, {
    rating: "down",
    note: "Use a table for plans",
  });
  await api("POST", `/v1/chats/${post}/turns/1/feedback`, {
    rating: "down",
    note: "Never post without showing me a draft",
  });

  // Delegation: mimi hands a subtask to luna and reports back.
  const delegated = await newChat(["mimi"], "Plan review");
  await say(delegated, "Mimi, ask luna to summarise the launch plan in three lines.");
  await api("POST", `/v1/chats/${delegated}/turns/1/feedback`, { rating: "down", note: "" });
  // A push channel (an ntfy topic on the stub) for the notifications the tests set up.
  await api("PUT", "/v1/settings/connectors/phone", {
    kind: "ntfy",
    description: "push notifications to my phone",
    settings: { topic: "kitties-e2e", url: `http://127.0.0.1:${WEBHOOK_PORT}` },
  });

  // Autonomy: mimi has a goal on a schedule and one on GitHub's events; the person runs the
  // first now, and GitHub posts an issue for the second. Limits and a backup are set too.
  await api("PATCH", `/v1/kitties/${mimi}`, {
    limits: {
      max_tokens: 20000,
      max_seconds: 600,
      retries: 2,
      day_tokens: 5000000,
      day_actions: 5,
    },
    backup: "luna",
  });
  await api("PUT", "/v1/settings/connectors/github", {
    kind: "github",
    description: "issues and pull requests of the kitties repository",
    settings: { token: "ghp_demo", repo: "madkoding/kitties", inbound_secret: "e2e-hook-secret" },
  });
  const inbox = await api<{ goal: { id: string } }>("POST", "/v1/goals", {
    kitty: "mimi",
    title: "Inbox check",
    text: "Look at the inbox and answer what is easy.",
    every: "@hourly",
  });
  await api("POST", "/v1/goals", {
    kitty: "mimi",
    title: "Triage new issues",
    text: "Read the new issue, label it and answer if it is easy.",
    on: ["github"],
  });
  await api("POST", `/v1/goals/${inbox.goal.id}/run`);
  const hook = await fetch(`${GATEWAY}/v1/hooks/github`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Kitties-Secret": "e2e-hook-secret",
      "X-GitHub-Event": "issues",
    },
    body: JSON.stringify({
      action: "opened",
      issue: {
        number: 42,
        title: "Crash on start",
        body: "It crashes when the config is empty.",
        html_url: "https://github.com/madkoding/kitties/issues/42",
        user: { login: "pat" },
      },
      repository: { full_name: "madkoding/kitties" },
    }),
  });
  if (!hook.ok) {
    throw new Error(`hook: ${hook.status} ${await hook.text()}`);
  }
  // The goals answer in the background: wait for their chats to settle.
  const settle = async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const goals = (
        await api<{ goals: { last_result?: string }[] }>("GET", `/v1/goals?kitty=mimi`)
      ).goals;
      if (goals.every((g) => g.last_result && g.last_result !== "running")) {
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("the goals did not finish");
  };
  await settle();

  fs.writeFileSync(
    STATE,
    JSON.stringify({ single, group, desktop, post, tom, mimi, delegated }, null, 2),
  );
  return async () => {
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  };
}
