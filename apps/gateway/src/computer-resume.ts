import * as Effect from "effect/Effect";
import * as Workflows from "alchemy/Workflows";
import { WorkflowEngine } from "effect/workflow";
import { HomeDO, KittyDO } from "./actors.ts";
import { ComputerOp } from "./computer-definition.ts";

export const makeComputerResume = Effect.gen(function* () {
  const homes = yield* HomeDO,
    kitties = yield* KittyDO,
    computers = yield* Workflows.RunWorkflow(ComputerOp),
    engine = yield* WorkflowEngine.WorkflowEngine;

  return (kittyId: string, operationId: string) =>
    Effect.gen(function* () {
      const home = homes.getByName("owner", { locationHint: "weur" }),
        kitty = kitties.getByName(kittyId, { locationHint: "weur" });

      const state = yield* kitty.computer();
      const operation = state?.operation;

      if (state?.kittyId !== kittyId || operation?.id !== operationId) return null;

      const ownsOperation = Effect.map(
        kitty.computer(),
        (current) =>
          current?.kittyId === kittyId &&
          current.generation === state.generation &&
          current.operation?.id === operationId &&
          current.operation.kind === operation.kind,
      );

      let saved = yield* home.read("computer-run", operationId);
      const payload = { kittyId, operationId, kind: operation.kind };
      const expectedId = yield* ComputerOp.executionId(payload);

      if (!saved) {
        // Reconstruct the same run the interrupted request would have published.
        // Starting it twice reuses its deterministic execution/activity journals.
        const run = yield* computers.start(payload);

        if (!(yield* ownsOperation)) return null;
        // Do not overwrite a receipt another request/watchdog published while start yielded.
        yield* home.insert(
          "computer-run",
          operationId,
          JSON.stringify({
            kittyId,
            executionId: run.executionId,
            kind: operation.kind,
          }),
        );
        saved = yield* home.read("computer-run", operationId);
      }

      if (!saved) return null;
      const record = JSON.parse(saved) as { kittyId: string; executionId: string };

      if (
        record.kittyId !== kittyId ||
        record.executionId !== expectedId ||
        !(yield* ownsOperation)
      )
        return null;
      yield* ComputerOp.resume(record.executionId).pipe(
        Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
      );

      return { executionId: record.executionId };
    });
});
