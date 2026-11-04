import assert from "node:assert/strict";
import test from "node:test";
import {
  RecoveryCoordinator,
  RecoveryConflict,
  type RecoveryGateway,
  type RecoveryStorage,
} from "./recovery.ts";

function fixture() {
  const data = new Map<string, unknown>();
  const storage: RecoveryStorage = {
    get: async <T>(key: string) =>
      structuredClone(data.get(key)) as T | undefined,
    put: async (entries) => {
      for (const [key, value] of Object.entries(entries))
        data.set(key, structuredClone(value));
    },
    sync: async () => {},
  };
  const events: string[] = [];
  let verified: "pending" | "ready" | "failed" = "pending";
  let stopFails = false;
  let releaseFails = false;
  let startFails = false;
  const gateways = new Map<string, RecoveryGateway>();
  const gateway = (generation: string): RecoveryGateway => {
    let found = gateways.get(generation);
    if (!found) {
      found = {
        preflight: async () => verified,
        release: async () => {
          events.push(`release:${generation}`);
          if (releaseFails) throw new Error("release unavailable");
        },
        retire: async () => {
          events.push(`retire:${generation}`);
          if (stopFails) throw new Error("still running");
        },
        activate: async () => {
          events.push(`activate:${generation}`);
          if (startFails) throw new Error("not ready");
        },
        restart: async () => {
          events.push(`restart:${generation}`);
        },
      };
      gateways.set(generation, found);
    }
    return found;
  };
  const make = () => new RecoveryCoordinator(storage, gateway, async () => {});
  return {
    make,
    events,
    verify: (result: typeof verified) => {
      verified = result;
    },
    failRelease: (value: boolean) => {
      releaseFails = value;
    },
    failStop: (value: boolean) => {
      stopFails = value;
    },
    failStart: (value: boolean) => {
      startFails = value;
    },
  };
}
const snapshot = "a".repeat(64);
test("failed recovery preflight never retires or switches the current gateway", async () => {
  const f = fixture();
  const coordinator = f.make();
  await coordinator.restore("operation-one", snapshot);
  await coordinator.advance();
  assert.equal((await coordinator.status()).operation?.phase, "preflight");
  f.verify("failed");
  await coordinator.advance();
  assert.equal((await coordinator.status()).operation?.phase, "releasing");
  await coordinator.advance();
  assert.equal((await coordinator.status()).operation?.phase, "failed");
  assert.equal(await coordinator.active(), "initial");
  assert.deepEqual(f.events, ["release:initial"]);
});
test("recovery survives coordinator restarts and confirms retirement before activation", async () => {
  const f = fixture();
  let coordinator = f.make();
  await coordinator.restore("operation-one", snapshot);
  f.verify("ready");
  await coordinator.advance();
  f.failStop(true);
  coordinator = f.make();
  await coordinator.advance();
  assert.equal((await coordinator.status()).operation?.phase, "retiring");
  assert.equal(await coordinator.active(), "initial");
  assert(!f.events.some((event) => event.startsWith("activate:")));
  f.failStop(false);
  await coordinator.advance();
  f.failStart(true);
  coordinator = f.make();
  await coordinator.advance();
  assert.equal(await coordinator.active(), "initial");
  f.failStart(false);
  await coordinator.advance();
  assert.equal(await coordinator.active(), "recovery-operation-one");
  assert.equal((await coordinator.status()).operation?.phase, "complete");
  assert.equal(
    (await coordinator.restore("operation-one", snapshot)).phase,
    "complete",
  );
  await assert.rejects(
    coordinator.restore("operation-one", "b".repeat(64)),
    RecoveryConflict,
  );
});
test("a second operator recovery or restart cannot race an accepted recovery", async () => {
  const coordinator = fixture().make();
  await coordinator.restore("operation-one", snapshot);
  await assert.rejects(
    coordinator.restore("operation-two", snapshot),
    RecoveryConflict,
  );
  await assert.rejects(coordinator.restart(), RecoveryConflict);
});

test("failed preflight releases its durable freeze after a coordinator restart before declaring failure", async () => {
  const f = fixture();
  let coordinator = f.make();
  await coordinator.restore("operation-release", snapshot);
  f.verify("failed");
  await coordinator.advance();
  f.failRelease(true);
  await coordinator.advance();
  assert.equal((await coordinator.status()).operation?.phase, "releasing");
  assert.equal(await coordinator.active(), "initial");
  coordinator = f.make();
  f.failRelease(false);
  await coordinator.advance();
  assert.equal((await coordinator.status()).operation?.phase, "failed");
  assert(!f.events.some((event) => event.startsWith("retire:")));
});
