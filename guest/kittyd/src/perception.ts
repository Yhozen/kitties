import { chmod, mkdir, readFile, unlink } from "node:fs/promises";
import { perceptionAction, PerceptionSession } from "./perception-session.ts";

const socket = "/run/kitties-perception/control.sock";
export async function servePerception() {
  const session = JSON.parse(await readFile("/tmp/kitties-session/env.json", "utf8")) as Record<
    string,
    string
  >;
  // AT-SPI authenticates the desktop UID. Neither process has guest credentials.
  const state = "/run/kitties-perception/state";
  await mkdir(state, { recursive: true, mode: 0o700 });
  const adapter = new PerceptionSession(
    ["python3", "-u", "/usr/local/lib/kittyd/perception-helper.py"],
    { ...process.env, ...session, AGENT_DESKTOP_HOME: state },
  );
  process.on("SIGTERM", () => {
    adapter.close();
    process.exit(0);
  });
  await unlink(socket).catch(() => undefined);
  Bun.serve({
    unix: socket,
    maxRequestBodySize: 32768,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/action")
        return new Response(null, { status: 404 });
      try {
        const action = perceptionAction(await request.json());
        return Response.json(await adapter.run(action));
      } catch {
        return Response.json({ code: "INVALID_ARGUMENT" }, { status: 400 });
      }
    },
  });
  await chmod(socket, 0o660);
}
