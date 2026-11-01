import * as Schema from "effect/Schema";
import { Id } from "./index.ts";
interface Envelope {
  kid: string;
  iv: string;
  ct: string;
}

export const ProviderInput = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  kind: Schema.Literals(["openai", "anthropic", "openrouter", "compat", "gemini"]),
  model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  baseUrl: Schema.optional(Schema.String),
  apiKey: Schema.optional(Schema.String.check(Schema.isMaxLength(8192))),
  temperature: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 2 }))),
});
export type Provider = Omit<typeof ProviderInput.Type, "apiKey"> & {
  id: string;
  secret?: Envelope;
};
export const KittyInput = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  soul: Schema.String.check(Schema.isMaxLength(32000)),
  providerId: Schema.optional(Id),
  breed: Schema.optional(Schema.String),
  color: Schema.optional(Schema.String),
  limits: Schema.optional(
    Schema.Struct({
      max_rounds: Schema.Number.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: 1, maximum: 100 }),
      ),
      retries: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 5 })),
      day_tokens: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
      day_actions: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
});
export type KittyProfile = typeof KittyInput.Type & { id: string; createdAt: number };
export const MessageInput = Schema.Struct({
  messageId: Id,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32000)),
  kittyId: Id,
});
export const ChatInput = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  members: Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
});
export interface ChatProfile {
  id: string;
  title: string;
  members: readonly string[];
  createdAt: number;
}
export const ProviderView = Schema.Struct({
  id: Id,
  name: Schema.String,
  kind: ProviderInput.fields.kind,
  model: Schema.String,
  baseUrl: Schema.optional(Schema.String),
  temperature: Schema.optional(Schema.Number),
  hasKey: Schema.Boolean,
});
export const KittyView = Schema.Struct({
  ...KittyInput.fields,
  id: Id,
  createdAt: Schema.Number,
  status: Schema.String,
});
export const ChatView = Schema.Struct({
  id: Id,
  title: Schema.String,
  members: Schema.Array(Id),
  createdAt: Schema.Number,
});
export const MessageView = Schema.Struct({
  id: Id,
  payload: Schema.Struct({ ...MessageInput.fields, chatId: Id }),
  status: Schema.String,
  run_id: Schema.NullOr(Schema.String),
  answer: Schema.String,
  at: Schema.Number,
});
export const ChatDetail = Schema.Struct({
  ...ChatView.fields,
  messages: Schema.Array(MessageView),
  cursor: Schema.Number,
});
export const MemoryNoteInput = Schema.Struct({
  scope: Schema.String.check(Schema.isMaxLength(48)),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
});
export const MemoryProfileInput = Schema.Struct({
  demand: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 5 })),
  auto: Schema.Boolean,
});
export const SkillInput = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  body: Schema.String.check(Schema.isMaxLength(64000)),
  status: Schema.Literals(["proposed", "accepted"]),
});
export const SkillView = Schema.Struct({ ...SkillInput.fields, id: Id, updatedAt: Schema.Number });
export const FeedbackInput = Schema.Struct({
  rating: Schema.Literals(["up", "down"]),
  note: Schema.String.check(Schema.isMaxLength(300)),
});
export const MemoryView = Schema.Struct({
  notes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      scope: Schema.String,
      text: Schema.String,
      strength: Schema.Number,
      pinned: Schema.Boolean,
    }),
  ),
  profile: Schema.Struct({
    demand: Schema.Number,
    auto: Schema.Boolean,
    up: Schema.Number,
    down: Schema.Number,
    pending: Schema.Number,
  }),
});
export const VaultView = Schema.Struct({ id: Id, name: Schema.String, updatedAt: Schema.Number });
export const HelpView = Schema.Struct({
  id: Schema.String,
  kittyId: Id,
  reason: Schema.String,
  expiresAt: Schema.Number,
  status: Schema.String,
});
export const ArtifactView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  size: Schema.Number,
  updatedAt: Schema.Number,
});
export const RunView = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  code: Schema.optional(Schema.String),
  updatedAt: Schema.Number,
  chatId: Schema.optional(Id),
  messageId: Schema.optional(Id),
});
export const GoalInput = Schema.Struct({
  kittyId: Id,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  instruction: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16000)),
  schedule: Schema.String.check(Schema.isMaxLength(100)),
  timezone: Schema.String.check(Schema.isMaxLength(100)),
  enabled: Schema.Boolean,
});
export const GoalView = Schema.Struct({
  ...GoalInput.fields,
  id: Id,
  revision: Schema.Number,
  chatId: Id,
  nextSlot: Schema.Number,
  updatedAt: Schema.Number,
});
export type Goal = typeof GoalView.Type;
export const HookInput = Schema.Struct({
  goalId: Id,
  kind: Schema.Literals(["github", "stripe", "generic"]),
  secret: Schema.optional(Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(8192))),
});
export const HookView = Schema.Struct({
  id: Id,
  goalId: Id,
  kind: HookInput.fields.kind,
  hasSecret: Schema.Boolean,
});

