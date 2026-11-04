import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { DurableFiles } from "./state.ts";
import { containerRequest, gatewayRequest, sameOrigin } from "./http.ts";
import { backupEnvironment } from "./backups.ts";
import { ResticRepository } from "./restic.ts";
import { RecoveryCoordinator, RecoveryConflict } from "./recovery.ts";

interface Env {
  GATEWAY: DurableObjectNamespace<Gateway>;
  COORDINATOR: DurableObjectNamespace<Coordinator>;
  STATE: R2Bucket;
  BACKUPS: R2Bucket;
  RESTIC_PASSWORD: string;
  BOAT_DEV_API_KEY: string;
  OPENAI_API_KEY: string;
  KITTIES_TOKEN: string;
  KITTIES_VAULT_KEY: string;
  KITTIES_RESTORE_SNAPSHOT: string;
  PUBLIC_URL: string;
  ACCESS_EMAIL: string;
}

interface BridgeProps {
  owner: string;
  epoch: number;
}

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./worker.ts");
      durableNamespaces: "Gateway" | "Coordinator";
    }
  }
}

const ALARM_INTERVAL_MS = 60_000;
const IDLE_TIMEOUT_MS = 10 * 60_000;
const PORT = 7488;
const READINESS_TIMEOUT_MS = 10 * 60_000;

export class StateBridge extends WorkerEntrypoint<Env, BridgeProps> {
  async fetch(request: Request): Promise<Response> {
    const { owner, epoch } = this.ctx.props;
    // These props are installed by the owning DO, never taken from HTTP input.
    const id = this.env.GATEWAY.idFromString(owner);
    return this.env.GATEWAY.get(id).stateRequest(request, epoch);
  }
}

export class BackupBridge extends WorkerEntrypoint<Env, BridgeProps> {
  async fetch(request: Request): Promise<Response> {
    const { owner, epoch } = this.ctx.props;
    return this.env.GATEWAY.get(
      this.env.GATEWAY.idFromString(owner),
    ).backupRequest(request, epoch);
  }
}

