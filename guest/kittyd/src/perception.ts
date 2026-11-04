import { chmod, readFile, unlink } from "node:fs/promises";
const socket = "/run/kitties-perception/control.sock";
export async function servePerception() {
  const session = JSON.parse(await readFile("/tmp/kitties-session/env.json", "utf8")) as Record<
    string,
    string
  >;
  const env = { ...process.env, ...session };
  // AT-SPI authenticates the desktop UID. This service holds no guest credentials;
  // its Unix socket is accessible only to the kittyd group.
  await unlink(socket).catch(() => undefined);
  Bun.serve({
    unix: socket,
    maxRequestBodySize: 16384,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/action")
        return new Response(null, { status: 404 });
      try {
        const body = (await request.json()) as { action: string; ref?: string; text?: string };
        const command = ["agent-desktop"];
        if (body.action === "ui_read") command.push("snapshot");
        else if (body.action === "ui_click" || body.action === "ui_type") {
          if (
            typeof body.ref !== "string" ||
            !/^@[a-zA-Z0-9_-]+:e[0-9]+$/.test(body.ref) ||
            body.ref.length > 80
          )
            throw Error();
          command.push(body.action === "ui_click" ? "click" : "type", body.ref);
          if (body.action === "ui_type") {
            if (typeof body.text !== "string" || body.text.length > 4000) throw Error();
            command.push(body.text);
          }
        } else throw Error();
        const child = Bun.spawn(command, {
          env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        });
        const timeout = setTimeout(() => child.kill(), 20000);
        try {
          const reader = child.stdout.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 65536) {
              child.kill();
              throw Error();
            }
            chunks.push(value);
          }
          await child.exited;
          if (!size) throw Error();
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          return new Response(bytes, { headers: { "Content-Type": "application/json" } });
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        return Response.json({ code: "PERCEPTION_UNAVAILABLE" }, { status: 400 });
      }
    },
  });
  await chmod(socket, 0o660);
}
