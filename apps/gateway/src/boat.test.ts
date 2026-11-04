import { describe, expect, it } from "vite-plus/test";
import { ownsSandbox, type BoatSandbox, type RemoteReceipt } from "./boat.ts";

const deployment = "production-west";
const kittyId = "miso";
const generation = 7;

const labels = {
  "kitties.deployment": deployment,
  "kitties.kitty": kittyId,
  "kitties.generation": String(generation),
};

const sandbox: BoatSandbox = {
  id: "remote-miso-7",
  name: "kn-miso-g7",
  state: "running",
  labels,
};

const receipt: RemoteReceipt = {
  remoteId: sandbox.id,
  generation,
  key: "create-miso-7",
  body: JSON.stringify({ name: sandbox.name, labels }),
  at: 1,
};

describe("Boat sandbox ownership", () => {
  it("accepts the exact deployment, kitty, generation, and name without a receipt", () => {
    expect(ownsSandbox(sandbox, deployment, kittyId, generation)).toBe(true);
  });

  it.each([
    { label: "absent", sandbox: { id: sandbox.id, name: sandbox.name, state: sandbox.state } },
    { label: "null", sandbox: { ...sandbox, labels: null } },
    { label: "empty", sandbox: { ...sandbox, labels: {} } },
  ])("uses the persisted create receipt when restore leaves $label labels", (restored) => {
    expect(ownsSandbox(restored.sandbox, deployment, kittyId, generation, receipt)).toBe(true);
    expect(ownsSandbox(restored.sandbox, deployment, kittyId, generation)).toBe(false);
  });

  it.each([
    { label: "deployment", labels: { ...labels, "kitties.deployment": "preview-west" } },
    { label: "kitty", labels: { ...labels, "kitties.kitty": "other-kitty" } },
    { label: "generation", labels: { ...labels, "kitties.generation": "6" } },
  ])("refuses a sandbox whose $label label belongs elsewhere", (other) => {
    expect(ownsSandbox({ ...sandbox, labels: other.labels }, deployment, kittyId, generation)).toBe(
      false,
    );
  });

  it("does not treat the expected name as ownership evidence by itself", () => {
    expect(ownsSandbox({ ...sandbox, labels: {} }, deployment, kittyId, generation)).toBe(false);
  });

  it("rejects shared access even with matching labels or a matching receipt", () => {
    expect(
      ownsSandbox({ ...sandbox, access: "shared" }, deployment, kittyId, generation, receipt),
    ).toBe(false);
    expect(
      ownsSandbox(
        { ...sandbox, labels: {}, access: "shared" },
        deployment,
        kittyId,
        generation,
        receipt,
      ),
    ).toBe(false);
  });

  it("rejects a different sandbox name even when every label matches", () => {
    expect(
      ownsSandbox({ ...sandbox, name: "kn-miso-g8" }, deployment, kittyId, generation, receipt),
    ).toBe(false);
  });

  it.each([
    { reason: "different remote ID", receipt: { ...receipt, remoteId: "remote-other-7" } },
    { reason: "different receipt generation", receipt: { ...receipt, generation: 6 } },
    { reason: "missing idempotency key", receipt: { ...receipt, key: "" } },
    {
      reason: "different original request name",
      receipt: { ...receipt, body: JSON.stringify({ name: "kn-other-g7", labels }) },
    },
    {
      reason: "different original deployment",
      receipt: {
        ...receipt,
        body: JSON.stringify({
          name: sandbox.name,
          labels: { ...labels, "kitties.deployment": "preview-west" },
        }),
      },
    },
    {
      reason: "different original kitty",
      receipt: {
        ...receipt,
        body: JSON.stringify({
          name: sandbox.name,
          labels: { ...labels, "kitties.kitty": "other-kitty" },
        }),
      },
    },
    {
      reason: "different original generation",
      receipt: {
        ...receipt,
        body: JSON.stringify({
          name: sandbox.name,
          labels: { ...labels, "kitties.generation": "6" },
        }),
      },
    },
  ])("refuses receipt fallback with $reason", (other) => {
    expect(
      ownsSandbox({ ...sandbox, labels: {} }, deployment, kittyId, generation, other.receipt),
    ).toBe(false);
  });

  it.each([
    { reason: "invalid JSON", body: "{not-json" },
    { reason: "null body", body: "null" },
    { reason: "array body", body: "[]" },
    { reason: "missing name", body: JSON.stringify({ labels }) },
    { reason: "missing labels", body: JSON.stringify({ name: sandbox.name }) },
    { reason: "null labels", body: JSON.stringify({ name: sandbox.name, labels: null }) },
    {
      reason: "non-string generation label",
      body: JSON.stringify({
        name: sandbox.name,
        labels: { ...labels, "kitties.generation": generation },
      }),
    },
  ])("fails closed without throwing for a receipt with $reason", (invalid) => {
    expect(
      ownsSandbox({ ...sandbox, labels: {} }, deployment, kittyId, generation, {
        ...receipt,
        body: invalid.body,
      }),
    ).toBe(false);
  });
});
