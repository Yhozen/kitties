import { DurableObject } from "cloudflare:workers";
import type { Coordinator, Gateway } from "./worker.ts";

interface Env {
  TEST: DurableObjectNamespace<Verification>;
  COORDINATOR: DurableObjectNamespace<Coordinator>;
  GATEWAY: DurableObjectNamespace<Gateway>;
  KITTIES_TOKEN: string;
  PUBLIC_URL: string;
}
interface Kitty {
  id: string;
  name: string;
  status: string;
  error?: string;
}
interface Chat {
  id: string;
  title: string;
  turns:
    | {
        from: string;
        text: string;
        working?: boolean;
        interrupted?: boolean;
      }[]
    | null;
}
interface Run {
  phase: string;
  started: number;
  kitty?: string;
  chat?: string;
  image?: string;
  epoch?: number;
  previous?: string;
  snapshot?: string;
  backupStarted?: number;
  error?: string;
}
const NAME = "cloud-verification";
const TITLE = "Cloud deployment verification";
const ANSWER = "KITTIES_CLOUD_READY";
const OPERATION = "cloud_verification_restore_1";
class Retryable extends Error {}

// This optional, unrouted Worker is removed after deployment acceptance.
export class Verification extends DurableObject<Env> {
  private running: Promise<void> | undefined;
  tick(): Promise<void> {
    if (!this.running)
      this.running = this.step().finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  alarm(): Promise<void> {
    return this.tick();
  }
  private async step(): Promise<void> {
    const run = (await this.ctx.storage.get<Run>("run")) ?? {
      phase: "create",
      started: Date.now(),
    };
    if (run.phase === "complete" || run.phase === "failed") {
      console.log("Kitties cloud verification", JSON.stringify(run));
      return;
    }
    if (Date.now() - run.started > 3 * 60 * 60_000) {
      run.phase = "failed";
      run.error = "Verification exceeded three hours";
    } else
      try {
        delete run.error;
        await this.advance(run);
      } catch (error) {
        run.error =
          error instanceof Error ? error.message : "Verification failed";
        if (!(error instanceof Retryable)) run.phase = "failed";
      }
    await this.ctx.storage.put("run", run);
    await this.ctx.storage.sync();
    if (run.phase !== "complete" && run.phase !== "failed")
      await this.ctx.storage.setAlarm(Date.now() + 10_000);
    console.log("Kitties cloud verification", JSON.stringify(run));
  }
  private async advance(run: Run): Promise<void> {
    const coordinator = this.env.COORDINATOR.getByName("owner");
    if (run.phase === "create") {
      const list = await this.json<{ kitties: Kitty[] }>("/v1/kitties");
      const kitty =
        list.kitties.find((item) => item.name === NAME) ??
        (
          await this.json<{ kitty: Kitty }>("/v1/kitties", "POST", {
            name: NAME,
            desktop: true,
            connectors: ["-"],
            limits: { max_tokens: 8000, max_seconds: 120, max_rounds: 3 },
          })
        ).kitty;
      run.kitty = kitty.id;
      run.phase = "desktop";
    } else if (run.phase === "desktop") {
      const { kitty } = await this.json<{ kitty: Kitty }>(
        `/v1/kitties/${run.kitty}`,
      );
      if (kitty.status === "error")
        throw new Error("Canary desktop failed to start");
      if (kitty.status !== "running") return;
      const result = await this.json<{ output: string }>(
        `/v1/kitties/${run.kitty}/exec`,
        "POST",
        {
          argv: [
            "sh",
            "-lc",
            'printf cloud-ready > /home/kitty/work/cloud-verification.txt; test "$(id -un)" = kitty && cat /home/kitty/work/cloud-verification.txt',
          ],
        },
      );
      if (result.output.trim() !== "cloud-ready")
        throw new Error("Desktop user or persistent workspace check failed");
      const response = await this.request(
        `/v1/kitties/${run.kitty}/screenshot?live=1`,
      );
      const png = new Uint8Array(await response.arrayBuffer());
      if (png.length < 100 || png[0] !== 137 || png[1] !== 80)
        throw new Error("Desktop screenshot is invalid");
      const list = await this.json<{ chats: Chat[] }>("/v1/chats");
      const chat =
        list.chats.find((item) => item.title === TITLE) ??
        (
          await this.json<{ chat: Chat }>("/v1/chats", "POST", {
            title: TITLE,
            members: [run.kitty],
          })
        ).chat;
      run.chat = chat.id;
      run.phase = "model";
    } else if (run.phase === "model") {
      const { chat } = await this.json<{ chat: Chat }>(`/v1/chats/${run.chat}`);
      if ((chat.turns ?? []).length === 0)
        await this.json(`/v1/chats/${run.chat}/messages`, "POST", {
          text: `Reply with exactly ${ANSWER}. Do not use tools.`,
        });
      run.phase = "model-result";
    } else if (run.phase === "model-result") {
      await this.verifyChat(run);
      await this.json(`/v1/kitties/${run.kitty}/stop`, "POST", {});
      run.phase = "stop";
    } else if (run.phase === "stop") {
      const { kitty } = await this.json<{ kitty: Kitty }>(
        `/v1/kitties/${run.kitty}`,
      );
      if (kitty.status === "error") throw new Error("Canary checkpoint failed");
      if (kitty.status !== "stopped") return;
      const status = await this.json<{ active: string }>(
        "/v1/operator/gateway",
      );
      run.previous = status.active;
      const info = await this.env.GATEWAY.getByName(
        status.active,
      ).diagnostics();
      run.image = info.image;
      run.epoch = info.epoch;
      await this.json("/v1/operator/gateway/restart", "POST", {
        confirm: "restart gateway",
      });
      run.phase = "cold-restart";
    } else if (run.phase === "cold-restart") {
      await this.verifyChat(run);
      const info = await this.env.GATEWAY.getByName(
        run.previous!,
      ).diagnostics();
      if (info.epoch <= run.epoch! || info.files === 0)
        throw new Error("Cold restart did not hydrate durable state");
      run.epoch = info.epoch;
      run.phase = "await-image-update";
    } else if (run.phase === "await-image-update") {
      await coordinator.tick();
      await this.verifyChat(run);
      const info = await this.env.GATEWAY.getByName(
        run.previous!,
      ).diagnostics();
      if (info.image === run.image) return;
      if (info.epoch <= run.epoch!)
        throw new Error("Image replacement did not advance its writer epoch");
      run.backupStarted = Date.now();
      await this.json("/v1/backups", "POST", {});
      run.phase = "backup";
    } else if (run.phase === "backup") {
      const status = await this.json<{
        running: boolean;
        snapshot_id?: string;
        last_error?: string;
        last_success?: string;
      }>("/v1/backups/status");
      if (status.running) return;
      if (
        status.last_error ||
        !status.last_success ||
        Date.parse(status.last_success) < run.backupStarted!
      )
        throw new Error("The requested independent backup did not complete");
      if (!status.snapshot_id || !/^[a-f0-9]{64}$/.test(status.snapshot_id))
        throw new Error(
          "Independent encrypted backup did not produce a full snapshot ID",
        );
      run.snapshot = status.snapshot_id;
      await this.json("/v1/operator/gateway/restore", "POST", {
        operation_id: OPERATION,
        snapshot_id: run.snapshot,
        confirm: `restore ${run.snapshot}`,
      });
      run.phase = "restore";
    } else if (run.phase === "restore") {
      const status = await this.json<{
        active: string;
        operation?: { phase: string };
      }>("/v1/operator/gateway");
      if (status.operation?.phase === "failed")
        throw new Error("Cloud recovery preflight failed");
      if (status.operation?.phase !== "complete") return;
      if (status.active === run.previous)
        throw new Error("Recovery did not replace the gateway generation");
      await this.verifyChat(run);
      const old = this.env.GATEWAY.getByName(run.previous!);
      const info = await old.diagnostics();
      if (!info.retired || info.running)
        throw new Error("Recovery left the old writer active");
      let fenced = false;
      try {
        await old.wake();
      } catch {
        fenced = true;
      }
      if (!fenced) throw new Error("A retired writer can be restarted");
      run.phase = "complete";
    }
  }
  private async verifyChat(run: Run): Promise<void> {
    const { chat } = await this.json<{ chat: Chat }>(`/v1/chats/${run.chat}`);
    if (
      !(chat.turns ?? []).some(
        (turn) =>
          turn.from !== "user" &&
          turn.text.includes(ANSWER) &&
          !turn.working &&
          !turn.interrupted,
      )
    )
      throw new Retryable("The live model response is pending");
  }
  private async request(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<Response> {
    const response = await this.env.COORDINATOR.getByName("owner").fetch(
      new Request(`${this.env.PUBLIC_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.env.KITTIES_TOKEN}`,
          "Content-Type": "application/json",
          Origin: this.env.PUBLIC_URL,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      const Failure =
        response.status === 503 || response.status === 409 ? Retryable : Error;
      throw new Failure(`Canary ${method} ${path} returned ${response.status}`);
    }
    return response;
  }
  private async json<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    return (await this.request(path, method, body)).json<T>();
  }
}

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await env.TEST.getByName("acceptance-v2").tick();
  },
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
