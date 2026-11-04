import { makeDesktopFiles } from "./desktop-files.ts";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { chatEvents } from "./chat-stream.ts";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { HomeDO, KittyDO, ChatDO } from "./actors.ts";
import {
  ProviderInput,
  KittyInput,
  ChatInput,
  MessageInput,
  ConnectionInput,
  type Provider,
  type KittyProfile,
  type ChatProfile,
  type Connection,
  type ApprovalRecord,
} from "./entities.ts";
import { ComputerOp } from "./computer-definition.ts";
import { makeComputerResume } from "./computer-resume.ts";
import { Turn } from "./turn-definition.ts";
import { DesktopAttempt } from "./desktop-definition.ts";
import { Approval, ApprovalDecision } from "./approval-definition.ts";
import { WorkflowEngine } from "effect/workflow";
import { seal, open } from "./secrets.ts";
import { providerBaseUrl, providerVerificationRequest } from "./providers.ts";
import { allowedFetch } from "./outbound.ts";
import { publicHttps } from "./outbound.ts";
import { discoverTools } from "./tools.ts";
import { readBody } from "./request.ts";
import { makeOwnerData } from "./owner-data.ts";
import { makeWorkspaceData } from "./workspace-data.ts";
import { makeAutonomy } from "./autonomy.ts";
import { nativeBase } from "./native-tools.ts";
import { makeRecovery } from "./recovery.ts";
import { makeChatgpt } from "./chatgpt.ts";
import { makeOAuth } from "./oauth.ts";
import { makeNotifications } from "./notifications.ts";

const json = (body: unknown, status = 200) =>
  HttpServerResponse.fromWeb(
    Response.json(body, { status, headers: { "Cache-Control": "no-store" } }),
  );
const viewProvider = (provider: Provider) => ({
  ...provider,
  secret: undefined,
  hasKey: !!provider.secret,
});

