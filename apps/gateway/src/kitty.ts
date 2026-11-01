import { makeStorageAdmin } from "./storage-admin.ts";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import type * as cf from "@cloudflare/workers-types";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";
import { Action, Ack } from "@kitties/protocol";
import { canGrant, validGrant, type Fence, type Grant } from "./control.ts";
import {
  beginOperation,
  freshComputer,
  type ComputerState,
  type ComputerOperation,
} from "./computer-state.ts";

export interface GuestConfig extends Fence {
  tokenHash: string;
  tokenVersion: number;
}
interface Session {
  role: "guest" | "guest-frames" | "owner" | "viewer";
  clientId: string;
  epoch: number;
  outstanding?: number;
  count?: number;
  window?: number;
}
interface Ledger {
  [key: string]: string | number | null;
  id: string;
  generation: number;
  epoch: number;
  source: string;
  client_id: string;
  status: string;
  result: string | null;
  body: string;
  created_at: number;
}
export const sha256 = async (value: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

export class KittyDO extends Cloudflare.DurableObject<KittyDO>()(
  "KittyDO",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const env = (yield* Cloudflare.WorkerEnvironment) as {
      BLOBS: cf.R2Bucket;
      KITTIES_KEK: string;
    };
    return Effect.sync(() => {
      const heartbeat = globalThis as unknown as {
        WebSocketRequestResponsePair: new (
          request: string,
          response: string,
        ) => Parameters<typeof state.raw.setWebSocketAutoResponse>[0];
      };
      state.raw.setWebSocketAutoResponse(
        new heartbeat.WebSocketRequestResponsePair("ping", "pong"),
      );
      const sql = state.raw.storage.sql;
      sql.exec("CREATE TABLE IF NOT EXISTS kitty_state (key TEXT PRIMARY KEY, body TEXT NOT NULL)");
      sql.exec(
        "CREATE TABLE IF NOT EXISTS effect_ledger (id TEXT PRIMARY KEY,generation INTEGER NOT NULL,epoch INTEGER NOT NULL,source TEXT NOT NULL,client_id TEXT NOT NULL,status TEXT NOT NULL,result TEXT,body TEXT NOT NULL,created_at INTEGER NOT NULL)",
      );
      const read = <A>(key: string): A | null => {
        const row = sql
          .exec<{ body: string }>("SELECT body FROM kitty_state WHERE key=?", key)
          .toArray()[0];
        return row ? (JSON.parse(row.body) as A) : null;
      };
      const write = (key: string, value: unknown) => {
        sql.exec(
          "INSERT INTO kitty_state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body",
          key,
          JSON.stringify(value),
        );
      };
      const config = () => read<GuestConfig>("config");
      const scheduleAt = (at: number) => {
        const previous = read<number>("wake");
        if (previous === null || at < previous) {
          write("wake", at);
          state.raw.storage.setAlarm(at).catch(() => {});
        }
      };
      // Hibernated peers can remain CLOSING after a VM is archived. They must
      // not consume admission slots or keep idle/viewer leases alive.
      const sockets = (role: string) =>
        state.raw.getWebSockets(role).filter((socket) => socket.readyState === 1);
      const send = (socket: Cloudflare.RawWebSocket, body: unknown) =>
        socket.send(JSON.stringify(body));
      const publish = (body: unknown) => {
        for (const ws of sockets("owner"))
          try {
            send(ws, body);
          } catch {
            /* Closing peers are pruned by the platform. */
          }
      };
      const revoke = () => {
        write("grant", null);
        publish({ type: "control_revoked" });
      };
      const pending = (source?: string) =>
        sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM effect_ledger WHERE status='started'${source ? " AND source=?" : ""}`,
            ...(source ? [source] : []),
          )
          .toArray()[0]!.count;
      const bump = () => {
        const c = config();
        if (c) {
          c.epoch++;
          write("config", c);
        }
        revoke();
        return c;
      };
      const waiting = new Map<string, Set<() => void>>();
      const safeAction = (action: typeof Action.Type) =>
        JSON.stringify(
          action.action === "type_secret" ? { ...action, args: { ref: action.args.ref } } : action,
        );
      const finish = (
        id: string,
        status: string,
        result: string | null,
        timings?: typeof Ack.Type.timings,
      ) => {
        sql.exec(
          "UPDATE effect_ledger SET status=?,result=? WHERE id=? AND (status='started' OR (status='unknown' AND ? IN ('completed','failed')))",
          status,
          result,
          id,
          status,
        );
        for (const resolve of waiting.get(id) ?? []) resolve();
        waiting.delete(id);
        const row = sql.exec<Ledger>("SELECT * FROM effect_ledger WHERE id=?", id).toArray()[0];
        publish({
          type: "ack",
          intentId: id,
          status,
          result,
          timings: timings
            ? { ...timings, doReceivedAt: row?.created_at, doAckAt: Date.now() }
            : undefined,
        });
        const grant = read<Grant>("grant");
        if (grant?.draining && pending("owner") === 0) revoke();
      };
      const peers = () => {
        const count = sockets("viewer").length;
        for (const guest of sockets("guest")) send(guest, { type: "viewers", count });
      };
      const dispatch = (
        action: typeof Action.Type,
        source: "owner" | "agent",
        clientId: string,
      ) => {
        const c = config();
        const computer = read<ComputerState>("computer");
        if (
          computer &&
          ["draining", "archiving", "sleeping", "restoring", "deleting", "deleted"].includes(
            computer.phase,
          ) &&
          action.action !== "quiesce"
        )
          throw Error("COMPUTER_DRAINING");
        if (
          !c ||
          action.generation !== c.generation ||
          action.epoch !== c.epoch ||
          action.deadline <= Date.now() ||
          action.deadline > Date.now() + 60000
        )
          throw Error("FENCED");
        const existing = sql
          .exec<Ledger>("SELECT * FROM effect_ledger WHERE id=?", action.intentId)
          .toArray()[0];
        if (existing) {
          if (
            existing.body !== safeAction(action) ||
            existing.source !== source ||
            existing.client_id !== clientId
          )
            throw Error("INTENT_CONFLICT");
          return { status: existing.status, result: existing.result };
        }
        if (source === "agent" && (read<Grant>("grant") || pending("owner") > 0))
          return { status: "held", result: null };
        const guest = sockets("guest").find(
          (ws) =>
            ws.readyState === 1 &&
            (ws.deserializeAttachment() as Session | null)?.epoch === c.epoch,
        );
        if (!guest) throw Error("GUEST_OFFLINE");
        // Commit before writing to the network. Reconnect reconciles this row; it never re-sends it.
        sql.exec(
          "INSERT INTO effect_ledger VALUES (?,?,?,?,?,'started',NULL,?,?)",
          action.intentId,
          c.generation,
          c.epoch,
          source,
          clientId,
          safeAction(action),
          Date.now(),
        );
        scheduleAt(action.deadline);
        try {
          send(guest, action);
        } catch {
          revoke();
          return { status: "started", result: null };
        }
        return { status: "started", result: null };
      };
      return {
        computer: () => Effect.sync(() => read<ComputerState>("computer")),
        ...makeStorageAdmin(state, env.KITTIES_KEK, ["kitty_state", "effect_ledger"]),
        beginComputer: (kittyId: string, id: string, kind: ComputerOperation["kind"]) =>
          Effect.sync(() => {
            const current = read<ComputerState>("computer") ?? freshComputer(kittyId, Date.now());
            if (
              (kind === "sleep" || kind === "delete") &&
              (sockets("viewer").some((socket) => socket.readyState === 1) ||
                read<Grant>("grant") ||
                pending() > 0)
            )
              throw Error("COMPUTER_IN_USE");
            const next = beginOperation(current, id, kind, Date.now());
            write("computer", next);
            if (
              next !== current &&
              (kind === "start" || kind === "restore" || kind === "upgrade")
            ) {
              const c = bump();
              if (c) {
                c.tokenVersion = next.tokenVersion;
                c.tokenHash = "";
                write("config", c);
              }
              for (const socket of [...sockets("guest"), ...sockets("guest-frames")])
                socket.close(1012, "Lifecycle operation");
            }
            return next;
          }),
        updateComputer: (operationId: string, body: string) =>
          Effect.sync(() => {
            const current = read<ComputerState>("computer"),
              next = JSON.parse(body) as ComputerState;
            if (
              current?.operation?.id !== operationId ||
              next.kittyId !== current.kittyId ||
              next.generation < current.generation
            )
              throw Error("OPERATION_FENCED");
            write("computer", next);
            return next;
          }),
        renewComputer: (remoteId: string, at: number) =>
          Effect.sync(() => {
            const current = read<ComputerState>("computer");
            if (current?.remoteId === remoteId) {
              current.lastRenewAt = at;
              write("computer", current);
            }
          }),
        touchComputer: () =>
          Effect.sync(() => {
            const current = read<ComputerState>("computer");
            if (current) {
              current.lastActiveAt = Date.now();
              write("computer", current);
            }
          }),
        configure: (next: Omit<GuestConfig, "epoch">) =>
          Effect.sync(() => {
            const old = config();
            if (old && next.generation < old.generation) throw Error("STALE_GENERATION");
            if (
              old &&
              old.kittyId === next.kittyId &&
              old.remoteId === next.remoteId &&
              old.generation === next.generation &&
              old.tokenVersion === next.tokenVersion &&
              old.tokenHash === next.tokenHash
            )
              return { epoch: old.epoch };
            const c = { ...next, epoch: (old?.epoch ?? 0) + 1 };
            state.raw.storage.transactionSync(() => {
              write("config", c);
              write("grant", null);
              if (old && old.generation !== c.generation)
                sql.exec("UPDATE effect_ledger SET status='unknown' WHERE status='started'");
            });
            for (const ws of [...sockets("guest"), ...sockets("guest-frames")])
              ws.close(1012, "Credentials rotated");
            publish({ type: "control_revoked" });
            return { epoch: c.epoch };
          }),
        recoveryFence: (epoch: number) =>
          Effect.sync(() => {
            if ((read<number>("restoredEpoch") ?? 0) >= epoch) return;
            write("restoredEpoch", epoch);
            const c = bump();
            if (c) {
              c.tokenVersion++;
              c.tokenHash = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
                b.toString(16).padStart(2, "0"),
              ).join("");
              write("config", c);
            }
            for (const ws of [...sockets("guest"), ...sockets("guest-frames")])
              ws.close(1012, "Recovery requires fresh credentials");
            const computer = read<ComputerState>("computer");
            if (computer)
              write("computer", {
                ...computer,
                tokenVersion: c?.tokenVersion ?? computer.tokenVersion + 1,
                operation: undefined,
                phase: ["sleeping", "deleted", "absent"].includes(computer.phase)
                  ? computer.phase
                  : "attention",
              });
            sql.exec("UPDATE effect_ledger SET status='unknown' WHERE status='started'");
          }),
        status: () =>
          Effect.sync(() => ({
            config: config() ? { ...config()!, tokenHash: undefined } : null,
            channelVersion: "open-peers-v2",
            guestConnected: sockets("guest").some(
              (ws) =>
                ws.readyState === 1 &&
                (ws.deserializeAttachment() as Session | null)?.epoch === config()?.epoch,
            ),
            guestConnections: sockets("guest").map((ws) => ({
              readyState: ws.readyState,
              epoch: (ws.deserializeAttachment() as Session | null)?.epoch,
            })),
            viewers: sockets("viewer").length,
            grant: read<Grant>("grant"),
            pending: pending(),
          })),
        agentAction: (
          intentId: string,
          name: typeof Action.Type.action,
          args: Record<string, unknown>,
        ) =>
          Effect.tryPromise({
            try: async () => {
              const saved = sql
                .exec<Ledger>("SELECT * FROM effect_ledger WHERE id=?", intentId)
                .toArray()[0];
              if (saved) {
                const previous = JSON.parse(saved.body) as typeof Action.Type;
                if (
                  saved.source !== "agent" ||
                  previous.action !== name ||
                  JSON.stringify(previous.args) !==
                    JSON.stringify(name === "type_secret" ? { ref: args.ref } : args)
                )
                  throw Error("INTENT_CONFLICT");
              } else {
                const c = config();
                if (!c) throw Error("GUEST_OFFLINE");
                const result = dispatch(
                  {
                    type: "action",
                    intentId,
                    generation: c.generation,
                    epoch: c.epoch,
                    deadline: Date.now() + 60000,
                    action: name,
                    args,
                  },
                  "agent",
                  "workflow",
                );
                if (result.status === "held") return result;
              }
              const row = () =>
                sql.exec<Ledger>("SELECT * FROM effect_ledger WHERE id=?", intentId).toArray()[0]!;
              if (row().status === "started")
                await new Promise<void>((resolve) => {
                  const done = () => {
                    clearTimeout(timer);
                    waiting.get(intentId)?.delete(done);
                    resolve();
                  };
                  const timer = setTimeout(done, 650);
                  if (!waiting.has(intentId)) waiting.set(intentId, new Set());
                  waiting.get(intentId)!.add(done);
                });
              return { status: row().status, result: row().result };
            },
            catch: () => "DESKTOP_UNAVAILABLE",
          }),
        receipt: (id: string) =>
          Effect.sync(
            () =>
              sql.exec<Ledger>("SELECT * FROM effect_ledger WHERE id=?", id).toArray()[0] ?? null,
          ),
        dispatch: (action: typeof Action.Type) =>
          Effect.sync(() =>
            dispatch(Schema.decodeUnknownSync(Action)(action), "agent", "workflow"),
          ),
        fetch: Effect.gen(function* () {
          const effectRequest = yield* HttpServerRequest.HttpServerRequest;
          const request = yield* HttpServerRequest.toWeb(effectRequest);
          const url = new URL(request.url);
          const guest = url.pathname.startsWith("/guest/");
          const artifact = url.pathname.match(
            /^\/guest\/([a-zA-Z0-9_-]{1,128})\/artifact\/([a-zA-Z0-9_-]{1,128})$/,
          );
          if (artifact && request.method === "PUT") {
            const c = config(),
              token = request.headers.get("Authorization")?.replace(/^Bearer /, "");
            const tokenHash = token ? yield* Effect.promise(() => sha256(token)) : null;
            if (
              !c ||
              artifact[1] !== c.kittyId ||
              tokenHash !== c.tokenHash ||
              request.headers.get("X-Kitty-Generation") !== String(c.generation) ||
              request.headers.get("X-Kitty-Remote") !== c.remoteId ||
              request.headers.get("X-Kitty-Epoch") !== String(c.epoch) ||
              request.headers.get("X-Kitty-Token-Version") !== String(c.tokenVersion)
            )
              return HttpServerResponse.empty({ status: 403 });
            const intent = sql
              .exec<Ledger>(
                "SELECT * FROM effect_ledger WHERE id=? AND generation=? AND status='started'",
                artifact[2]!,
                c.generation,
              )
              .toArray()[0];
            if (!intent || (JSON.parse(intent.body) as typeof Action.Type).action !== "screenshot")
              return HttpServerResponse.empty({ status: 403 });
            const bytes = yield* Effect.tryPromise({
              try: async () => {
                const reader = request.body?.getReader();
                let size = 0;
                const parts: Uint8Array[] = [];
                if (reader)
                  try {
                    for (;;) {
                      const { done, value } = await reader.read();
                      if (done) break;
                      size += value.length;
                      if (size > 1024 * 1024) throw Error("TOO_LARGE");
                      parts.push(value);
                    }
                  } finally {
                    await reader.cancel();
                  }
                const result = new Uint8Array(size);
                let offset = 0;
                for (const part of parts) {
                  result.set(part, offset);
                  offset += part.length;
                }
                return result;
              },
              catch: () => "ARTIFACT_TOO_LARGE",
            });
            if (bytes[0] !== 255 || bytes[1] !== 216)
              return HttpServerResponse.empty({ status: 400 });
            const key = `screenshots/${c.kittyId}/${c.generation}/${artifact[2]}.jpg`;
            yield* Effect.promise(() =>
              env.BLOBS.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } }),
            );
            return HttpServerResponse.fromWeb(Response.json({ screenshot: key }));
          }
          if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
            return HttpServerResponse.empty({ status: 404 });
          const c = config();
          if (!c) return HttpServerResponse.empty({ status: 409 });
          const frames = url.pathname.endsWith("/frames");
          const role: Session["role"] = guest
            ? frames
              ? "guest-frames"
              : "guest"
            : frames
              ? "viewer"
              : "owner";
          if (guest) {
            const token = request.headers
              .get("Authorization")
              ?.match(/^Bearer ([a-zA-Z0-9_-]{32,128})$/)?.[1];
            if (
              !token ||
              (yield* Effect.promise(() => sha256(token))) !== c.tokenHash ||
              request.headers.get("X-Kitty-Generation") !== String(c.generation) ||
              request.headers.get("X-Kitty-Remote") !== c.remoteId ||
              request.headers.get("X-Kitty-Token-Version") !== String(c.tokenVersion)
            )
              return HttpServerResponse.empty({ status: 403 });
            if (!frames) {
              bump();
              for (const old of [...sockets("guest"), ...sockets("guest-frames")])
                old.close(1012, "New guest connection");
            } else if (request.headers.get("X-Kitty-Epoch") !== String(config()!.epoch))
              return HttpServerResponse.empty({ status: 403 });
          }
          if (sockets(role).length >= (guest ? 2 : 4))
            return HttpServerResponse.empty({ status: 429 });
          const [response, ws] = yield* Cloudflare.upgrade({ tags: [role] });
          const session: Session = { role, clientId: crypto.randomUUID(), epoch: config()!.epoch };
          ws.serializeAttachment(session);
          if (role === "guest")
            yield* ws.send(
              JSON.stringify({
                type: "welcome",
                protocolVersion: 1,
                epoch: session.epoch,
                generation: c.generation,
                viewers: sockets("viewer").length,
                reconcile: sql
                  .exec<{ id: string }>(
                    "SELECT id FROM effect_ledger WHERE status='started' AND generation=? LIMIT 256",
                    c.generation,
                  )
                  .toArray()
                  .map((x) => x.id),
              }),
            );
          if (role === "owner")
            yield* ws.send(
              JSON.stringify({
                type: "connected",
                ...config()!,
                tokenHash: undefined,
                clientId: session.clientId,
              }),
            );
          if (role === "viewer") peers();
          return response;
        }),
        webSocketMessage: (socket: Cloudflare.WebSocket, message: string | ArrayBuffer) =>
          Effect.sync(() => {
            const ws = socket.ws,
              session = socket.deserializeAttachment<Session>();
            const c = config();
            if (!session || !c) return ws.close(1008, "No session");
            if (session.role.startsWith("guest") && session.epoch !== c.epoch)
              return ws.close(1008, "Stale epoch");
            if (typeof message !== "string") {
              if (
                session.role !== "guest-frames" ||
                message.byteLength > 1024 * 1024 ||
                message.byteLength < 8
              )
                return ws.close(1009, "Invalid frame");
              const view = new DataView(message);
              if (view.getUint32(0) !== c.generation) return ws.close(1008, "Stale generation");
              const seq = view.getUint32(4);
              for (const viewer of sockets("viewer")) {
                const attachment = viewer.deserializeAttachment() as Session;
                if (attachment.outstanding !== undefined) continue;
                attachment.outstanding = seq;
                viewer.serializeAttachment(attachment);
                try {
                  viewer.send(message);
                } catch {
                  /* Each viewer has at most one unacknowledged frame. */
                }
              }
              return;
            }
            if (message.length > 65536) return ws.close(1009, "Message too large");
            const now = Date.now();
            if (!session.window || session.window < now - 1000) {
              session.window = now;
              session.count = 0;
            }
            if (++session.count! > 120) return ws.close(1008, "Rate limit");
            ws.serializeAttachment(session);
            try {
              const body = JSON.parse(message) as Record<string, unknown>;
              if (session.role === "viewer") {
                if (body.type === "frame_ack" && body.seq === session.outstanding) {
                  delete session.outstanding;
                  ws.serializeAttachment(session);
                }
                return;
              }
              if (session.role === "guest") {
                if (body.type === "hello") {
                  if (body.protocolVersion !== 1 && body.protocolVersion !== 0)
                    return ws.close(1008, "Unsupported protocol");
                  return;
                }
                if (body.type === "ack") {
                  const ack = Schema.decodeUnknownSync(Ack)(body);
                  if (ack.generation !== c.generation || ack.epoch !== c.epoch)
                    return ws.close(1008, "Stale acknowledgment");
                  const row = sql
                    .exec<Ledger>(
                      "SELECT * FROM effect_ledger WHERE id=? AND generation=?",
                      ack.intentId,
                      c.generation,
                    )
                    .toArray()[0];
                  if (row) {
                    finish(row.id, ack.status, ack.result ?? null, ack.timings);
                    if (ack.status !== "completed") revoke();
                  }
                  return;
                }
                if (
                  body.type === "reconcile" &&
                  Array.isArray(body.receipts) &&
                  body.receipts.length <= 256
                ) {
                  for (const unknown of body.receipts) {
                    const ack = Schema.decodeUnknownSync(Ack)(unknown);
                    if (ack.generation !== c.generation) continue;
                    const row = sql
                      .exec<Ledger>(
                        "SELECT * FROM effect_ledger WHERE id=? AND generation=? AND status IN ('started','unknown')",
                        ack.intentId,
                        c.generation,
                      )
                      .toArray()[0];
                    if (row) finish(row.id, ack.status, ack.result ?? null, ack.timings);
                  }
                  return;
                }
                return ws.close(1008, "Guest capability denied");
              }
              if (body.type === "grant") {
                if (!canGrant(pending(), read<Grant>("grant"), now))
                  return send(ws, { type: "held" });
                const grant: Grant = {
                  kittyId: c.kittyId,
                  generation: c.generation,
                  remoteId: c.remoteId,
                  epoch: c.epoch,
                  nonce: crypto.randomUUID(),
                  clientId: session.clientId,
                  lastInputAt: now,
                  expiresAt: now + 120000,
                  draining: false,
                };
                write("grant", grant);
                scheduleAt(grant.expiresAt);
                send(ws, { type: "grant", receipt: grant });
                return;
              }
              if (body.type === "release") {
                const grant = read<Grant>("grant");
                if (!grant || grant.clientId !== session.clientId || grant.nonce !== body.nonce)
                  throw Error("INVALID_RECEIPT");
                grant.draining = true;
                write("grant", grant);
                if (pending("owner") === 0) revoke();
                return;
              }
              if (body.type === "input") {
                const grant = read<Grant>("grant");
                if (!validGrant(grant, c, session.clientId, String(body.nonce), now))
                  throw Error("INVALID_RECEIPT");
                const action = Schema.decodeUnknownSync(Action)({ ...body, type: "action" });
                const result = dispatch(action, "owner", session.clientId);
                grant.lastInputAt = now;
                write("grant", grant);
                send(ws, { type: "dispatched", intentId: action.intentId, ...result });
                return;
              }
              throw Error("UNKNOWN_MESSAGE");
            } catch (error) {
              console.warn(
                "Channel request rejected",
                error instanceof Error ? error.message : "INVALID_REQUEST",
              );
              revoke();
              send(ws, { type: "error", code: "INVALID_REQUEST" });
            }
          }),
        webSocketClose: (socket: Cloudflare.WebSocket) =>
          Effect.sync(() => {
            socket.ws.close();
            const session = socket.deserializeAttachment<Session>();
            if (!session) return;
            if (session.role === "guest" && session.epoch === config()?.epoch) bump();
            if (session.role === "owner" && read<Grant>("grant")?.clientId === session.clientId) {
              const grant = read<Grant>("grant")!;
              grant.draining = true;
              write("grant", grant);
              if (pending("owner") === 0) revoke();
            }
            if (session.role === "viewer") peers();
          }),
        webSocketError: () => Effect.sync(() => revoke()),
        alarm: () =>
          Effect.promise(async () => {
            let next = Date.now() + 10000;
            try {
              write("wake", null);
              const now = Date.now();
              for (const row of sql
                .exec<Ledger>("SELECT * FROM effect_ledger WHERE status='started'")
                .toArray()) {
                const deadline = (JSON.parse(row.body) as typeof Action.Type).deadline;
                if (deadline <= now) {
                  finish(row.id, "unknown", null);
                  revoke();
                } else next = Math.min(next, deadline);
              }
              const grant = read<Grant>("grant");
              if (grant && grant.expiresAt <= now) revoke();
              else if (grant) next = Math.min(next, grant.expiresAt);
              if (!read<Grant>("grant") && pending() === 0) return;
            } catch {
              /* A storage failure must retain a future recovery wake. */
            }
            write("wake", next);
            await state.raw.storage.setAlarm(next);
          }).pipe(
            Effect.catchCause(() =>
              Effect.promise(() => state.raw.storage.setAlarm(Date.now() + 10000)).pipe(
                Effect.catchCause(() => Effect.void),
              ),
            ),
          ),
      };
    });
  }),
) {}
