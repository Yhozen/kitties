import { it, expect } from "vitest";
import { freshMemory, updateMemory, validScope } from "./memory.ts";
it("keeps pinned owner notes when distilled and strengthens normalized duplicates", () => {
  let memory = updateMemory(freshMemory(), {
    type: "remember",
    id: "one",
    scope: "user",
    text: "Use Spanish",
    source: "person",
    pinned: true,
    at: 1,
  });
  memory = updateMemory(memory, {
    type: "remember",
    id: "two",
    scope: "user",
    text: " USE  Spanish ",
    source: "kitty",
    pinned: false,
    at: 2,
  });
  expect(memory.notes).toHaveLength(1);
  expect(memory.notes[0].strength).toBe(2);
  memory = updateMemory(memory, {
    type: "distill",
    notes: [{ scope: "work", text: "Check results", strength: 2 }],
    at: 3,
    pending: 0,
  });
  expect(memory.notes.map((note) => note.text)).toEqual(["Use Spanish", "Check results"]);
});
it("adapts demand at four downs or ten consecutive ups and deduplicates feedback", () => {
  let memory = freshMemory();
  const down = { type: "feedback", id: "0", rating: "down", note: "", at: 1 } as const;
  memory = updateMemory(updateMemory(memory, down), down);
  expect(memory.profile.down).toBe(1);
  for (let i = 1; i < 4; i++) memory = updateMemory(memory, { ...down, id: String(i) });
  expect(memory.profile.demand).toBe(4);
  for (let i = 0; i < 10; i++)
    memory = updateMemory(memory, { ...down, rating: "up", id: `up-${i}` });
  expect(memory.profile.demand).toBe(3);
  expect(() => updateMemory(memory, { ...down, rating: "up" })).toThrow("FEEDBACK_CONFLICT");
});
it("validates project scopes and preserves newer feedback during distillation", () => {
  expect(validScope("project:release")).toBe(true);
  expect(validScope("project:../secret")).toBe(false);
  const memory = freshMemory();
  memory.profile.pending = 4;
  expect(
    updateMemory(memory, { type: "distill", notes: [], pending: 3, at: 1 }).profile.pending,
  ).toBe(1);
});