export const makeApplication = Effect.gen(function* () {
  const homes = yield* HomeDO,
    kitties = yield* KittyDO,
    chats = yield* ChatDO;
  const computers = yield* Workflows.RunWorkflow(ComputerOp);
  const resumeComputer = yield* makeComputerResume;
  const turns = yield* Workflows.RunWorkflow(Turn);
  const desktops = yield* Workflows.RunWorkflow(DesktopAttempt);
  const approvals = yield* Workflows.RunWorkflow(Approval);
  const engine = yield* WorkflowEngine.WorkflowEngine;
  const workspaceData = yield* makeWorkspaceData;
  const ownerData = yield* makeOwnerData;
  const desktopFiles = yield* makeDesktopFiles;
  const autonomy = yield* makeAutonomy;
  const notifications = yield* makeNotifications;
  const oauth = yield* makeOAuth;
  const chatgpt = yield* makeChatgpt;
  const recovery = yield* makeRecovery;
  const env = (yield* Cloudflare.WorkerEnvironment) as {
    KITTIES_KEK: string;
    STAGE: string;
    CHATGPT_ENABLED: string;
  };
  const home = () => homes.getByName("owner", { locationHint: "weur" });
  const list = <A>(kind: string) =>
    home()
      .list(kind)
      .pipe(Effect.map((rows) => rows.map((row) => JSON.parse(row.body) as A)));
  return (request: Request) =>
    Effect.gen(function* () {
      const url = new URL(request.url),
        path = url.pathname,
        method = request.method;
      const recoveryResponse = yield* recovery.route(request);
      if (recoveryResponse) return recoveryResponse;
      if (path.startsWith("/v1/") && method !== "GET" && !(yield* recovery.ready()))
        return json({ code: "RECOVERY_IN_PROGRESS", params: {} }, 503);
      const signInResponse = yield* chatgpt(request);
      if (signInResponse) return signInResponse;
      const oauthResponse = yield* oauth.route(request);
      if (oauthResponse) return oauthResponse;
      if (
        method === "GET" &&
        /^\/v1\/kitties\/[^/]+\/files(?:\/|$)/.test(path) &&
        !(yield* recovery.ready())
      )
        return json({ code: "RECOVERY_IN_PROGRESS", params: {} }, 503);
      const filesResponse = yield* desktopFiles(request);
      if (filesResponse) return filesResponse;
      const ownerResponse = yield* ownerData(request);
      if (ownerResponse) return ownerResponse;
      const workspaceResponse = yield* workspaceData(request);
      if (workspaceResponse) return workspaceResponse;
      const autonomyResponse = yield* autonomy.route(request);
      if (autonomyResponse) return autonomyResponse;
      const notificationResponse = yield* notifications.route(request);
      if (notificationResponse) return notificationResponse;
      const computerRoute = path.match(
        /^\/v1\/kitties\/([a-zA-Z0-9_-]{1,128})\/computer(?:\/(start|sleep|restore|delete|resume|upgrade|repair))?$/,
      );
      if (computerRoute) {
        const id = computerRoute[1]!,
          kitty = kitties.getByName(id, { locationHint: "weur" });
        if (!(yield* home().read("kitty", id)))
          return json({ code: "KITTY_NOT_FOUND", params: {} }, 404);
        if (method === "GET" && !computerRoute[2])
          return json({ state: yield* kitty.computer(), channel: yield* kitty.status() });
        if (method === "POST" && computerRoute[2]) {
          const body = yield* readBody(
            request,
            Schema.Struct({
              operationId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/)),
            }),
          );
          if (computerRoute[2] === "resume") {
            const run = yield* resumeComputer(id, body.operationId);
            return run ? json(run, 202) : json({ code: "NOT_FOUND", params: {} }, 404);
          }
          if (computerRoute[2] === "repair") {
            // Only a suspended run may be replaced; a live run keeps its operation.
            const state = yield* kitty.computer();
            const stuck = state?.operation;
            if (!stuck) return json({ code: "NOTHING_TO_REPAIR", params: {} }, 409);
            const saved = yield* home().read("computer-run", stuck.id);
            const runId = saved ? (JSON.parse(saved) as { executionId: string }).executionId : null;
            const health = runId ? yield* home().read("run-health", runId) : null;
            if (!health || (JSON.parse(health) as { status?: string }).status !== "suspended")
              return json({ code: "RUN_NOT_SUSPENDED", params: {} }, 409);
            yield* kitty
              .abandonComputer(stuck.id)
              .pipe(Effect.mapError(() => "COMPUTER_BUSY_OR_INVALID_STATE"));
            yield* kitty
              .beginComputer(id, body.operationId, stuck.kind)
              .pipe(Effect.mapError(() => "COMPUTER_BUSY_OR_INVALID_STATE"));
            const run = yield* computers.start({
              kittyId: id,
              operationId: body.operationId,
              kind: stuck.kind,
            });
            yield* home().write(
              "computer-run",
              body.operationId,
              JSON.stringify({ executionId: run.executionId, kittyId: id, kind: stuck.kind }),
            );
            return json({ executionId: run.executionId, replaced: stuck.id }, 202);
          }
          const kind = computerRoute[2] as "start" | "sleep" | "restore" | "delete" | "upgrade";
          // Claim synchronously: concurrent owner/idle requests must report busy
          // before a workflow journals a terminal begin failure.
          yield* kitty
            .beginComputer(id, body.operationId, kind)
            .pipe(Effect.mapError(() => "COMPUTER_BUSY_OR_INVALID_STATE"));
          const run = yield* computers.start({ kittyId: id, operationId: body.operationId, kind });
          yield* home().write(
            "computer-run",
            body.operationId,
            JSON.stringify({ executionId: run.executionId, kittyId: id, kind }),
          );
          return json({ executionId: run.executionId }, 202);
        }
      }
      const computerRun = path.match(/^\/v1\/computer-runs\/([a-f0-9]{32})$/);
      if (computerRun && method === "GET")
        return json(yield* computers.get(computerRun[1]!).status);
      if (path === "/v1/releases/kittyd" && method === "PUT") {
        const body = yield* readBody(
          request,
          Schema.Struct({
            key: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}\.tgz$/)),
            sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
          }),
        );
        if (body.key !== body.sha256 + ".tgz")
          return json({ code: "INVALID_RELEASE", params: {} }, 400);
        yield* home().write("release", "kittyd", JSON.stringify(body));
        return json({ ok: true });
      }
      if (path === "/v1/connections" && method === "GET")
        return json(
          (yield* list<Connection>("connection")).map(({ secret, ...value }) => ({
            ...value,
            hasToken: !!secret,
          })),
        );
      const connectionRoute = path.match(
        /^\/v1\/connections\/([a-zA-Z0-9_-]{1,128})(?:\/(test))?$/,
      );
      if (connectionRoute) {
        const id = connectionRoute[1]!,
          saved = yield* home().read("connection", id);
        if (method === "PUT" && !connectionRoute[2]) {
          const body = yield* readBody(request, ConnectionInput);
          yield* Effect.try({
            try: () => {
              const url = publicHttps(body.url);
              if (url.search) throw Error();
              if (
                (body.kind === "google" || body.kind === "m365") &&
                body.url !== nativeBase[body.kind]
              )
                throw Error();
            },
            catch: () => "HOST_DENIED",
          });
          const { token, ...config } = body;
          const secret = token
            ? yield* Effect.tryPromise({
                try: () => seal(env.KITTIES_KEK, `connections:${id}:token`, token),
                catch: () => "KEY_UNAVAILABLE",
              })
            : saved
              ? (JSON.parse(saved) as Connection).secret
              : undefined;
          if (saved) {
            const old = JSON.parse(saved) as Connection;
            if (old.url !== config.url || old.kind !== config.kind || token)
              yield* home().oauthDisconnect(id);
          }
          const connection: Connection = { ...config, id, ...(secret ? { secret } : {}) };
          yield* home().write("connection", id, JSON.stringify(connection));
          return json({ ...config, id, hasToken: !!secret });
        }
        if (method === "DELETE" && !connectionRoute[2]) {
          yield* home().oauthDisconnect(id);
          yield* home().remove("connection", id);
          return HttpServerResponse.empty({ status: 204 });
        }
        if (method === "POST" && connectionRoute[2] === "test") {
          if (!saved) return json({ code: "NOT_FOUND", params: {} }, 404);
          const connection = JSON.parse(saved) as Connection;
          const oauthStatus = yield* home().oauthStatus(id);
          const token =
            oauthStatus !== "disconnected"
              ? yield* home().oauthToken(id, connection.url)
              : connection.secret
                ? yield* Effect.tryPromise({
                    try: () => open(env.KITTIES_KEK, `connections:${id}:token`, connection.secret!),
                    catch: () => "KEY_UNAVAILABLE",
                  })
                : undefined;
          return json({ tools: yield* discoverTools(connection, token) });
        }
      }
      if (path === "/v1/approvals" && method === "GET")
        return json(yield* list<ApprovalRecord>("approval"));
      const approvalRoute = path.match(/^\/v1\/approvals\/([^/]+)\/decision$/);
      if (approvalRoute && method === "POST") {
        const id = decodeURIComponent(approvalRoute[1]!);
        const body = yield* readBody(
          request,
          Schema.Struct({ approved: Schema.Boolean, digest: Schema.String }),
        );
        const record = yield* home().decideApproval(id, body.approved, body.digest);
        if (!record) return json({ code: "APPROVAL_CONFLICT", params: {} }, 409);
        yield* approvals.get(record.executionId).signal(ApprovalDecision, body.approved);
        return json({ ok: true });
      }
      if (path === "/v1/runs" && method === "GET") return json(yield* list("run-health"));
      const runStatus = path.match(/^\/v1\/runs\/([a-f0-9]{32})$/);
      if (runStatus && method === "GET") return json(yield* turns.get(runStatus[1]!).status);
      const approvalStatus = path.match(/^\/v1\/approvals\/([^/]+)$/);
      if (approvalStatus && method === "GET") {
        const saved = yield* home().read("approval", decodeURIComponent(approvalStatus[1]!));
        if (!saved) return json({ code: "NOT_FOUND", params: {} }, 404);
        const record = JSON.parse(saved) as ApprovalRecord;
        return json({ ...record, workflow: yield* approvals.get(record.executionId).status });
      }
      if (path === "/v1/providers" && method === "GET")
        return json((yield* list<Provider>("provider")).map(viewProvider));
      const providerRoute = path.match(/^\/v1\/providers\/([a-zA-Z0-9_-]{1,128})(?:\/(test))?$/);
      if (providerRoute) {
        const id = providerRoute[1]!;
        const saved = yield* home().read("provider", id);
        if (method === "PUT" && !providerRoute[2]) {
          const body = yield* readBody(request, ProviderInput);
          if (body.kind === "chatgpt") return json({ code: "FEATURE_DISABLED", params: {} }, 404);
          yield* Effect.try({ try: () => providerBaseUrl(body), catch: () => "HOST_DENIED" });
          const { apiKey, ...config } = body;
          const old = saved ? (JSON.parse(saved) as Provider) : null;
          const secret = apiKey
            ? yield* Effect.tryPromise({
                try: () => seal(env.KITTIES_KEK, `providers:${id}:api-key`, apiKey),
                catch: () => "KEY_UNAVAILABLE",
              })
            : old?.secret;
          const provider: Provider = { ...config, id, ...(secret ? { secret } : {}) };
          yield* home().write("provider", id, JSON.stringify(provider));
          return json(viewProvider(provider));
        }
        if (method === "DELETE" && !providerRoute[2]) {
          yield* home().remove("provider", id);
          return HttpServerResponse.empty({ status: 204 });
        }
        if (method === "POST" && providerRoute[2] === "test") {
          if (!saved) return json({ code: "NOT_FOUND", params: {} }, 404);
          const provider = JSON.parse(saved) as Provider;
          if (provider.kind === "chatgpt")
            return json({ code: "FEATURE_DISABLED", params: {} }, 404);
          if (!provider.secret) return json({ code: "PROVIDER_KEY_REQUIRED", params: {} }, 400);
          const secret = yield* Effect.tryPromise({
            try: () => open(env.KITTIES_KEK, `providers:${id}:api-key`, provider.secret!),
            catch: () => "KEY_UNAVAILABLE",
          });
          const { base, endpoint, headers } = providerVerificationRequest(provider, secret);
          const response = yield* Effect.tryPromise({
            try: () =>
              allowedFetch(endpoint, [new URL(base).hostname], {
                headers,
              }),
            catch: () => "PROVIDER_UNAVAILABLE",
          });
          if (!response.ok)
            return json(
              { code: "PROVIDER_UNAVAILABLE", params: { status: String(response.status) } },
              400,
            );
          const data = yield* Effect.tryPromise({
            try: () =>
              response.json() as Promise<{ data?: { id: string }[]; models?: { name: string }[] }>,
            catch: () => "PROVIDER_UNAVAILABLE",
          });
          return json({
            ok: true,
            models:
              data.data?.map((model) => model.id) ?? data.models?.map((model) => model.name) ?? [],
          });
        }
      }
      if (path === "/v1/kitties" && method === "GET") {
        const profiles = yield* list<KittyProfile>("kitty");
        return json(
          yield* Effect.forEach(
            profiles,
            (kitty) =>
              kitties
                .getByName(kitty.id, { locationHint: "weur" })
                .status()
                .pipe(
                  Effect.map((status) => ({
                    ...kitty,
                    status: status.guestConnected ? "running" : "created",
                  })),
                ),
            { concurrency: 5 },
          ),
        );
      }
      if (path === "/v1/kitties" && method === "POST") {
        const body = yield* readBody(request, KittyInput),
          id = crypto.randomUUID();
        const kitty: KittyProfile = { ...body, id, createdAt: Date.now() };
        yield* home().write("kitty", id, JSON.stringify(kitty));
        return json({ ...kitty, status: "created" }, 201);
      }
      const kittyRoute = path.match(/^\/v1\/kitties\/([a-zA-Z0-9_-]{1,128})$/);
      if (kittyRoute) {
        const id = kittyRoute[1]!,
          saved = yield* home().read("kitty", id);
        if (!saved) return json({ code: "NOT_FOUND", params: {} }, 404);
        if (method === "PUT") {
          const body = yield* readBody(request, KittyInput),
            old = JSON.parse(saved) as KittyProfile;
          const kitty = { ...body, id, createdAt: old.createdAt };
          yield* home().write("kitty", id, JSON.stringify(kitty));
          return json({ ...kitty, status: "created" });
        }
        if (method === "DELETE") {
          // Lifecycle deletion must verify a checkpoint before this record is removed.
          const status = yield* kitties.getByName(id, { locationHint: "weur" }).status();
          const computer = yield* kitties.getByName(id, { locationHint: "weur" }).computer();
          if (status.config && computer?.phase !== "deleted")
            return json({ code: "DESKTOP_DELETE_REQUIRED", params: {} }, 409);
          yield* home().remove("kitty", id);
          return HttpServerResponse.empty({ status: 204 });
        }
      }
      if (path === "/v1/chats" && method === "GET") return json(yield* list<ChatProfile>("chat"));
      if (path === "/v1/chats" && method === "POST") {
        const body = yield* readBody(request, ChatInput);
        for (const member of body.members)
          if (!(yield* home().read("kitty", member)))
            return json({ code: "KITTY_NOT_FOUND", params: {} }, 400);
        const chat: ChatProfile = { ...body, id: crypto.randomUUID(), createdAt: Date.now() };
        yield* home().write("chat", chat.id, JSON.stringify(chat));
        return json(chat, 201);
      }
      const chatRoute = path.match(
        /^\/v1\/chats\/([a-zA-Z0-9_-]{1,128})(?:\/(messages|events|cancel|resume|replay))?$/,
      );
      if (chatRoute) {
        const id = chatRoute[1]!,
          saved = yield* home().read("chat", id);
        if (!saved) return json({ code: "NOT_FOUND", params: {} }, 404);
        const profile = JSON.parse(saved) as ChatProfile,
          chat = chats.getByName(id, { locationHint: "weur" });
        if (method === "PUT" && !chatRoute[2]) {
          const body = yield* readBody(request, ChatInput);
          for (const member of body.members)
            if (!(yield* home().read("kitty", member)))
              return json({ code: "KITTY_NOT_FOUND", params: {} }, 400);
          const updated = { ...profile, ...body };
          yield* home().write("chat", id, JSON.stringify(updated));
          return json(updated);
        }
        if (method === "DELETE" && !chatRoute[2]) {
          for (const runId of yield* chat.retire()) yield* turns.get(runId).interrupt;
          yield* home().remove("chat", id);
          return HttpServerResponse.empty({ status: 204 });
        }
        if (method === "GET" && chatRoute[2] === "replay") return json(yield* chat.replay());
        if (method === "GET" && !chatRoute[2]) {
          const before = url.searchParams.get("before") ?? undefined;
          if (before !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(before))
            return json({ code: "INVALID_MESSAGE_ID", params: {} }, 400);
          return json({ ...profile, ...(yield* chat.snapshot(before)) });
        }
        if (method === "POST" && chatRoute[2] === "messages") {
          const body = yield* readBody(request, MessageInput);
          if (!profile.members.includes(body.kittyId))
            return json({ code: "KITTY_NOT_IN_CHAT", params: {} }, 400);
          const result = yield* chat.enqueue({ ...body, chatId: id });
          if (result.conflict) return json({ code: "MESSAGE_CONFLICT", params: {} }, 409);
          return json({ duplicate: result.duplicate }, 202);
        }
        if (method === "GET" && chatRoute[2] === "events") {
          const cursor =
            request.headers.get("Last-Event-ID") ?? url.searchParams.get("after") ?? "0";
          if (!/^\d{1,12}$/.test(cursor)) return json({ code: "INVALID_REQUEST", params: {} }, 400);
          const stream = chatEvents((after) => chat.events(after), Number(cursor));
          return HttpServerResponse.stream(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-store",
              "X-Accel-Buffering": "no",
            },
          });
        }
        if (method === "POST" && (chatRoute[2] === "cancel" || chatRoute[2] === "resume")) {
          const body = yield* readBody(request, Schema.Struct({ messageId: Schema.String }));
          const row = yield* chat.run(body.messageId);
          if (!row) return json({ code: "NOT_FOUND", params: {} }, 404);
          if (chatRoute[2] === "cancel") {
            yield* chat.finish(body.messageId, "cancelled");
            for (const entry of yield* home().list("desktop-help")) {
              const help = JSON.parse(entry.body) as {
                chatId: string;
                messageId: string;
                executionId: string;
                status: string;
              };
              if (
                help.chatId !== id ||
                help.messageId !== body.messageId ||
                help.status !== "pending"
              )
                continue;
              yield* home().write(
                "desktop-help",
                entry.id,
                JSON.stringify({ ...help, status: "cancelled" }),
              );
              yield* desktops.get(help.executionId).interrupt;
            }
            for (const record of yield* list<ApprovalRecord>("approval")) {
              if (
                record.messageId !== body.messageId ||
                record.chatId !== id ||
                record.status !== "pending"
              )
                continue;
              yield* home().write(
                "approval",
                record.id,
                JSON.stringify({ ...record, status: "cancelled" }),
              );
              yield* approvals.get(record.executionId).signal(ApprovalDecision, false);
            }
            const cancelled = new Set([`${id}:${body.messageId}`]);
            const children = (yield* home().list("delegation-child")).map(
              (child) =>
                JSON.parse(child.body) as {
                  chatId: string;
                  messageId: string;
                  parentChatId: string;
                  parentMessageId: string;
                },
            );
            for (let depth = 0; depth < 2; depth++)
              for (const child of children) {
                if (
                  !cancelled.has(`${child.parentChatId}:${child.parentMessageId}`) ||
                  cancelled.has(`${child.chatId}:${child.messageId}`)
                )
                  continue;
                cancelled.add(`${child.chatId}:${child.messageId}`);
                const actor = chats.getByName(child.chatId, { locationHint: "weur" }),
                  run = yield* actor.run(child.messageId);
                yield* actor.finish(child.messageId, "cancelled");
                if (run?.run_id) yield* turns.get(run.run_id).interrupt;
              }
            if (row.run_id) yield* turns.get(row.run_id).interrupt;
          } else if (row.run_id)
            yield* Turn.resume(row.run_id).pipe(
              Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
            );
          return json({ ok: true });
        }
      }
      return undefined;
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          json(
            { code: typeof error === "string" ? error : "UNAVAILABLE", params: {} },
            typeof error === "string" ? 400 : 503,
          ),
        ),
      ),
    );
});