export class Gateway extends DurableObject<Env> {
  private readonly files: DurableFiles;
  private readonly backups: ResticRepository;
  private readonly backupRequests = new Set<Promise<Response>>();
  private starting: Promise<void> | undefined;
  private retired = false;
  private transitioning = false;
  private recovery: { id: string; snapshot: string } | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.files = new DurableFiles(ctx.storage, env.STATE, ctx.id.toString());
    this.backups = new ResticRepository(env.BACKUPS);
    ctx.blockConcurrencyWhile(async () => {
      this.retired = (await ctx.storage.get<boolean>("retired")) ?? false;
      this.recovery = await ctx.storage.get<{ id: string; snapshot: string }>(
        "recovery",
      );
    });
  }

  async stateRequest(request: Request, epoch: number): Promise<Response> {
    return this.files.handle(request, epoch);
  }

  async backupRequest(request: Request, epoch: number): Promise<Response> {
    const owns = () =>
      !this.retired &&
      Number.isSafeInteger(epoch) &&
      epoch > 0 &&
      epoch === this.files.epoch();
    if (!owns())
      return new Response("Gateway no longer owns backup access", {
        status: 409,
      });
    const operation = this.backups.handle(request);
    this.backupRequests.add(operation);
    try {
      const response = await operation;
      if (!owns()) {
        await response.body?.cancel();
        return new Response("Gateway no longer owns backup access", {
          status: 409,
        });
      }
      return response;
    } catch {
      return new Response("Backup storage is unavailable", { status: 503 });
    } finally {
      this.backupRequests.delete(operation);
    }
  }

  async diagnostics(): Promise<{
    epoch: number;
    image?: string;
    retired: boolean;
    running: boolean;
    files: number;
  }> {
    const current = this.container().running
      ? await this.container().inspect()
      : undefined;
    return {
      epoch: this.files.epoch(),
      image: current?.image,
      retired: this.retired,
      running: this.container().running,
      files: this.files.manifest().files.length,
    };
  }

  async wake(): Promise<void> {
    await this.ensureRunning();
  }

  async alarm(): Promise<void> {
    if (this.retired) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    // The Go scheduler and Boat TTL renewal continue while the owner's browser is closed.
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    await this.ensureRunning();
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await this.ensureRunning();
      return await this.container()
        .getTcpPort(PORT)
        .fetch(containerRequest(request));
    } catch (error) {
      let message =
        error instanceof Error ? error.message : "Unknown runtime failure";
      for (const value of Object.values(this.containerEnvironment())) {
        if (value.length > 4) message = message.replaceAll(value, "[redacted]");
      }
      console.warn("Gateway request failed", message.slice(0, 300));
      return Response.json(
        { error: "The gateway is recovering. Try again shortly." },
        { status: 503, headers: { "Retry-After": "5" } },
      );
    }
  }

  private ensureRunning(): Promise<void> {
    if (this.retired || this.transitioning)
      return Promise.reject(new Error("Gateway generation is unavailable"));
    if (!this.starting) {
      this.starting = this.startGateway().finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  private async startGateway(): Promise<void> {
    const container = this.container();
    const image = container.images.GatewayImage;
    if (!image) throw new Error("Gateway image binding is missing");
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    const environment = this.containerEnvironment();
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(environment)),
    );
    const configuration = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (container.running) {
      const current = await container.inspect();
      if (
        current?.image !== image ||
        current.labels.configuration !== configuration
      )
        await this.stopForUpgrade(container);
    }
    if (!container.running) {
      const epoch = await this.files.advanceEpoch();
      await Promise.allSettled([...this.backupRequests]);
      await this.installBridge(container, epoch);
      if (this.retired) throw new Error("Gateway generation is retired");
      container.start({
        image,
        instance: "basic",
        enableInternet: true, // Boat SSH requires outbound TCP, in addition to provider HTTPS.
        env: environment,
        labels: { configuration },
      });
    } else {
      await this.installBridge(container, this.files.epoch());
    }
    await container.setInactivityTimeout(IDLE_TIMEOUT_MS);
    await this.waitForHealth(container);
  }

  private containerEnvironment(): Record<string, string> {
    return {
      ...backupEnvironment(this.env.RESTIC_PASSWORD),
      KITTIES_CONFIG: "/etc/kitties/default.yaml",
      KITTIES_DATA_DIR: "/var/lib/kitties",
      KITTIES_STATE_URL: "http://kitties-state.internal",
      KITTIES_LISTEN: "0.0.0.0:7488",
      KITTIES_PUBLIC_URL: this.env.PUBLIC_URL,
      KITTIES_TRUST_PROXY: "true",
      KITTIES_TOKEN: this.env.KITTIES_TOKEN,
      KITTIES_VAULT_KEY: this.env.KITTIES_VAULT_KEY,
      KITTIES_RESTORE_SNAPSHOT:
        this.recovery?.snapshot ?? this.env.KITTIES_RESTORE_SNAPSHOT,
      BOAT_DEV_API_KEY: this.env.BOAT_DEV_API_KEY,
      OPENAI_API_KEY: this.env.OPENAI_API_KEY,
    };
  }

  async preflight(
    id: string,
    snapshot: string,
  ): Promise<"pending" | "ready" | "failed"> {
    await this.ensureRunning();
    const key = `preflight:${id}`;
    const resultPath = `/tmp/kitties-preflight-${id}`;
    const previous = await this.ctx.storage.get<{
      epoch: number;
      started: number;
      snapshot: string;
    }>(key);
    if (!previous) {
      await this.ctx.storage.put(key, {
        epoch: this.files.epoch(),
        started: Date.now(),
        snapshot,
      });
      await this.ctx.storage.sync();
      // Verification runs independently of an individual DO event's duration limit.
      await this.container().exec(
        [
          "sh",
          "-c",
          'code=0; kitties verify-recovery "$1" --freeze "$3" || code=$?; printf "%s\n" "$code" > "$2.tmp"; mv "$2.tmp" "$2"',
          "verify",
          snapshot,
          resultPath,
          id,
        ],
        {
          env: this.containerEnvironment(),
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      return "pending";
    }
    if (
      previous.snapshot !== snapshot ||
      previous.epoch !== this.files.epoch() ||
      Date.now() - previous.started > 35 * 60_000
    )
      return "failed";
    const process = await this.container().exec(["cat", resultPath], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await process.output();
    if (output.exitCode !== 0) return "pending";
    return new TextDecoder().decode(output.stdout).trim() === "0"
      ? "ready"
      : "failed";
  }

  async release(id: string): Promise<void> {
    await this.ensureRunning();
    const process = await this.container().exec(
      ["kitties", "release-recovery", id],
      {
        env: this.containerEnvironment(),
        stdout: "ignore",
        stderr: "ignore",
        signal: AbortSignal.timeout(30_000),
      },
    );
    if ((await process.exitCode) !== 0)
      throw new Error("Recovery maintenance freeze could not be released");
  }

  async retire(): Promise<void> {
    this.retired = true;
    await this.ctx.storage.put("retired", true);
    await this.ctx.storage.sync();
    await this.ctx.storage.deleteAlarm();
    await Promise.allSettled([...this.backupRequests]);
    await this.starting?.catch(() => undefined);
    const container = this.container();
    if (container.running) await this.stopForUpgrade(container);
    await container.destroy("Gateway generation retired for recovery");
    if (container.running) throw new Error("Previous gateway has not stopped");
    await this.files.advanceEpoch();
  }

  async activate(id: string, snapshot: string): Promise<void> {
    if (this.retired) throw new Error("Cannot activate a retired generation");
    if (
      this.recovery &&
      (this.recovery.id !== id || this.recovery.snapshot !== snapshot)
    )
      throw new Error("Gateway already belongs to another recovery");
    if (!this.recovery) {
      const manifest = this.files.manifest();
      if (manifest.revision !== 0 || manifest.files.length !== 0)
        throw new Error("Recovery target is not empty");
      this.recovery = { id, snapshot };
      await this.ctx.storage.put("recovery", this.recovery);
      await this.ctx.storage.sync();
    }
    await this.ensureRunning();
  }

  async restart(): Promise<void> {
    if (this.retired) throw new Error("Cannot restart a retired generation");
    this.transitioning = true;
    try {
      await this.starting?.catch(() => undefined);
      const container = this.container();
      if (container.running) await this.stopForUpgrade(container);
      await container.destroy("Operator requested cold restart");
    } finally {
      this.transitioning = false;
    }
    await this.ensureRunning();
  }

  private async installBridge(
    container: Container,
    epoch: number,
  ): Promise<void> {
    const bridge = this.ctx.exports.StateBridge({
      props: { owner: this.ctx.id.toString(), epoch },
    });
    await container.interceptOutboundHttp("kitties-state.internal", bridge);
    const backups = this.ctx.exports.BackupBridge({
      props: { owner: this.ctx.id.toString(), epoch },
    });
    await container.interceptOutboundHttp("kitties-backups.internal", backups);
  }

  private async waitForHealth(container: Container): Promise<void> {
    const deadline = Date.now() + READINESS_TIMEOUT_MS;
    let active = true;
    let monitoring = false;
    let stopped: Error | undefined;
    let interrupt: (() => void) | undefined;
    const onStop = () => {
      if (!active) return;
      stopped = new Error("Gateway container stopped before becoming ready");
      interrupt?.();
    };
    try {
      while (Date.now() < deadline) {
        if (this.retired) throw new Error("Gateway generation is retired");
        if (stopped) throw stopped;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5_000);
        interrupt = () => controller.abort();
        try {
          const response = await container
            .getTcpPort(PORT)
            .fetch("http://container/v1/health", {
              headers: { Authorization: `Bearer ${this.env.KITTIES_TOKEN}` },
              signal: controller.signal,
            });
          await response.body?.cancel();
          if (response.ok && !stopped && !this.retired) return;
        } catch {
          /* The port is unavailable while state hydrates. */
        } finally {
          clearTimeout(timeout);
          interrupt = undefined;
        }
        if (stopped) throw stopped;
        // Healthy requests never attach a monitor to the long-lived process.
        if (!monitoring) {
          monitoring = true;
          void container.monitor().then(onStop, onStop);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            interrupt = undefined;
            resolve();
          }, 250);
          interrupt = () => {
            clearTimeout(timer);
            interrupt = undefined;
            resolve();
          };
        });
      }
      throw new Error("Gateway readiness timed out");
    } finally {
      active = false;
      interrupt?.();
    }
  }

  private async stopForUpgrade(container: Container): Promise<void> {
    const stopped = container.monitor().catch(() => undefined);
    container.signal(15);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        stopped,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 120_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (container.running) await container.destroy("Gateway image upgrade");
    // A new epoch is granted only after the old process has actually stopped.
  }

  private container(): Container {
    if (!this.ctx.container) throw new Error("Container binding is missing");
    return this.ctx.container;
  }
}

