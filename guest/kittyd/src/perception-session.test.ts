import { afterEach, describe, expect, it } from "vitest";
import { perceptionAction, PerceptionSession } from "./perception-session.ts";

const sessions: PerceptionSession[] = [];
function session(behavior = "", timeout = 2000) {
  const code = `
    process.stdout.write('{"ready":1}\\n');
    let calls = 0;
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const body = JSON.parse(line); calls++;
      ${behavior}
      process.stdout.write(JSON.stringify({status:'completed',result:String(calls)})+'\\n');
    });`;
  const adapter = new PerceptionSession([process.execPath, "-e", code], process.env, timeout);
  sessions.push(adapter);
  return adapter;
}
afterEach(() => {
  for (const adapter of sessions.splice(0)) adapter.close();
});
const read = { action: "ui_read" } as const;
const click = { action: "ui_click", ref: "@snapshot:e1" } as const;

describe("persistent perception process", () => {
  it("reuses the process and rejects concurrent actions instead of queueing them", async () => {
    const adapter = session();
    const first = adapter.run(read);
    expect(await adapter.run(click)).toEqual({ status: "failed", result: "PERCEPTION_BUSY" });
    expect(await first).toEqual({ status: "completed", result: "1" });
    expect(await adapter.run(read)).toEqual({ status: "completed", result: "2" });
  });

  it("preserves native failures without converting them to completed receipts", async () => {
    const adapter = session(
      `process.stdout.write(JSON.stringify({status:'failed',result:'STALE_REF'})+'\\n'); return;`,
    );
    expect(await adapter.run(click)).toEqual({ status: "failed", result: "STALE_REF" });
  });

  it.each([
    "process.exit(2);",
    "process.stdout.write('x'.repeat(65537)); return;",
    "process.stdout.write('invalid\\n'); return;",
  ])("records uncertain delivery on broken IPC and never replays: %s", async (behavior) => {
    const adapter = session(behavior);
    expect((await adapter.run(click)).status).toBe("unknown");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await adapter.run(read)).status).toBe("failed");
  });

  it("kills a hung mutation, then starts a fresh helper for a new read", async () => {
    const adapter = session("if (body.action === 'ui_click') return;", 1000);
    expect((await adapter.run(read)).status).toBe("completed");
    expect((await adapter.run(click)).status).toBe("unknown");
    // Reaping a killed process can take longer than 50 ms on a loaded CI host.
    await expect
      .poll(async () => adapter.run(read), { timeout: 3000 })
      .toEqual({
        status: "completed",
        result: "1",
      });
  });

  it("knows a mutation was not sent if startup fails", async () => {
    const adapter = new PerceptionSession(["/does-not-exist/agent-desktop"], process.env, 250);
    sessions.push(adapter);
    expect((await adapter.run(click)).status).toBe("failed");
  });
});

it("rejects malformed refs, oversized text and embedded NUL before dispatch", () => {
  for (const ref of ["@e1", "@abc:e0", "@abc:e4294967296", "@../../x:e1", "@abc:e1\0"])
    expect(() => perceptionAction({ ...click, ref })).toThrow();
  for (const text of ["a".repeat(4001), "hello\0world"])
    expect(() => perceptionAction({ action: "ui_type", ref: click.ref, text })).toThrow();
  expect(perceptionAction({ action: "ui_type", ref: click.ref, text: "hola 🐈" })).toEqual({
    action: "ui_type",
    ref: click.ref,
    text: "hola 🐈",
  });
});
