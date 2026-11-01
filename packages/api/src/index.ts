import { RecoveryView, RecoveryKind } from "@kitties/domain/recovery";
import { Health, Session } from "@kitties/domain";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Schema from "effect/Schema";
import { Id } from "@kitties/domain";
import {
  ProviderInput,
  ProviderView,
  KittyInput,
  KittyView,
  ChatInput,
  ChatView,
  MessageInput,
  ChatDetail,
  ConnectionInput,
  OAuthStartInput,
  ConnectionView,
  ApprovalView,
  MemoryView,
  MemoryNoteInput,
  MemoryProfileInput,
  FeedbackInput,
  SkillInput,
  SkillView,
  VaultView,
  HelpView,
  ArtifactView,
  RunView,
  GoalInput,
  GoalView,
  HookInput,
  HookView,
  RuleInput,
  RuleView,
  NotificationPrefs,
  NotificationView,
  PushSubscriptionInput,
} from "@kitties/domain/entities";

export const Api = HttpApi.make("Kitties").add(
  HttpApiGroup.make("recovery").add(
    HttpApiEndpoint.post("resume", "/v1/recovery/resume", {
      payload: Schema.Struct({
        kind: Schema.Literals(["export", "restore", "purge"]),
        operationId: Id,
      }),
      success: Schema.Struct({ ok: Schema.Boolean }),
    }),
    HttpApiEndpoint.get("status", "/v1/recovery", { success: RecoveryView }),
    HttpApiEndpoint.post("export", "/v1/recovery/exports", {
      payload: Schema.Struct({ operationId: Id }),
      success: Schema.Struct({ executionId: Schema.String }),
    }),
    HttpApiEndpoint.post("purge", "/v1/recovery/purge", {
      payload: Schema.Struct({ operationId: Id }),
      success: Schema.Struct({ executionId: Schema.String }),
    }),
    HttpApiEndpoint.post("bookmark", "/v1/recovery/bookmark", {
      payload: Schema.Struct({
        kind: RecoveryKind,
        name: Schema.String,
        at: Schema.optional(Schema.Number),
      }),
      success: Schema.Struct({ bookmark: Schema.String }),
    }),
    HttpApiEndpoint.post("restore", "/v1/recovery/restore", {
      payload: Schema.Struct({
        operationId: Id,
        kind: RecoveryKind,
        name: Schema.String,
        bookmark: Schema.String,
      }),
      success: Schema.Struct({ executionId: Schema.String }),
    }),
  ),
  HttpApiGroup.make("signin").add(
    HttpApiEndpoint.get("features", "/v1/features", {
      success: Schema.Struct({ chatgpt: Schema.Boolean }),
    }),
    HttpApiEndpoint.get("status", "/v1/providers/:id/signin", {
      params: { id: Id },
      success: Schema.Struct({ status: Schema.String }),
    }),
    HttpApiEndpoint.post("start", "/v1/providers/:id/signin", {
      params: { id: Id },
      success: Schema.Struct({ url: Schema.String, expiresAt: Schema.Number }),
    }),
    HttpApiEndpoint.post("finish", "/v1/providers/:id/signin/finish", {
      params: { id: Id },
      payload: Schema.Struct({ url: Schema.String }),
      success: Schema.Struct({ ok: Schema.Boolean }),
    }),
    HttpApiEndpoint.delete("disconnect", "/v1/providers/:id/signin", {
      params: { id: Id },
      success: Schema.Void,
    }),
  ),
  HttpApiGroup.make("notifications").add(
    HttpApiEndpoint.get("get", "/v1/notifications", { success: NotificationView }),
    HttpApiEndpoint.put("save", "/v1/notifications", {
      payload: NotificationPrefs,
      success: Schema.Struct({ ok: Schema.Boolean }),
    }),
    HttpApiEndpoint.get("key", "/v1/notifications/key", {
      success: Schema.Struct({ publicKey: Schema.String }),
    }),
    HttpApiEndpoint.post("subscribe", "/v1/notifications/subscriptions", {
      payload: PushSubscriptionInput,
      success: Schema.Struct({ id: Schema.String }),
    }),
    HttpApiEndpoint.post("test", "/v1/notifications/test", {
      payload: Schema.Struct({ operationId: Id }),
      success: Schema.Struct({ ok: Schema.Boolean }),
    }),
    HttpApiEndpoint.post("digest", "/v1/notifications/digest", {
      payload: Schema.Struct({ operationId: Id }),
      success: Schema.Struct({ ok: Schema.Boolean }),
    }),
  ),
  HttpApiGroup.make("autonomy").add(
    HttpApiEndpoint.get("rules", "/v1/approval-rules", { success: Schema.Array(RuleView) }),
    HttpApiEndpoint.put("saveRule", "/v1/approval-rules", {
      payload: RuleInput,
      success: RuleView,
    }),
    HttpApiEndpoint.delete("removeRule", "/v1/approval-rules/:id", {
      params: { id: Schema.String },
      success: Schema.Void,
    }),
    HttpApiEndpoint.get("goals", "/v1/goals", { success: Schema.Array(GoalView) }),
    HttpApiEndpoint.put("saveGoal", "/v1/goals/:id", {
      params: { id: Id },
      payload: GoalInput,
      success: GoalView,
    }),
    HttpApiEndpoint.delete("removeGoal", "/v1/goals/:id", {
      params: { id: Id },
      success: Schema.Void,
    }),
    HttpApiEndpoint.post("runGoal", "/v1/goals/:id/run", {
      params: { id: Id },
      payload: Schema.Struct({ operationId: Id }),
      success: Schema.Struct({ chatId: Id }),
    }),
    HttpApiEndpoint.get("hooks", "/v1/hooks", { success: Schema.Array(HookView) }),
    HttpApiEndpoint.put("saveHook", "/v1/hooks/:id", {
      params: { id: Id },
      payload: HookInput,
      success: HookView,
    }),
    HttpApiEndpoint.delete("removeHook", "/v1/hooks/:id", {
      params: { id: Id },
      success: Schema.Void,
    }),
  ),
  HttpApiGroup.make("workspace").add(
    HttpApiEndpoint.get("journal", "/v1/kitties/:id/journal", {
      params: { id: Id },
      success: Schema.Array(Schema.Unknown),
    }),
    HttpApiEndpoint.get("memory", "/v1/kitties/:id/memory", {
      params: { id: Id },
      success: MemoryView,
    }),
    HttpApiEndpoint.post("remember", "/v1/kitties/:id/memory", {
      params: { id: Id },
      payload: MemoryNoteInput,
      success: MemoryView,
    }),
    HttpApiEndpoint.put("profile", "/v1/kitties/:id/memory/profile", {
      params: { id: Id },
      payload: MemoryProfileInput,
      success: MemoryView,
    }),
    HttpApiEndpoint.delete("forget", "/v1/kitties/:id/memory/:note", {
      params: { id: Id, note: Id },
      success: MemoryView,
    }),
    HttpApiEndpoint.post("distill", "/v1/kitties/:id/distill", {
      params: { id: Id },
      payload: Schema.Struct({ operationId: Id }),
      success: Schema.Struct({ executionId: Schema.String }),
    }),
    HttpApiEndpoint.post("feedback", "/v1/chats/:id/messages/:message/feedback", {
      params: { id: Id, message: Id },
      payload: FeedbackInput,
      success: MemoryView,
    }),
    HttpApiEndpoint.get("skills", "/v1/skills", { success: Schema.Array(SkillView) }),
    HttpApiEndpoint.put("saveSkill", "/v1/skills/:id", {
      params: { id: Id },
      payload: SkillInput,
      success: SkillView,
    }),
    HttpApiEndpoint.post("acceptSkill", "/v1/skills/:id/accept", {
      params: { id: Id },
      success: SkillView,
    }),
    HttpApiEndpoint.delete("removeSkill", "/v1/skills/:id", {
      params: { id: Id },
      success: Schema.Void,
    }),
    HttpApiEndpoint.get("vault", "/v1/vault", { success: Schema.Array(VaultView) }),
    HttpApiEndpoint.put("saveSecret", "/v1/vault/:id", {
      params: { id: Id },
      payload: Schema.Struct({ name: Schema.String, value: Schema.String }),
      success: Schema.Struct({ id: Id, name: Schema.String }),
    }),
    HttpApiEndpoint.delete("removeSecret", "/v1/vault/:id", {
      params: { id: Id },
      success: Schema.Void,
    }),
    HttpApiEndpoint.get("help", "/v1/help", { success: Schema.Array(HelpView) }),
    HttpApiEndpoint.post("decideHelp", "/v1/help/:id/decision", {
      params: { id: Schema.String },
      payload: Schema.Struct({ decision: Schema.Literals(["accept", "skip"]) }),
      success: Schema.Struct({ ok: Schema.Boolean }),
    }),
    HttpApiEndpoint.get("artifacts", "/v1/artifacts", { success: Schema.Array(ArtifactView) }),
    HttpApiEndpoint.get("runs", "/v1/runs", { success: Schema.Array(RunView) }),
  ),
  HttpApiGroup.make("system").add(
    HttpApiEndpoint.get("health", "/v1/health", { success: Health }),
    HttpApiEndpoint.get("session", "/v1/session", { success: Session }),
  ),
  HttpApiGroup.make("connections").add(
    HttpApiEndpoint.get("oauthStatus", "/v1/connections/:id/oauth", {
      params: { id: Id },
      success: Schema.Struct({ status: Schema.String }),
    }),
    HttpApiEndpoint.post("oauthDiscover", "/v1/connections/:id/oauth/discover", {
      params: { id: Id },
      success: Schema.Unknown,
    }),
    HttpApiEndpoint.post("oauthStart", "/v1/connections/:id/oauth/start", {
      params: { id: Id },
      payload: OAuthStartInput,
      success: Schema.Struct({ url: Schema.String, expiresAt: Schema.Number }),
    }),
    HttpApiEndpoint.delete("oauthDisconnect", "/v1/connections/:id/oauth", {
      params: { id: Id },
      success: Schema.Void,
    }),
    HttpApiEndpoint.get("list", "/v1/connections", { success: Schema.Array(ConnectionView) }),
    HttpApiEndpoint.put("save", "/v1/connections/:id", {
      params: { id: Id },
      payload: ConnectionInput,
      success: ConnectionView,
    }),
    HttpApiEndpoint.delete("remove", "/v1/connections/:id", {
      params: { id: Id },
      success: Schema.Void,
    }),
    HttpApiEndpoint.post("test", "/v1/connections/:id/test", {
      params: { id: Id },
      success: Schema.Struct({ tools: Schema.Array(Schema.Unknown) }),
    }),
  ),
  HttpApiGroup.make("approvals").add(
    HttpApiEndpoint.get("list", "/v1/approvals", { success: Schema.Array(ApprovalView) }),
    HttpApiEndpoint.post("decide", "/v1/approvals/:id/decision", {
      params: { id: Schema.String },
      payload: Schema.Struct({ approved: Schema.Boolean, digest: Schema.String }),
      success: Schema.Struct({ ok: Schema.Boolean }),
    }),
  ),
  HttpApiGroup.make("providers").add(
    HttpApiEndpoint.get("list", "/v1/providers", { success: Schema.Array(ProviderView) }),
    HttpApiEndpoint.put("save", "/v1/providers/:id", {
      params: { id: Id },
      payload: ProviderInput,
      success: ProviderView,
    }),
    HttpApiEndpoint.delete("remove", "/v1/providers/:id", {
      params: { id: Id },
      success: Schema.Void,
    }),
  ),
  HttpApiGroup.make("computers").add(
    HttpApiEndpoint.get("get", "/v1/kitties/:id/computer", {
      params: { id: Id },
      success: Schema.Unknown,
    }),
    HttpApiEndpoint.post("operate", "/v1/kitties/:id/computer/:operation", {
      params: {
        id: Id,
        operation: Schema.Literals(["start", "sleep", "restore", "delete", "resume", "upgrade"]),
      },
      payload: Schema.Struct({ operationId: Id }),
      success: Schema.Struct({ executionId: Schema.String }),
    }),
  ),
  HttpApiGroup.make("kitties").add(
    HttpApiEndpoint.get("list", "/v1/kitties", { success: Schema.Array(KittyView) }),
    HttpApiEndpoint.post("create", "/v1/kitties", { payload: KittyInput, success: KittyView }),
    HttpApiEndpoint.put("save", "/v1/kitties/:id", {
      params: { id: Id },
      payload: KittyInput,
      success: KittyView,
    }),
    HttpApiEndpoint.delete("remove", "/v1/kitties/:id", {
      params: { id: Id },
      success: Schema.Void,
    }),
  ),
  HttpApiGroup.make("chats").add(
    HttpApiEndpoint.put("save", "/v1/chats/:id", {
      params: { id: Id },
      payload: ChatInput,
      success: ChatView,
    }),
    HttpApiEndpoint.delete("remove", "/v1/chats/:id", { params: { id: Id }, success: Schema.Void }),
    HttpApiEndpoint.get("replay", "/v1/chats/:id/replay", {
      params: { id: Id },
      success: Schema.Array(
        Schema.Struct({
          messageId: Schema.String,
          callId: Schema.String,
          screenshot: Schema.String,
        }),
      ),
    }),
    HttpApiEndpoint.get("get", "/v1/chats/:id", { params: { id: Id }, success: ChatDetail }),
    HttpApiEndpoint.post("cancel", "/v1/chats/:id/cancel", {
      params: { id: Id },
      payload: Schema.Struct({ messageId: Id }),
      success: Schema.Struct({ ok: Schema.Boolean }),
    }),
    HttpApiEndpoint.post("resume", "/v1/chats/:id/resume", {
      params: { id: Id },
      payload: Schema.Struct({ messageId: Id }),
      success: Schema.Struct({ ok: Schema.Boolean }),
    }),
    HttpApiEndpoint.get("list", "/v1/chats", { success: Schema.Array(ChatView) }),
    HttpApiEndpoint.post("create", "/v1/chats", { payload: ChatInput, success: ChatView }),
    HttpApiEndpoint.post("send", "/v1/chats/:id/messages", {
      params: { id: Id },
      payload: MessageInput,
      success: Schema.Struct({ duplicate: Schema.Boolean }),
    }),
  ),
);
export const client = HttpApiClient.make(Api);
