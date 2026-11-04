import { afterEach, expect, test, vi } from "vitest";
import * as Context from "effect/Context";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { DurableClock, WorkflowEngine } from "effect/workflow";
import { HomeDO, KittyDO, ChatDO } from "./actors.ts";
import { makeHelpStore, type HelpRecord } from "./help-store.ts";
import { retryHelpDecisions } from "./help-decisions.ts";
import { makeOwnerData } from "./owner-data.ts";
import { DesktopAttempt, DesktopDecision } from "./desktop-definition.ts";
import { DesktopAttemptLive } from "./workflows/desktop.ts";
import { RecoveryDO } from "./recovery-store.ts";
import { sqliteFixture } from "./test/sqlite.ts";

// Substitute only the infrastructure bindings; exercise the real route,
// SQL decision store, workflow activities and in-memory workflow engine.
vi.mock("./actors.ts", async () => {
  const Context = await import("effect/Context");
  return {
    HomeDO: Context.Service("test/HomeDO"),
    KittyDO: Context.Service("test/KittyDO"),
    ChatDO: Context.Service("test/ChatDO"),
  };
});
vi.mock("./recovery-store.ts", async () => {
  const Context = await import("effect/Context");
  return { RecoveryDO: Context.Service("test/RecoveryDO") };
});
const HomeBinding = Context.Service<Effect.Services<typeof HomeDO>, Effect.Success<typeof HomeDO>>(
  "test/HomeDO",
);
const KittyBinding = Context.Service<
  Effect.Services<typeof KittyDO>,
  Effect.Success<typeof KittyDO>
>("test/KittyDO");
const ChatBinding = Context.Service<Effect.Services<typeof ChatDO>, Effect.Success<typeof ChatDO>>(
  "test/ChatDO",
);
const RecoveryBinding = Context.Service<
  Effect.Services<typeof RecoveryDO>,
  Effect.Success<typeof RecoveryDO>
>("test/RecoveryDO");

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));
function fixture() {
  const { database, state } = sqliteFixture();
  cleanup.push(() => database.close());
  database.exec(
    "CREATE TABLE records(kind TEXT,id TEXT,body TEXT,updated_at INTEGER,PRIMARY KEY(kind,id)); CREATE TABLE charges(id TEXT PRIMARY KEY); CREATE TABLE results(id TEXT PRIMARY KEY,body TEXT)",
  );
  const store = makeHelpStore(state);
  const read = (kind: string, id: string) =>
    (database.prepare("SELECT body FROM records WHERE kind=? AND id=?").get(kind, id)?.body as
      | string
      | undefined) ?? null;
  const home = {
    read: (kind: string, id: string) => Effect.sync(() => read(kind, id)),
    list: (kind: string) =>
      Effect.sync(
        () =>
          database.prepare("SELECT id,body FROM records WHERE kind=?").all(kind) as {
            id: string;
            body: string;
          }[],
      ),
    insert: (kind: string, id: string, body: string) =>
      Effect.sync(() => {
        database.prepare("INSERT OR IGNORE INTO records VALUES (?,?,?,0)").run(kind, id, body);
      }),
    decideHelp: (id: string, decision: "accept" | "skip") =>
      Effect.sync(() => store.decide(id, decision)),
    completeHelp: (id: string) => Effect.sync(() => store.complete(id)),
    queueNotice: () => Effect.void,
    charge: (id: string) =>
      Effect.sync(() => {
        database.prepare("INSERT OR IGNORE INTO charges VALUES (?)").run(id);
      }),
  };
  const put = (row: HelpRecord) =>
    database
      .prepare("INSERT OR REPLACE INTO records VALUES ('desktop-help','help',?,0)")
      .run(JSON.stringify(row));
  const row = () => JSON.parse(read("desktop-help", "help")!) as HelpRecord;
  return { database, state, home, store, row, put };
}
const pending = (): HelpRecord => ({
  status: "pending",
  expiresAt: Date.now() + 60000,
  executionId: "run",
  kittyId: "cat",
});
const request = (decision: string) =>
  new Request("https://example.com/v1/help/help/decision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });

test("a failed HTTP signal keeps the accepted decision retryable after expiry and control changes", async () => {
  const f = fixture();
  f.put(pending());
  let signals = 0,
    controlling = false;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine;
        const handler = yield* makeOwnerData.pipe(
          Effect.provideService(WorkflowEngine.WorkflowEngine, {
            ...engine,
            deferredDone: () =>
              Effect.suspend(() => (++signals === 1 ? Effect.die("signal failed") : Effect.void)),
          }),
        );
        controlling = true;
        expect((yield* handler(request("accept")))?.status).toBe(409);
        controlling = false;
        expect(Exit.isFailure(yield* Effect.exit(handler(request("accept"))))).toBe(true);
        expect(f.row()).toMatchObject({ status: "accept", decision: "accept" });
        f.put({ ...f.row(), expiresAt: 0 });
        controlling = true;
        expect((yield* handler(request("accept")))?.status).toBe(200);
        expect(signals).toBe(2);
        expect((yield* handler(request("skip")))?.status).toBe(409);
        expect(f.store.complete("help")).toBe("accept");
        expect((yield* handler(request("accept")))?.status).toBe(200);
        expect(f.row()).toMatchObject({
          status: "completed",
          decision: "accept",
          executionId: "run",
        });
      }),
    ).pipe(
      Effect.provideService(HomeBinding, { getByName: () => f.home } as unknown as Effect.Success<
        typeof HomeDO
      >),
      Effect.provideService(KittyBinding, {
        getByName: () => ({ status: () => Effect.succeed({ grant: controlling ? {} : null }) }),
      } as unknown as Effect.Success<typeof KittyDO>),
      Effect.provideService(Cloudflare.WorkerEnvironment, {}),
      Effect.provide(Workflows.implemented([DesktopAttempt._tag])),
      Effect.provide(WorkflowEngine.layerMemory),
    ),
  );
});

