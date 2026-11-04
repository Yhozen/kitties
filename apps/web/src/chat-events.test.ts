import { expect, test } from "vitest";
import { applyChatEvent, type ChatEvent } from "./chat-events.ts";

const message = { id: "message", payload: { chatId: "chat", messageId: "message", kittyId: "cat", text: "question" }, status: "running", answer: "round zero", at: 1, run_id: null, revision: { round: 0, attempt: 2 } };
const reduce = (events: ChatEvent[]) => events.reduce((messages, event) => applyChatEvent(messages, event, "chat"), [message] as Parameters<typeof applyChatEvent>[0]);

test("round changes accept a lower attempt while stale rounds and attempts cannot rewind text", () => {
  const result = reduce([
    { type: "round_reset", messageId: "message", round: 1, attempt: 1, prefix: "round zero" },
    { type: "delta", messageId: "message", round: 1, attempt: 1, text: " / one" },
    { type: "delta", messageId: "message", round: 0, attempt: 1, text: "stale" },
    { type: "round_reset", messageId: "message", round: 0, attempt: 3, prefix: "stale" },
    { type: "round_reset", messageId: "message", round: 1, attempt: 1, prefix: "replayed reset" },
    { type: "round_reset", messageId: "message", round: 1, attempt: 2, prefix: "round zero" },
    { type: "delta", messageId: "message", round: 1, attempt: 1, text: "stale attempt" },
    { type: "delta", messageId: "message", round: 1, attempt: 2, text: " / retry" },
  ]);
  expect(result[0]).toMatchObject({ answer: "round zero / retry", revision: { round: 1, attempt: 2 } });
});

test("authoritative final answers work without a round and terminal messages reject late deltas", () => {
  const result = reduce([
    { type: "round_reset", messageId: "message", attempt: -1, prefix: "final answer" },
    { type: "completed", messageId: "message" },
    { type: "delta", messageId: "message", round: 0, attempt: 2, text: " stale" },
    { type: "round_reset", messageId: "message", round: 2, attempt: 1, prefix: "late" },
  ]);
  expect(result[0]).toMatchObject({ answer: "final answer", status: "completed" });
});

test("new messages start queued and only append after their matching round reset", () => {
  let messages = applyChatEvent([], { type: "message", messageId: "new", text: "hi", kittyId: "cat" }, "chat");
  messages = applyChatEvent(messages, { type: "round_reset", messageId: "new", round: 0, attempt: 1 }, "chat");
  messages = applyChatEvent(messages, { type: "delta", messageId: "new", round: 0, attempt: 1, text: "hello" }, "chat");
  expect(messages[0]).toMatchObject({ answer: "hello", status: "running" });
});
