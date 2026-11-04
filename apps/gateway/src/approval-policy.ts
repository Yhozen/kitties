export type RuleMode = "auto" | "ask" | "never";

export const trustThreshold = (demand: number) =>
  [2, 4, 6, 12, 0][Math.max(0, Math.min(4, demand - 1))]!;

export function authorization(options: {
  always: boolean;
  free: boolean;
  mode?: RuleMode;
  streak: number;
  demand: number;
}): "run" | "ask" | "never" {
  if (options.mode === "never") return "never";

  if (options.always) return "ask";

  if (options.mode === "ask") return "ask";

  if (options.mode === "auto" || options.free) return "run";
  const threshold = trustThreshold(options.demand);

  return threshold > 0 && options.streak >= threshold ? "run" : "ask";
}