test("completion and decisions serialize durably, including timeout and legacy accepted rows", () => {
  const f = fixture();
  f.put(pending());
  expect(f.store.decide("help", "accept")).toBe(true);
  expect(f.store.decide("help", "skip")).toBe(false);
  expect(makeHelpStore(f.state).complete("help")).toBe("accept");
  expect(f.store.complete("help")).toBe("accept");
  expect(f.store.decide("help", "accept")).toBe(true);
  f.put({ ...pending(), expiresAt: 0 });
  expect(f.store.decide("help", "accept")).toBe(false);
  expect(f.store.complete("help")).toBe("skip");
  expect(f.store.decide("help", "accept")).toBe(false);
  f.put({ ...pending(), status: "accept", expiresAt: 0 });
  expect(f.store.complete("help")).toBe("accept");
});

test.each(["lost signal reply", "expiry after failed signal"] as const)(
  "%s preserves the accepted choice in the real workflow with one result and charge",
  async (mode) => {
    const f = fixture();
    await Effect.runPromise(
      f.home.insert(
        "desktop-job",
        "help",
        JSON.stringify({ action: "ask_help", args: { reason: "review" } }),
      ),
    );
    const bindings = Layer.mergeAll(
      Layer.succeed(HomeBinding, { getByName: () => f.home } as unknown as Effect.Success<
        typeof HomeDO
      >),
      Layer.succeed(KittyBinding, {
        getByName: () => ({ receipt: () => Effect.succeed(null) }),
      } as unknown as Effect.Success<typeof KittyDO>),
      Layer.succeed(ChatBinding, {
        getByName: () => ({
          run: () => Effect.succeed({ status: "running" }),
          saveToolResult: (_message: string, callId: string, body: string) =>
            Effect.sync(() => {
              f.database.prepare("INSERT OR IGNORE INTO results VALUES (?,?)").run(callId, body);
            }),
        }),
      } as unknown as Effect.Success<typeof ChatDO>),
      Layer.succeed(RecoveryBinding, {
        getByName: () => ({ permit: () => Effect.succeed(true) }),
      } as unknown as Effect.Success<typeof RecoveryDO>),
      Layer.succeed(Cloudflare.WorkerEnvironment, {}),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* Workflows.RunWorkflow(DesktopAttempt);
          const run = yield* client.start({
            id: "help",
            kittyId: "cat",
            chatId: "chat",
            messageId: "message",
            callId: "call",
          });
          for (
            let i = 0;
            !f.database.prepare("SELECT id FROM records WHERE kind='desktop-help'").get() &&
            i < 100;
            i++
          )
            yield* Effect.sleep(1);
          expect(f.store.decide("help", "accept")).toBe(true);
          const signal = (_id: string, decision: "accept" | "skip") =>
            run.signal(DesktopDecision, decision);
          if (mode === "lost signal reply") {
            // Completion reaches the engine but the caller loses its reply.
            yield* signal(run.executionId, "accept").pipe(
              Effect.andThen(Effect.die("lost reply")),
              Effect.catchCause(() => Effect.void),
            );
            yield* retryHelpDecisions(f.home, signal);
          } else {
            yield* retryHelpDecisions(f.home, () => Effect.die("signal unavailable"));
            expect(f.row()).toMatchObject({ status: "accept", decision: "accept" });
            // Wake the real expiry branch without waiting fifteen wall-clock minutes.
            const expiry = DurableClock.make({ name: "help-expiry", duration: "15 minutes" });
            yield* run.signal(expiry.deferred, undefined);
          }
          expect(yield* run.result).toBe("call");
          yield* signal(run.executionId, "accept");
          yield* retryHelpDecisions(f.home, signal);
          expect(yield* run.result).toBe("call");
          expect(f.row()).toMatchObject({ status: "completed", decision: "accept" });
          expect(f.database.prepare("SELECT COUNT(*) AS n FROM charges").get()?.n).toBe(1);
          expect(f.database.prepare("SELECT COUNT(*) AS n FROM results").get()?.n).toBe(1);
          expect(
            JSON.parse(f.database.prepare("SELECT body FROM results").get()!.body as string),
          ).toMatchObject({ isFailure: false, result: { status: "completed" } });
        }),
      ).pipe(
        Effect.provide(DesktopAttemptLive.pipe(Layer.provide(bindings))),
        Effect.provide(WorkflowEngine.layerMemory),
      ),
    );
  },
);
