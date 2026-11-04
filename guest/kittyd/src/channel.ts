import { Database } from "bun:sqlite";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

interface Config {
  url: string;
  token: string;
  kittyId: string;
  remoteId: string;
  generation: number;
  tokenVersion: number;
  database: string;
  display?: string;
}
interface Action {
  type: "action";
  intentId: string;
  generation: number;
  epoch: number;
  deadline: number;
  action: string;
  args: Record<string, unknown>;
}
interface Receipt {
  id: string;
  generation: number;
  epoch: number;
  status: string;
  result: string | null;
  body: string;
}
const config: Config = JSON.parse(
  await readFile(
    process.env.KITTYD_CONFIG ??
      `${process.env.CREDENTIALS_DIRECTORY ?? "/etc/kittyd"}/config.json`,
    "utf8",
  ),
);
if (!config.url.startsWith("wss://") && !config.url.startsWith("ws://localhost"))
  throw Error("Guest requires WSS");
await mkdir(dirname(config.database), { recursive: true, mode: 0o700 });
const db = new Database(config.database, { create: true, strict: true });
db.exec(
  "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY,generation INTEGER NOT NULL,epoch INTEGER NOT NULL,status TEXT NOT NULL,result TEXT,body TEXT NOT NULL,created_at INTEGER NOT NULL)",
);
const session = await readFile("/tmp/kitties-session/env.json", "utf8")
  .then((value) => JSON.parse(value) as Record<string, string>)
  .catch(() => ({}));
const env = { ...process.env, ...session, DISPLAY: config.display ?? ":99" };
let active: WebSocket | undefined,
  frames: WebSocket | undefined,
  epoch = 0,
  viewers = 0,
  sequence = 0,
  retry = 500;
