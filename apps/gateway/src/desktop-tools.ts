import type { ToolDefinition } from "./entities.ts";
const properties: Record<string, Record<string, unknown>> = {
  click: {
    x: { type: "integer", minimum: 0, maximum: 1279 },
    y: { type: "integer", minimum: 0, maximum: 799 },
    button: { type: "integer", enum: [1, 2, 3] },
  },
  move: {
    x: { type: "integer", minimum: 0, maximum: 1279 },
    y: { type: "integer", minimum: 0, maximum: 799 },
  },
  scroll: {
    direction: { type: "string", enum: ["up", "down"] },
    amount: { type: "integer", minimum: 1, maximum: 20 },
  },
  key: { key: { type: "string", maxLength: 100 } },
  type: { text: { type: "string", maxLength: 4000 } },
  screenshot: {},
  browser_read: {},
  browser_click: { ref: { type: "string" } },
  browser_type: { ref: { type: "string" }, text: { type: "string", maxLength: 4000 } },
  ui_read: {},
  ui_click: { ref: { type: "string" } },
  ui_type: { ref: { type: "string" }, text: { type: "string", maxLength: 4000 } },
  type_secret: {
    ref: { type: "string", description: "Owner vault entry ID. Never include a secret value." },
  },
  ask_help: { reason: { type: "string", maxLength: 2000 } },
};
export const desktopTools: ToolDefinition[] = Object.entries(properties).map(
  ([action, fields]) => ({
    name: "desktop_" + action,
    connectionId: "desktop",
    remoteName: action,
    description:
      action === "screenshot"
        ? "Observe the desktop; use after a visual action batch."
        : action === "ask_help"
          ? "Ask the owner for help and wait for the desktop to be returned."
          : action === "type_secret"
            ? "Type an owner vault secret by reference. Requires owner approval."
            : action.startsWith("browser_")
              ? "Browser DOM references. Read before clicking or typing; stale references require a new read."
              : action.startsWith("ui_")
                ? "Native accessibility references. If unsupported, use screenshot and pixel controls."
                : "Desktop " + action,
    parameters: {
      type: "object",
      properties: fields,
      required: Object.keys(fields).filter((key) => key !== "button"),
      additionalProperties: false,
    },
    readOnly: ["screenshot", "browser_read", "ui_read"].includes(action),
    destructive: action === "type_secret",
  }),
);
