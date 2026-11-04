import { it, expect } from "vitest";
import { ownsSandbox, activeSandbox, type BoatSandbox } from "./boat.ts";
import { beginOperation, freshComputer } from "./computer-state.ts";
it("rejects matching Go names, foreign deployments, generations and labels", () => {
  const sandbox: BoatSandbox = {
    id: "bx_example",
    name: "kn-cat-g1",
    state: "provisioned",
    access: "owner",
    labels: {
      "kitties.deployment": "next-unique",
      "kitties.kitty": "cat",
      "kitties.generation": "1",
    },
  };
  expect(ownsSandbox(sandbox, "next-unique", "cat", 1)).toBe(true);
  expect(ownsSandbox({ ...sandbox, name: "kitty-cat" }, "next-unique", "cat", 1)).toBe(false);
  expect(ownsSandbox({ ...sandbox, labels: {} }, "next-unique", "cat", 1)).toBe(false);
  expect(ownsSandbox(sandbox, "go-deployment", "cat", 1)).toBe(false);
  expect(ownsSandbox(sandbox, "next-unique", "cat", 2)).toBe(false);
  expect(activeSandbox({ ...sandbox, state: "archiving" })).toBe(true);
  expect(activeSandbox({ ...sandbox, state: "archived" })).toBe(false);
});
it("keeps lifecycle intent stable on retry and fences competing operations", () => {
  const state = beginOperation(freshComputer("cat", 1), "operation", "start", 2);
  expect(beginOperation(state, "operation", "start", 3)).toEqual(state);
  expect(() => beginOperation(state, "another", "sleep", 3)).toThrow("COMPUTER_BUSY");
  expect(() => beginOperation(freshComputer("cat", 1), "restore", "restore", 2)).toThrow(
    "CHECKPOINT_REQUIRED",
  );
});

it("accepts stripped restore labels only with the exact deployment creation receipt", () => {
  const labels = {
    "kitties.deployment": "next-unique",
    "kitties.kitty": "cat",
    "kitties.generation": "2",
  };
  const machine: BoatSandbox = {
    id: "bx_exact123",
    name: "kn-cat-g2",
    state: "provisioned",
    labels: {},
    access: "owner",
  };
  const receipt = {
    remoteId: machine.id,
    generation: 2,
    key: "original-idempotency-key",
    body: JSON.stringify({ name: machine.name, labels }),
    at: 1,
  };
  expect(ownsSandbox(machine, "next-unique", "cat", 2, receipt)).toBe(true);
  expect(ownsSandbox({ ...machine, id: "bx_other123" }, "next-unique", "cat", 2, receipt)).toBe(
    false,
  );
  expect(ownsSandbox(machine, "other-deployment", "cat", 2, receipt)).toBe(false);
  expect(ownsSandbox(machine, "next-unique", "cat", 2, { ...receipt, body: "{}" })).toBe(false);
});

it("sleeping desktops require a new-generation restore for start and upgrade", () => {
  const state = { ...freshComputer("cat", 1), phase: "sleeping" as const, remoteId: "bx_exact123" };
  for (const kind of ["start", "upgrade"] as const)
    expect(() => beginOperation(state, "op", kind, 2)).toThrow("USE_RESTORE");
});

it("recreating a deleted desktop fences its old ID, credentials and creation receipt", () => {
  const deleted = {
    ...freshComputer("cat", 1),
    phase: "deleted" as const,
    remoteId: "bx_deleted1",
    tokenVersion: 4,
    receipt: { remoteId: "bx_deleted1", generation: 1, key: "old", body: "old request", at: 2 },
    quiesced: { remoteId: "bx_deleted1", generation: 1, at: 3 },
    checkpoint: {
      name: "saved",
      snapshotId: "snap",
      sourceRemoteId: "bx_deleted1",
      generation: 1,
      quiesced: true,
      at: 3,
    },
  };
  for (const kind of ["start", "upgrade"] as const) {
    const next = beginOperation(deleted, "recreate", kind, 5);
    expect(next).toMatchObject({
      generation: 2,
      tokenVersion: 5,
      previousIds: ["bx_deleted1"],
      checkpoint: deleted.checkpoint,
      operation: { id: "recreate", generation: 2 },
    });
    expect(next.remoteId).toBeUndefined();
    expect(next.receipt).toBeUndefined();
    expect(next.quiesced).toBeUndefined();
    expect(beginOperation(next, "recreate", kind, 6)).toEqual(next);
    const old: BoatSandbox = {
      id: "bx_deleted1",
      name: "kn-cat-g1",
      state: "blocked",
      labels: { "kitties.deployment": "prod", "kitties.kitty": "cat", "kitties.generation": "1" },
    };
    expect(ownsSandbox(old, "prod", "cat", next.generation, next.receipt)).toBe(false);
    expect(() => beginOperation(next, "competing", "start", 6)).toThrow("COMPUTER_BUSY");
  }
});
