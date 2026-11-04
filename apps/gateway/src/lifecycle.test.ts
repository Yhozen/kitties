import { afterEach, expect, test, vi } from "vitest";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Workflows from "alchemy/Workflows";
import { WorkflowEngine } from "effect/workflow";
import { HomeDO, KittyDO } from "./actors.ts";
import { ComputerOp } from "./computer-definition.ts";
import { DesktopAttempt } from "./desktop-definition.ts";
import { beginOperation, freshComputer, type ComputerState } from "./computer-state.ts";
import { makeLifecycle } from "./lifecycle.ts";

vi.mock("./actors.ts", async () => {
  const Context = await import("effect/Context");
  return { HomeDO: Context.Service("test/HomeDO"), KittyDO: Context.Service("test/KittyDO") };
});
const HomeBinding = Context.Service<Effect.Services<typeof HomeDO>, Effect.Success<typeof HomeDO>>(
  "test/HomeDO",
);
const KittyBinding = Context.Service<
  Effect.Services<typeof KittyDO>,
  Effect.Success<typeof KittyDO>
>("test/KittyDO");
afterEach(() => vi.unstubAllGlobals());

function fixture(initial: ComputerState) {
  let state = initial;
  const write = vi.fn(() => Effect.void);
  const execute = vi.fn((_workflow: unknown, options: { executionId: string }) =>
    Effect.succeed(options.executionId),
  );
  const resume = vi.fn(() => Effect.void);
  const fetch = vi.fn(async () =>
    Response.json({
      sandbox: {
        id: "bx_new12345",
        name: "kn-cat-g1",
        state: "ready",
        labels: { "kitties.deployment": "prod", "kitties.kitty": "cat", "kitties.generation": "1" },
      },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const engine = {
    execute,
    resume,
    poll: () => Effect.succeed(Option.none()),
    interrupt: () => Effect.void,
  } as unknown as WorkflowEngine.WorkflowEngine["Service"];
  const tick = () =>
    Effect.runPromise(
      Effect.flatten(makeLifecycle).pipe(
        Effect.provideService(HomeBinding, {
          getByName: () => ({
            list: (kind: string) => Effect.succeed(kind === "kitty" ? [{ id: "cat" }] : []),
            write,
          }),
        } as unknown as Effect.Success<typeof HomeDO>),
        Effect.provideService(KittyBinding, {
          getByName: () => ({
            computer: () => Effect.sync(() => state),
            status: () => Effect.succeed({ viewers: 0, pending: 0, fileTransfers: 0 }),
          }),
        } as unknown as Effect.Success<typeof KittyDO>),
        Effect.provideService(Cloudflare.WorkerEnvironment, {
          BOAT_DEV_API_KEY: "unused",
          KITTIES_DEPLOYMENT: "prod",
        }),
        Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
        Effect.provide(Workflows.implemented([ComputerOp._tag, DesktopAttempt._tag])),
      ),
    );
  return {
    execute,
    resume,
    fetch,
    write,
    tick,
    set: (next: ComputerState) => {
      state = next;
    },
  };
}

test("an initial start without a remote or run receipt is published and resumed on every tick", async () => {
  const state = beginOperation(freshComputer("cat", 1), "initial", "start", 2);
  const f = fixture(state);
  await f.tick();
  await f.tick();
  expect(f.execute).toHaveBeenCalledTimes(2);
  expect(f.execute.mock.calls[0]![1]).toMatchObject({
    payload: { kittyId: "cat", operationId: "initial", kind: "start" },
  });
  expect(f.execute.mock.calls[1]![1].executionId).toBe(f.execute.mock.calls[0]![1].executionId);
  expect(f.resume).toHaveBeenCalledTimes(2);
  expect(f.write).toHaveBeenCalledWith(
    "computer-run",
    "initial",
    expect.stringContaining('"kind":"start"'),
  );
  expect(f.fetch).not.toHaveBeenCalled();
});

test.each(["sleeping", "deleted"] as const)(
  "an interrupted %s phase is repaired before the inactive-state guard",
  async (phase) => {
    const state = {
      ...freshComputer("cat", 1),
      phase,
      remoteId: "bx_old12345",
      operation: { id: "stop", kind: "delete" as const, at: 2, generation: 1 },
    };
    const f = fixture(state);
    await f.tick();
    expect(f.resume).toHaveBeenCalledOnce();
    expect(f.fetch).not.toHaveBeenCalled();
  },
);

test("remote checks reread state after resumption installs the initial sandbox", async () => {
  const state = beginOperation(freshComputer("cat", 1), "initial", "start", 2);
  const f = fixture(state);
  f.resume.mockImplementation(() =>
    Effect.sync(() =>
      f.set({
        ...state,
        operation: undefined,
        phase: "ready",
        remoteId: "bx_new12345",
        lastActiveAt: Date.now(),
        lastRenewAt: Date.now(),
      }),
    ),
  );
  await f.tick();
  expect(f.fetch).toHaveBeenCalledOnce();
  expect(f.fetch.mock.calls[0]).toEqual(
    expect.arrayContaining(["https://boat.dev/api/v1/sandboxes/bx_new12345"]),
  );
});