export class Coordinator extends DurableObject<Env> {
  private readonly recovery: RecoveryCoordinator;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.recovery = new RecoveryCoordinator(
      ctx.storage,
      (generation) => env.GATEWAY.getByName(generation),
      (delay) => ctx.storage.setAlarm(Date.now() + delay),
    );
    ctx.blockConcurrencyWhile(async () => {
      const { operation } = await this.recovery.status();
      if (
        operation &&
        operation.phase !== "complete" &&
        operation.phase !== "failed"
      )
        await ctx.storage.setAlarm(Date.now() + 1);
    });
  }
  async alarm(): Promise<void> {
    await this.recovery.advance();
  }
  async tick(): Promise<void> {
    const { operation } = await this.recovery.status();
    if (
      operation &&
      operation.phase !== "complete" &&
      operation.phase !== "failed"
    )
      await this.recovery.advance();
    else await this.env.GATEWAY.getByName(await this.recovery.active()).wake();
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const operator = "/v1/operator/gateway";
    try {
      if (path === operator && request.method === "GET")
        return Response.json(await this.recovery.status(), {
          headers: { "Cache-Control": "no-store" },
        });
      if (path === `${operator}/restore` && request.method === "POST") {
        const body = await operatorBody(request);
        if (
          !body ||
          typeof body !== "object" ||
          !("operation_id" in body) ||
          !("snapshot_id" in body) ||
          !("confirm" in body) ||
          typeof body.operation_id !== "string" ||
          !/^[a-zA-Z0-9_-]{16,64}$/.test(body.operation_id) ||
          typeof body.snapshot_id !== "string" ||
          !/^[a-f0-9]{64}$/.test(body.snapshot_id) ||
          body.confirm !== `restore ${body.snapshot_id}`
        )
          return Response.json(
            {
              error:
                "Provide operation_id, a full immutable snapshot_id, and confirm: restore <snapshot_id>.",
            },
            { status: 400 },
          );
        const operation = await this.recovery.restore(
          body.operation_id,
          body.snapshot_id,
        );
        return Response.json(operation, {
          status: operation.phase === "complete" ? 200 : 202,
        });
      }
      if (path === `${operator}/restart` && request.method === "POST") {
        const body = await operatorBody(request);
        if (
          !body ||
          typeof body !== "object" ||
          !("confirm" in body) ||
          body.confirm !== "restart gateway"
        )
          return Response.json(
            { error: "Provide confirm: restart gateway." },
            { status: 400 },
          );
        await this.recovery.restart();
        return Response.json({ ok: true });
      }
      if (path.startsWith(operator))
        return new Response("Not found", { status: 404 });
      return this.env.GATEWAY.getByName(await this.recovery.active()).fetch(
        request,
      );
    } catch (error) {
      if (error instanceof RecoveryConflict)
        return Response.json({ error: error.message }, { status: 409 });
      return Response.json(
        {
          error:
            "The gateway operation is unavailable; check its status and retry.",
        },
        { status: 503 },
      );
    }
  }
}

