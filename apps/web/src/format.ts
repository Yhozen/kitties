import { t } from "./i18n";

// Small helpers for what the page shows.

export function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + time;
}

// stepArgs renders the arguments of a step in a few words.
export function stepArgs(action: string, args?: Record<string, unknown>): string {
  if (!args) {
    return "";
  }
  switch (action) {
    case "click":
    case "double_click":
    case "move":
      return `${args.x ?? "?"}, ${args.y ?? "?"}${args.button ? " " + args.button : ""}`;
    case "type":
      return JSON.stringify(args.text ?? "");
    case "key":
      return String(args.keys ?? args.key ?? "");
    case "scroll":
      return `${args.direction ?? "down"} ×${args.amount ?? 3}`;
    case "open":
      return String(args.url ?? "");
    case "run":
      return Array.isArray(args.argv) ? args.argv.join(" ") : String(args.command ?? "");
    case "wait":
      return `${args.seconds ?? 1}s`;
    case "done":
      return "";
    default:
      return Object.keys(args).length ? JSON.stringify(args) : "";
  }
}

// stepSentence says a desktop step the way a person would: no coordinates, no commands. The
// technical form (stepArgs) stays for whoever hovers it.
export function stepSentence(action: string, args?: Record<string, unknown>): string {
  const a = args || {};
  switch (action) {
    case "open": {
      const url = String(a.url ?? "");
      let host = url;
      try {
        host = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        /* not an address: said as it is */
      }
      return host ? t("Opened {host}", { host }) : t("Opened a page");
    }
    case "click":
      return t("Clicked on the screen");
    case "double_click":
      return t("Double-clicked on the screen");
    case "move":
      return t("Moved the pointer");
    case "type": {
      const text = String(a.text ?? "");
      return text
        ? t("Typed “{text}”", { text: text.length > 40 ? text.slice(0, 40) + "…" : text })
        : t("Typed");
    }
    case "key":
      return t("Pressed {key}", { key: keyName(String(a.keys ?? a.key ?? "")) });
    case "scroll":
      return a.direction === "up" ? t("Scrolled up") : t("Scrolled down");
    case "drag":
      return t("Dragged on the screen");
    case "windows":
      return t("Looked at the open windows");
    case "focus":
      return a.title
        ? t("Brought “{title}” to the front", { title: String(a.title) })
        : t("Brought a window to the front");
    case "read_screen":
      return t("Read the text on the screen");
    case "page_read":
      return t("Read the page");
    case "page_click":
      return a.text
        ? t("Clicked “{text}” on the page", { text: String(a.text) })
        : t("Clicked on the page");
    case "page_type":
      return t("Filled in a field of the page");
    case "launch":
      return t("Opened a program");
    case "install": {
      const list = Array.isArray(a.packages) ? a.packages.join(", ") : String(a.packages ?? "");
      return list ? t("Installed {apps}", { apps: list }) : t("Installed programs");
    }
    case "ask_help":
      return a.reason
        ? t("Asked you for help: {reason}", { reason: String(a.reason) })
        : t("Asked you for help on its desktop");
    case "helped":
      return a.secret
        ? t("You typed it on its desktop")
        : a.told
          ? t("You answered")
          : t("You took the desktop and gave it back");
    case "held":
      return t("Waited while you used the desktop");
    case "wait":
      return t("Waited a moment");
    case "screenshot":
      return t("Looked at the screen");
    case "run":
      return t("Ran a program");
    case "done":
      return t("Finished");
  }
  const words = action.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// keyName says a key combination as it reads on a keyboard: Return is Enter, ctrl+l is Ctrl+L.
function keyName(keys: string): string {
  if (!keys) {
    return t("a key");
  }
  return keys
    .split("+")
    .map((k) => {
      const low = k.trim().toLowerCase();
      if (low === "return") {
        return "Enter";
      }
      if (low === "ctrl" || low === "control") {
        return "Ctrl";
      }
      return low.length === 1 ? low.toUpperCase() : low.charAt(0).toUpperCase() + low.slice(1);
    })
    .join("+");
}

// inline turns **bold** and `code` into elements; everything else stays text.
export function inline(text: string): (string | { t: "b" | "c"; v: string })[] {
  const out: (string | { t: "b" | "c"; v: string })[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) {
      out.push(text.slice(last, m.index));
    }
    out.push(m[1] !== undefined ? { t: "b", v: m[1] } : { t: "c", v: m[2] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) {
    out.push(text.slice(last));
  }
  return out;
}
