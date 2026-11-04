import * as Schema from "effect/Schema";
import type { ToolDefinition } from "./entities.ts";

export const DelegateInput = Schema.Struct({
  tasks: Schema.Array(
    Schema.Struct({
      kittyId: Schema.String,
      instruction: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16000)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
});

export const LimitToolInput = Schema.Struct({
  connectionId: Schema.String,
  action: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  mode: Schema.Literals(["ask", "never", "none"]),
});

const make = (
  remoteName: string,
  description: string,
  parameters: Record<string, unknown>,
  readOnly = false,
): ToolDefinition => ({
  name: `kitty_${remoteName}`,
  connectionId: "kitty",
  remoteName,
  description,
  parameters,
  readOnly,
  destructive: false,
});

export const autonomyTools = (
  team: { id: string; name: string }[],
  kittyId: string,
  depth: number,
) => [
  make(
    "give_up",
    "When you cannot finish, hand the task to your configured backup kitty. If there is no backup, ask the owner for help.",
    {
      type: "object",
      properties: { reason: { type: "string", maxLength: 1000 } },
      required: ["reason"],
      additionalProperties: false,
    },
  ),
  make(
    "journal",
    "Read your recent task journal and daily usage",
    { type: "object", properties: {}, required: [], additionalProperties: false },
    true,
  ),
  make(
    "limit",
    "Only when the owner asks, limit your actions on a connection. ask requires approval; never blocks; none removes your specific limit. Always-risk actions still require approval. Use action '*' for all actions.",
    {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        action: { type: "string" },
        mode: { type: "string", enum: ["ask", "never", "none"] },
      },
      required: ["connectionId", "action", "mode"],
      additionalProperties: false,
    },
  ),
  ...(depth < 2 && team.some((cat) => cat.id !== kittyId)
    ? [
        make(
          "delegate",
          `Ask teammates to perform independent tasks and return their results. Team: ${team
            .filter((cat) => cat.id !== kittyId)
            .map((cat) => `${cat.name} (${cat.id})`)
            .join(", ")}. Delegation depth is limited to two.`,
          {
            type: "object",
            properties: {
              tasks: {
                type: "array",
                minItems: 1,
                maxItems: 5,
                items: {
                  type: "object",
                  properties: {
                    kittyId: {
                      type: "string",
                      enum: team.filter((cat) => cat.id !== kittyId).map((cat) => cat.id),
                    },
                    instruction: { type: "string", maxLength: 16000 },
                  },
                  required: ["kittyId", "instruction"],
                  additionalProperties: false,
                },
              },
            },
            required: ["tasks"],
            additionalProperties: false,
          },
        ),
      ]
    : []),
];
