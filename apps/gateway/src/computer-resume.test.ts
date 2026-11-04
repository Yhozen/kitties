import { expect, test, vi } from "vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Workflows from "alchemy/Workflows";
import { WorkflowEngine } from "effect/workflow";
import { HomeDO, KittyDO } from "./actors.ts";
import { ComputerOp } from "./computer-definition.ts";
import { beginOperation, freshComputer, type ComputerState } from "./computer-state.ts";
import { makeComputerResume } from "./computer-resume.ts";

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

function fixture() {
  let state: ComputerState | null = beginOperation(freshComputer("cat", 1), "initial", "start", 2);
  const receipts = new Map<string, string>(),
    order: string[] = [];
  const execute = vi.fn((_workflow: unknown, options: { executionId: string }) =>
    Effect.sync(() => {
      order.push("start");
      return options.executionId;
    }),
  );
  const resume = vi.fn((_workflow: unknown, _executionId: string) =>
    Effect.sync(() => {
      order.push("resume");
    }),
  );
  const insert = vi.fn((_kind: string, id: string, body: string) =>
    Effect.sync(() => {
      order.push("persist");
      if (!receipts.has(id)) receipts.set(id, body);
    }),
  );
  const engine = {
    execute,
    resume,
    poll: () => Effect.succeed(Option.none()),
    interrupt: () => Effect.void,
  } as unknown as WorkflowEngine.WorkflowEngine["Service"];
  const retry = (kittyId = "cat", operationId = "initial") =>
    Effect.runPromise(
      Effect.flatMap(makeComputerResume, (handler) => handler(kittyId, operationId)).pipe(
        Effect.provideService(HomeBinding, {
          getByName: () => ({
            read: (_kind: string, id: string) => Effect.sync(() => receipts.get(id) ?? null),
            insert,
          }),
        } as unknown as Effect.Success<typeof HomeDO>),
        Effect.provideService(KittyBinding, {
          getByName: (id: string) => ({
            computer: () => Effect.sync(() => (id === "cat" ? state : null)),
          }),
        } as unknown as Effect.Success<typeof KittyDO>),
        Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
        Effect.provide(Workflows.implemented([ComputerOp._tag])),
      ),
    );
  return {
    execute,
    resume,
    insert,
    receipts,
    order,
    retry,
    set: (next: ComputerState | null) => {
      state = next;
    },
  };
}

test("Retry preparation reconstructs a missing initial-start receipt, then resumes the deterministic run", async () => {
  const f = fixture();
  const executionId = await Effect.runPromise(
    ComputerOp.executionId({ kittyId: "cat", operationId: "initial", kind: "start" }),
  );
  expect(await f.retry()).toEqual({ executionId });
  expect(f.execute.mock.calls[0]![1]).toMatchObject({
    payload: { kittyId: "cat", operationId: "initial", kind: "start" },
  });
  expect(JSON.parse(f.receipts.get("initial")!)).toEqual({
    kittyId: "cat",
    executionId,
    kind: "start",
  });
  expect(f.order).toEqual(["start", "persist", "resume"]);
  expect(await f.retry()).toEqual({ executionId });
  expect(f.execute).toHaveBeenCalledOnce();
  expect(f.insert).toHaveBeenCalledOnce();
  expect(f.resume).toHaveBeenCalledTimes(2);
});

test.each([false, true])(
  "stale operation IDs and another kitty return not found (receipt present: %s)",
  async (saved) => {
    const f = fixture();
    if (saved) f.receipts.set("stale", JSON.stringify({ kittyId: "cat", executionId: "old-run" }));
    expect(await f.retry("cat", "stale")).toBeNull();
    expect(await f.retry("other", "initial")).toBeNull();
    f.set(null);
    expect(await f.retry()).toBeNull();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.insert).not.toHaveBeenCalled();
    expect(f.resume).not.toHaveBeenCalled();
  },
);

test("a receipt belonging to another kitty cannot be overwritten or resumed", async () => {
  const f = fixture();
  const receipt = JSON.stringify({ kittyId: "other", executionId: "other-run" });
  f.receipts.set("initial", receipt);
  expect(await f.retry()).toBeNull();
  expect(f.receipts.get("initial")).toBe(receipt);
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.insert).not.toHaveBeenCalled();
  expect(f.resume).not.toHaveBeenCalled();
});

test("an operation replaced during start cannot publish its receipt or resume", async () => {
  const f = fixture();
  f.execute.mockImplementation((_workflow, options) =>
    Effect.sync(() => {
      f.set(beginOperation(freshComputer("cat", 1), "replacement", "start", 3));
      return options.executionId;
    }),
  );
  expect(await f.retry()).toBeNull();
  expect(f.insert).not.toHaveBeenCalled();
  expect(f.resume).not.toHaveBeenCalled();
});

test("receipt recovery preserves a concurrently published receipt for another kitty", async () => {
  const f = fixture();
  const receipt = JSON.stringify({ kittyId: "other", executionId: "other-run" });
  f.execute.mockImplementation((_workflow, options) =>
    Effect.sync(() => {
      f.receipts.set("initial", receipt);
      return options.executionId;
    }),
  );
  expect(await f.retry()).toBeNull();
  expect(f.receipts.get("initial")).toBe(receipt);
  expect(f.resume).not.toHaveBeenCalled();
});