let capture: ReturnType<typeof Bun.spawn> | undefined;
let latest: Uint8Array | undefined;
let queue = Promise.resolve();
const headers = () => ({
  Authorization: `Bearer ${config.token}`,
  "X-Kitty-Remote": config.remoteId,
  "X-Kitty-Generation": String(config.generation),
  "X-Kitty-Token-Version": String(config.tokenVersion),
  "X-Kitty-Epoch": String(epoch),
});
const send = (body: unknown) => {
  if (active?.readyState === WebSocket.OPEN) active.send(JSON.stringify(body));
};
const boundedNumber = (value: unknown, min: number, max: number) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw Error("INVALID_ARGUMENT");
  return String(Math.round(value));
};
const boundedText = (value: unknown, limit = 65536) => {
  if (typeof value !== "string" || value.length > limit) throw Error("INVALID_ARGUMENT");
  return value;
};
async function run(command: string[], input?: string) {
  const child = Bun.spawn(command, {
    env,
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw Error(error.slice(0, 200) || "COMMAND_FAILED");
  return output.slice(0, 65536);
}
async function execute(action: Action): Promise<string> {
  const args = action.args;
  switch (action.action) {
    case "move":
      return run([
        "xdotool",
        "mousemove",
        boundedNumber(args.x, 0, 8191),
        boundedNumber(args.y, 0, 8191),
      ]);
    case "click":
      return run([
        "xdotool",
        "mousemove",
        boundedNumber(args.x, 0, 8191),
        boundedNumber(args.y, 0, 8191),
        "click",
        "--delay",
        "0",
        boundedNumber(args.button ?? 1, 1, 3),
      ]);
    case "scroll":
      return run([
        "xdotool",
        "click",
        "--repeat",
        boundedNumber(args.amount ?? 1, 1, 20),
        "--delay",
        "10",
        args.direction === "up" ? "4" : "5",
      ]);
    case "key": {
      const key = boundedText(args.key, 100);
      if (!/^[A-Za-z0-9_+ -]+$/.test(key)) throw Error("INVALID_KEY");
      return run(["xdotool", "key", "--clearmodifiers", key]);
    }
    case "type":
      return run(
        ["xdotool", "type", "--clearmodifiers", "--delay", "0", "--file", "-"],
        boundedText(args.text),
      );
    case "clipboard_read":
      return run(["xclip", "-selection", "clipboard", "-o"]);
    case "clipboard_write":
      return run(["xclip", "-selection", "clipboard", "-i"], boundedText(args.text));
    case "screenshot": {
      const child = Bun.spawn(["/usr/local/lib/kittyd/kitty-grab", "--once", "1", "55"], {
        env,
        stdout: "pipe",
        stderr: "ignore",
      });
      const bytes = new Uint8Array(await new Response(child.stdout).arrayBuffer());
      if ((await child.exited) !== 0 || bytes.length > 1024 * 1024)
        throw Error("SCREENSHOT_FAILED");
      const end = bytes.indexOf(10);
      if (end < 0) throw Error("SCREENSHOT_FAILED");
      const response = await fetch(
        config.url
          .replace(/^wss:/, "https:")
          .replace(/^ws:/, "http:")
          .replace(/\/control$/, "/artifact/" + action.intentId),
        {
          method: "PUT",
          headers: { ...headers(), "Content-Type": "image/jpeg" },
          body: bytes.slice(end + 1),
        },
      );
      if (!response.ok) throw Error("SCREENSHOT_UPLOAD_FAILED");
      return JSON.stringify(await response.json());
    }
    case "type_secret":
      await run(
        ["xdotool", "type", "--clearmodifiers", "--delay", "0", "--file", "-"],
        boundedText(args.value),
      );
      return "SECRET_TYPED";
    case "browser_read":
      await run(["agent-browser", "connect", "19222"]);
      return run(["agent-browser", "snapshot", "--json"]);
    case "browser_click":
    case "browser_type": {
      const ref = boundedText(args.ref, 40);
      if (!/^@?e[0-9]+$/.test(ref)) throw Error("STALE_REF");
      return run([
        "agent-browser",
        action.action === "browser_click" ? "click" : "fill",
        ref,
        ...(action.action === "browser_type" ? [boundedText(args.text, 4000)] : []),
        "--json",
      ]);
    }
    case "ui_read":
    case "ui_click":
    case "ui_type": {
      const response = await fetch("http://localhost/action", {
        unix: "/run/kitties-perception/control.sock",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: action.action, ...args }),
        signal: AbortSignal.timeout(25000),
      });
      if (!response.ok) throw Error("PERCEPTION_UNAVAILABLE");
      return response.text();
    }
    case "quiesce":
      return run(["/usr/local/lib/kittyd/kitty-quiesce"]);
    default:
      throw Error("UNSUPPORTED_ACTION");
  }
}
async function dispatch(action: Action, socket: WebSocket, receivedAt: number) {
  if (
    socket !== active ||
    socket.readyState !== WebSocket.OPEN ||
    action.generation !== config.generation ||
    action.epoch !== epoch ||
    action.deadline <= Date.now() ||
    action.deadline > Date.now() + 60000
  ) {
    // Auto-response pings can keep an obsolete socket alive through a deploy.
    // A fenced dispatch must reconnect, rather than silently dropping all input.
    socket.close(1012, "Dispatch fence changed");
    return;
  }
  const body = JSON.stringify(
    action.action === "type_secret" ? { ...action, args: { ref: action.args.ref } } : action,
  );
  const saved = db
    .query<Receipt, [string]>("SELECT * FROM intents WHERE id=?")
    .get(action.intentId);
  if (saved) {
    if (saved.generation !== config.generation || saved.body !== body) {
      socket.close(1008, "Intent conflict");
      return;
    }
    send({
      type: "ack",
      intentId: saved.id,
      generation: saved.generation,
      epoch,
      status: saved.status === "started" ? "unknown" : saved.status,
      result: saved.result ?? undefined,
    });
    return;
  }
  // synchronous=FULL commits the intent before any desktop effect.
  db.query("INSERT INTO intents VALUES (?,?,?,'started',NULL,?,?)").run(
    action.intentId,
    config.generation,
    epoch,
    body,
    Date.now(),
  );
  const startedAt = Date.now();
  let status = "completed",
    result: string;
  try {
    result = await execute(action);
  } catch {
    status = "failed";
    result = "ACTION_FAILED";
  }
  db.query("UPDATE intents SET status=?,result=? WHERE id=?").run(status, result, action.intentId);
  // A lost socket is harmless: the next welcome asks for the saved receipt.
  if (socket === active)
    send({
      type: "ack",
      intentId: action.intentId,
      generation: config.generation,
      epoch,
      status,
      result,
      timings: { receivedAt, startedAt, completedAt: Date.now() },
    });
}
function stopCapture() {
  capture?.kill();
  capture = undefined;
  frames?.close();
  frames = undefined;
  latest = undefined;
}
async function startCapture() {
  if (capture || viewers === 0 || !active || epoch === 0) return;
  const child = Bun.spawn(["/usr/local/lib/kittyd/kitty-grab", "--stdin", "15", "65"], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  capture = child;
  frames = new WebSocket(config.url.replace(/\/control$/, "/frames"), { headers: headers() });
  frames.onclose = () => {
    if (capture === child) {
      child.kill();
      capture = undefined;
      if (viewers > 0) setTimeout(() => void startCapture(), 1000);
    }
  };
  let buffer = Buffer.alloc(0),
    expected = 0;
  try {
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    while (capture === child) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer = Buffer.concat([buffer, chunk.value]);
      if (buffer.length > 2 * 1024 * 1024) throw Error("FRAME_TOO_LARGE");
      while (buffer.length) {
        if (!expected) {
          const end = buffer.indexOf(10);
          if (end < 0) break;
          const line = buffer.subarray(0, end).toString();
          buffer = buffer.subarray(end + 1);
          if (line === "PING") continue;
          if (!/^FRAME [0-9]+$/.test(line)) throw Error("FRAME_PROTOCOL");
          expected = Number(line.slice(6));
          if (expected > 1024 * 1024) throw Error("FRAME_TOO_LARGE");
        }
        if (buffer.length < expected) break;
        latest = new Uint8Array(buffer.subarray(0, expected));
        buffer = buffer.subarray(expected);
        expected = 0;
        if (frames?.readyState === WebSocket.OPEN && frames.bufferedAmount < 128 * 1024) {
          const packet = new Uint8Array(latest.length + 8),
            view = new DataView(packet.buffer);
          view.setUint32(0, config.generation);
          view.setUint32(4, ++sequence);
          packet.set(latest, 8);
          frames.send(packet);
        }
      }
    }
  } catch {
    /* Captures restart while there is demand. */
  } finally {
    if (capture === child) {
      capture = undefined;
      child.kill();
      frames?.close();
      frames = undefined;
      if (viewers > 0) setTimeout(() => void startCapture(), 1000);
    }
  }
}
function publishLatest() {
  if (!latest || frames?.readyState !== WebSocket.OPEN || frames.bufferedAmount > 128 * 1024)
    return;
  const packet = new Uint8Array(latest.length + 8),
    view = new DataView(packet.buffer);
  view.setUint32(0, config.generation);
  view.setUint32(4, ++sequence);
  packet.set(latest, 8);
  frames.send(packet);
}
function connect() {
  const socket = new WebSocket(config.url, { headers: headers() });
  active = socket;
  socket.onopen = () => {
    retry = 500;
    socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: 1,
        buildId: "kittyd-1",
        kittyId: config.kittyId,
        remoteId: config.remoteId,
        generation: config.generation,
      }),
    );
  };
  socket.onmessage = (event) => {
    try {
      if (event.data === "pong") return;
      const body = JSON.parse(String(event.data));
      if (body.type === "welcome") {
        epoch = body.epoch;
        console.info("Guest connected", { generation: config.generation, epoch });
        viewers = body.viewers ?? 0;
        const receipts = (body.reconcile ?? []).map((id: string) => {
          const row = db
            .query<Receipt, [string]>(
              "SELECT * FROM intents WHERE id=? AND generation=" + config.generation,
            )
            .get(id);
          return {
            type: "ack",
            intentId: id,
            generation: config.generation,
            epoch,
            status: !row || row.status === "started" ? "unknown" : row.status,
            result: row?.result ?? undefined,
          };
        });
        send({ type: "reconcile", receipts });
        if (viewers > 0) void startCapture();
        return;
      }
      if (body.type === "viewers") {
        viewers = body.count;
        if (viewers > 0) {
          void startCapture();
          publishLatest();
        } else stopCapture();
        return;
      }
      if (body.type === "action") {
        const receivedAt = Date.now();
        queue = queue
          .then(() => dispatch(body, socket, receivedAt))
          .catch(() => {
            socket.close(1011, "Dispatch failed");
          });
      }
    } catch {
      socket.close(1008, "Protocol error");
    }
  };
  socket.onclose = () => {
    if (active !== socket) return;
    active = undefined;
    epoch = 0;
    viewers = 0;
    stopCapture();
    setTimeout(connect, retry + Math.random() * 250);
    retry = Math.min(retry * 2, 10000);
  };
  socket.onerror = () => socket.close();
}
process.on("SIGTERM", () => {
  active?.close();
  stopCapture();
  db.close();
  process.exit(0);
});
setInterval(() => {
  if (active?.readyState === WebSocket.OPEN) active.send("ping");
}, 20000);
connect();
