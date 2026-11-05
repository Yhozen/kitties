// The colour mode, saved in localStorage and applied to <html> as data attributes. The palette is
// the Motita design system (themes.css); public/theme-init.js applies the saved choice before the
// first paint.
import { changeBrowserPreferences, readBrowserPreferences } from "./browser-preferences.ts";

export type Mode = "system" | "light" | "dark";

export function savedMode(): Mode {
  const q = new URLSearchParams(location.search).get("theme");
  if (q === "light" || q === "dark") {
    return q;
  }
  try {
    // Dark unless the person picked light or the system's.
    return readBrowserPreferences().theme;
  } catch {
    return "dark";
  }
}

export function applyMode(mode: Mode): void {
  const resolved =
    mode === "system"
      ? matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : mode;
  const root = document.documentElement;
  root.dataset.mode = resolved;
  root.dataset.scheme = "motita";
  root.style.colorScheme = resolved;
}

export async function cycleMode(): Promise<void> {
  const next: Record<Mode, Mode> = { system: "dark", dark: "light", light: "system" };
  const mode = next[savedMode()];
  await changeBrowserPreferences({ theme: mode });
  applyMode(mode);
}
