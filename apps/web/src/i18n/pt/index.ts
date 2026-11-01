import type { Dictionary } from "../../i18n";

// The Portuguese of every part of the page, merged: each file keeps its own.
const parts = import.meta.glob<{ default: Dictionary }>("./*.ts", { eager: true });

const pt: Dictionary = {};
for (const [path, mod] of Object.entries(parts)) {
  if (!path.endsWith("/index.ts")) {
    Object.assign(pt, mod.default);
  }
}

export default pt;
