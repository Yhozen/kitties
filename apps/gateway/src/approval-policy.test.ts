import { it, expect } from "vitest";
import { authorization, trustThreshold } from "./approval-policy";
it("keeps the five demand thresholds", () =>
  expect([1, 2, 3, 4, 5].map(trustThreshold)).toEqual([2, 4, 6, 12, 0]));
it("always-risk actions cannot earn or receive automatic permission", () => {
  for (const mode of ["auto", "ask", undefined] as const)
    expect(authorization({ always: true, free: true, mode, streak: 100, demand: 1 })).toBe("ask");
  expect(authorization({ always: true, free: false, mode: "never", streak: 100, demand: 1 })).toBe(
    "never",
  );
});
it("honors explicit ask and never and never trusts at demand five", () => {
  expect(authorization({ always: false, free: false, streak: 6, demand: 3 })).toBe("run");
  expect(authorization({ always: false, free: false, streak: 100, demand: 5 })).toBe("ask");
  expect(authorization({ always: false, free: true, mode: "ask", streak: 100, demand: 1 })).toBe(
    "ask",
  );
});
