// Integration fixtures belong here; production imports may not depend on this package.
export const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) throw new Error("A percentile requires samples");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]!;
};

export { scriptedLanguageModel } from "./model.ts";
export { FakeKittyd } from "./kittyd.ts";
