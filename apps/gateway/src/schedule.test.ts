import { describe, it, expect } from "vitest";
import { nextSlot } from "./schedule";
const next = (expression: string, after = "2026-11-01T08:59:59Z", tz = "UTC") =>
  new Date(nextSlot(expression, tz, Date.parse(after))).toISOString();
describe("goal schedule contracts", () => {
  it("preserves the owner daily alias at 09:00", () =>
    expect(next("@daily")).toBe("2026-11-01T09:00:00.000Z"));
  it("supports numeric starts with steps and Sunday 7", () =>
    expect(next("5/10 9 * * 7")).toBe("2026-11-01T09:05:00.000Z"));
  it("uses OR when both day fields are restricted", () =>
    expect(next("0 9 2 * 7")).toBe("2026-11-01T09:00:00.000Z"));
  it("keeps bare star distinct from */1", () =>
    expect(next("0 9 */1 * 1")).toBe("2026-11-01T09:00:00.000Z"));
  it("uses the goal timezone", () =>
    expect(next("@daily", "2026-11-01T08:59:59Z", "America/Sao_Paulo")).toBe(
      "2026-11-01T12:00:00.000Z",
    ));
  it("rejects invalid fields and unsupported names", () => {
    for (const expr of ["0 25 * * *", "*/0 * * * *", "* * * *", "0 9 * * MON"])
      expect(() => next(expr)).toThrow();
  });
});
