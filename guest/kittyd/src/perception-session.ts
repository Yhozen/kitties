import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type PerceptionAction =
  | { action: "ui_read" }
  | { action: "ui_click"; ref: string }
  | { action: "ui_type"; ref: string; text: string };

export interface PerceptionResult {
  status: "completed" | "failed" | "unknown";
  result: string;
}

export function perceptionAction(value: unknown): PerceptionAction {
  if (!value || typeof value !== "object") throw Error("INVALID_ARGUMENT");
  const body = value as Record<string, unknown>;

  if (body.action === "ui_read") return { action: body.action };

  if (body.action !== "ui_click" && body.action !== "ui_type") throw Error("INVALID_ARGUMENT");

  if (
    typeof body.ref !== "string" ||
    !/^@[a-zA-Z0-9_-]{3,64}:e[1-9][0-9]{0,9}$/.test(body.ref) ||
    Number(body.ref.split(":e")[1]) > 0xffffffff
  )
    throw Error("INVALID_ARGUMENT");

  if (body.action === "ui_click") return { action: body.action, ref: body.ref };

  if (typeof body.text !== "string" || body.text.length > 4000 || body.text.includes("\0"))
    throw Error("INVALID_ARGUMENT");

  return { action: body.action, ref: body.ref, text: body.text };
}

// One helper owns one native adapter. No request queue: the guest already serializes
// actions, and accepting a delayed mutation here would outlive its caller's deadline.
export class PerceptionSession {
  private child?: ChildProcessWithoutNullStreams;
  private ready = false;
  private pending?: {
    action: PerceptionAction;
    sent: boolean;
    resolve: (result: PerceptionResult) => void;
    timer: ReturnType<typeof setTimeout>;
  };

  constructor(
    private readonly command: readonly string[],
    private readonly env: NodeJS.ProcessEnv,
    private readonly timeoutMs = 20000,
  ) {}

  run(action: PerceptionAction): Promise<PerceptionResult> {
    if (this.pending || (this.child && this.child.killed))
      return Promise.resolve({ status: "failed", result: "PERCEPTION_BUSY" });

    return new Promise((resolve) => {
      this.pending = {
        action,
        sent: false,
        resolve,
        timer: setTimeout(() => this.fail(), this.timeoutMs),
      };

      if (!this.child) this.start();

      if (this.ready) this.write();
    });
  }

  close() {
    this.fail();
  }

  private finish(result: PerceptionResult) {
    const pending = this.pending;
    this.pending = undefined;

    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(result);
    }
  }

  private fail() {
    this.ready = false;
    this.child?.kill("SIGKILL");
    this.finish({
      status: this.pending?.sent && this.pending.action.action !== "ui_read" ? "unknown" : "failed",
      result: "PERCEPTION_UNAVAILABLE",
    });
  }

  private write() {
    const pending = this.pending;

    if (!pending || pending.sent) return;
    pending.sent = true;
    this.child?.stdin.write(JSON.stringify(pending.action) + "\n");
  }

  private start() {
    try {
      const child = spawn(this.command[0], this.command.slice(1), { env: this.env, stdio: "pipe" });
      this.child = child;
      let buffer = Buffer.alloc(0);
      child.stderr.resume(); // Native diagnostics can include screen content. Never log them.
      child.on("error", () => this.fail());
      child.stdin.on("error", () => this.fail());
      child.on("close", () => {
        if (this.child !== child) return;
        this.fail();
        this.child = undefined;
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (child.killed) return;
        buffer = Buffer.concat([buffer, chunk]);

        if (buffer.length > 65536) return this.fail();
        const newline = buffer.indexOf(10);

        if (newline < 0) return;

        // The helper emits exactly one line per request, including its startup handshake.
        if (newline !== buffer.length - 1) return this.fail();

        try {
          const body = JSON.parse(buffer.toString("utf8")) as Record<string, unknown>;
          buffer = Buffer.alloc(0);

          if (!this.ready) {
            if (body.ready !== 1) return this.fail();
            this.ready = true;
            this.write();
          } else {
            if (
              !this.pending?.sent ||
              !["completed", "failed", "unknown"].includes(String(body.status)) ||
              typeof body.result !== "string"
            )
              return this.fail();
            this.finish(body as unknown as PerceptionResult);
          }
        } catch {
          this.fail();
        }
      });
    } catch {
      this.fail();
      this.child = undefined;
    }
  }
}