export const ConnectionInput = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  kind: Schema.Literals(["mcp", "http", "ntfy"]),
  url: Schema.String.check(Schema.isMaxLength(2048)),
  token: Schema.optional(Schema.String.check(Schema.isMaxLength(16384))),
  allowReads: Schema.Boolean,
});
export type Connection = Omit<typeof ConnectionInput.Type, "token"> & {
  id: string;
  secret?: Envelope;
};
export const ConnectionView = Schema.Struct({
  id: Id,
  name: Schema.String,
  kind: ConnectionInput.fields.kind,
  url: Schema.String,
  allowReads: Schema.Boolean,
  hasToken: Schema.Boolean,
});
export const ApprovalView = Schema.Struct({
  id: Schema.String,
  executionId: Schema.String,
  chatId: Schema.String,
  messageId: Schema.String,
  kittyId: Schema.String,
  tool: Schema.String,
  digest: Schema.String,
  preview: Schema.String,
  expiresAt: Schema.Number,
  status: Schema.Literals(["pending", "approved", "denied", "expired", "cancelled"]),
});
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  connectionId: string;
  remoteName: string;
  readOnly: boolean;
  destructive: boolean;
}
export interface ToolCall {
  id: string;
  name: string;
  params: unknown;
}
export interface ModelRound {
  calls: ToolCall[];
  tools: ToolDefinition[];
  tokens: number;
}
export interface ApprovalRecord {
  id: string;
  executionId: string;
  chatId: string;
  messageId: string;
  kittyId: string;
  tool: string;
  digest: string;
  preview: string;
  expiresAt: number;
  status: "pending" | "approved" | "denied" | "expired" | "cancelled";
  policyKey?: string;
}
export const RuleInput = Schema.Struct({
  kittyId: Id,
  connectionId: Schema.String.check(Schema.isMaxLength(128)),
  action: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  mode: Schema.Literals(["auto", "ask", "never"]),
});
export const RuleView = Schema.Struct({ ...RuleInput.fields, id: Schema.String });
export const NotificationPrefs = Schema.Struct({
  enabled: Schema.Boolean,
  events: Schema.Array(Schema.Literals(["approval", "completed", "help", "health"])),
});
export const NotificationView = Schema.Struct({
  settings: NotificationPrefs,
  subscriptions: Schema.Number,
  batches: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      status: Schema.String,
      count: Schema.Number,
      dueAt: Schema.Number,
      delivered: Schema.optional(Schema.Number),
    }),
  ),
});
export const PushSubscriptionInput = Schema.Struct({
  endpoint: Schema.String,
  expirationTime: Schema.NullOr(Schema.Number),
  keys: Schema.Struct({ p256dh: Schema.String, auth: Schema.String }),
});
