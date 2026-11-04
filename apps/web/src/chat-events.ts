import * as Schema from "effect/Schema";
import type { MessageView } from "@kitties/domain/entities";

type Message = typeof MessageView.Type;
export const ChatEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("message"), messageId: Schema.String, text: Schema.String, kittyId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("round_reset"), messageId: Schema.String, round: Schema.optional(Schema.Number), attempt: Schema.Number, prefix: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("delta"), messageId: Schema.String, round: Schema.Number, attempt: Schema.Number, text: Schema.String }),
  Schema.Struct({ type: Schema.Literals(["completed", "cancelled", "failed"]), messageId: Schema.String }),
]);
export type ChatEvent = typeof ChatEvent.Type;

export function applyChatEvent(current: readonly Message[], event: ChatEvent, chatId: string): readonly Message[] {
  if (event.type === "message") return current.some(m => m.id === event.messageId) ? current : [...current, {
    id: event.messageId, payload: { chatId, messageId: event.messageId, text: event.text, kittyId: event.kittyId },
    status: "queued", answer: "", at: Date.now(), run_id: null,
  }];
  return current.map(message => {
    if (message.id !== event.messageId) return message;
    const active = ["queued", "running"].includes(message.status);
    if (event.type === "round_reset" && active) {
      // resolveTurn publishes an authoritative final answer before the terminal event.
      if (event.attempt === -1) return { ...message, answer: event.prefix ?? "", revision: undefined };
      if (event.round === undefined) return message;
      const revision = message.revision;
      if (revision && (event.round < revision.round || (event.round === revision.round && event.attempt <= revision.attempt))) return message;
      return { ...message, status: "running", answer: event.prefix ?? "", revision: { round: event.round, attempt: event.attempt } };
    }
    if (event.type === "delta" && active && message.revision?.round === event.round && message.revision.attempt === event.attempt)
      return { ...message, answer: message.answer + event.text };
    if (["completed", "cancelled", "failed"].includes(event.type)) return { ...message, status: event.type };
    return message;
  });
}
