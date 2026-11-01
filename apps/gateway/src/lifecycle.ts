import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import { WorkflowEngine } from "effect/workflow";
import { HomeDO, KittyDO } from "./actors.ts";
import { ComputerOp } from "./computer-definition.ts";
import { boatClient, ownsSandbox } from "./boat.ts";
export const makeLifecycle = Effect.gen(function* () {
  const homes = yield* HomeDO,
    kitties = yield* KittyDO,
    computers = yield* Workflows.RunWorkflow(ComputerOp);
  const engine = yield* WorkflowEngine.WorkflowEngine;
  const env = (yield* Cloudflare.WorkerEnvironment) as {
    BOAT_DEV_API_KEY: string;
    KITTIES_DEPLOYMENT: string;
  };
  const boat = boatClient(env.BOAT_DEV_API_KEY);
  return Effect.gen(function* () {
    const home = homes.getByName("owner", { locationHint: "weur" });
    const records = yield* home.list("kitty");
    yield* Effect.forEach(
      records,
      (record) =>
        Effect.gen(function* () {
          const kitty = kitties.getByName(record.id, { locationHint: "weur" }),
            state = yield* kitty.computer();
          if (!state?.remoteId || ["absent", "sleeping", "deleted"].includes(state.phase)) return;
          if (state.operation) {
            // Starting is idempotent and also repairs a crash between the actor
            // claiming an operation and the Worker publishing its run receipt.
            const run = yield* computers.start({
              kittyId: record.id,
              operationId: state.operation.id,
              kind: state.operation.kind,
            });
            yield* home.write(
              "computer-run",
              state.operation.id,
              JSON.stringify({
                kittyId: record.id,
                executionId: run.executionId,
                kind: state.operation.kind,
              }),
            );
            {
              // Re-arm a callback interrupted by deployment. Activity journals and
              // the exact creation receipt prevent duplicate lifecycle effects.
              yield* ComputerOp.resume(run.executionId).pipe(
                Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
              );
            }
          }
          const machine = yield* boat.get(state.remoteId);
          if (
            !ownsSandbox(
              machine,
              env.KITTIES_DEPLOYMENT,
              record.id,
              state.generation,
              state.receipt,
            )
          )
            return;
          if (machine.state === "archived") {
            if (state.operation && ["sleep", "delete"].includes(state.operation.kind)) return;
            yield* home.write(
              "run-health",
              "computer:" + record.id,
              JSON.stringify({
                id: "computer:" + record.id,
                kittyId: record.id,
                status: "attention",
                code: "TTL_ARCHIVE_REQUIRES_REVIEW",
                updatedAt: Date.now(),
              }),
            );
            return;
          }
          const channel = yield* kitty.status();
          const busy = channel.viewers > 0 || !!channel.grant || channel.pending > 0;
          if (busy) yield* kitty.touchComputer();
          // Keep a draining or failed operation alive; TTL must never replace quiescence.
          if (Date.now() - state.lastRenewAt > 240000) {
            yield* boat.request("PATCH", "/sandboxes/" + state.remoteId, { ttlSeconds: 3600 });
            yield* kitty.renewComputer(state.remoteId, Date.now());
          }
          if (
            state.phase === "ready" &&
            !state.operation &&
            !busy &&
            Date.now() - state.lastActiveAt > 900000
          ) {
            const operationId = `idle-${state.generation}-${Math.floor(Date.now() / 900000)}`;
            yield* kitty.beginComputer(record.id, operationId, "sleep");
            const run = yield* computers.start({ kittyId: record.id, operationId, kind: "sleep" });
            yield* home.write(
              "computer-run",
              operationId,
              JSON.stringify({ kittyId: record.id, executionId: run.executionId, kind: "sleep" }),
            );
          }
        }).pipe(
          Effect.catchCause(() =>
            home
              .write(
                "run-health",
                "computer:" + record.id,
                JSON.stringify({
                  id: "computer:" + record.id,
                  kittyId: record.id,
                  status: "attention",
                  code: "COMPUTER_WATCHDOG_RETRY",
                  updatedAt: Date.now(),
                }),
              )
              .pipe(Effect.catchCause(() => Effect.void)),
          ),
        ),
      { concurrency: 5 },
    );
  }).pipe(
    Effect.catchCause(() => Effect.logError("Lifecycle watchdog will retry on the next tick")),
  );
});