async function operatorBody(request: Request): Promise<unknown> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4096) {
        await reader.cancel();
        return null;
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await env.COORDINATOR.getByName("owner").tick();
  },
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== env.PUBLIC_URL)
      return new Response("Not found", { status: 404 });
    if (!ctx.access)
      return new Response("Cloudflare Access is required", { status: 403 });
    const identity = await ctx.access.getIdentity();
    if (identity?.email?.toLowerCase() !== env.ACCESS_EMAIL.toLowerCase()) {
      return new Response("Access denied", { status: 403 });
    }
    if (!sameOrigin(request, env.PUBLIC_URL))
      return new Response("Use the gateway's own page", { status: 403 });
    if (
      url.pathname === "/v1/local-token" ||
      url.pathname.startsWith("/v1/operator/recovery/")
    )
      return new Response("Not found", { status: 404 });
    const response = await env.COORDINATOR.getByName("owner").fetch(
      gatewayRequest(request, env.KITTIES_TOKEN, env.PUBLIC_URL),
    );
    if (url.pathname === "/v1/session" && response.ok) {
      const session = await response.json<Record<string, unknown>>();
      return Response.json(
        { ...session, logout_url: "/cdn-cgi/access/logout" },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return response;
  },
} satisfies ExportedHandler<Env>;
