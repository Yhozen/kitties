import { describe, expect, test } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type { MessageView } from "@kitties/domain/entities";
import { applyChatEvent, ChatEvent } from "./chat-events";

const makeRunningMessage = (): typeof MessageView.Type => ({
  id: "message-1",
  payload: { chatId: "chat-1", messageId: "message-1", kittyId: "kitty-1", text: "Question" },
  status: "running",
  answer: "Old attempt",
  at: 1000,
  run_id: "run-1",
  revision: { round: 2, attempt: 1 },
});

describe("chat stream reconciliation", () => {
  test("does not duplicate a replayed message or overwrite its original question", () => {
    const current = [makeRunningMessage()];
    const before = structuredClone(current);

    const result = applyChatEvent(
      current,
      {
        type: "message",
        messageId: "message-1",
        kittyId: "kitty-2",
        text: "Replayed question",
      },
      "chat-1",
    );

    expect(result[0]?.payload).toEqual({
      chatId: "chat-1",
      messageId: "message-1",
      kittyId: "kitty-1",
      text: "Question",
    });
    expect(current[0]?.payload).toEqual({
      chatId: "chat-1",
      messageId: "message-1",
      kittyId: "kitty-1",
      text: "Question",
    });
    expect(result).toEqual(before);
    expect(current).toEqual(before);
  });

  test("queues a new message and waits for its revision before accepting deltas", () => {
    const queued = applyChatEvent(
      [],
      {
        type: "message",
        messageId: "message-2",
        kittyId: "kitty-2",
        text: "New question",
      },
      "chat-1",
    );

    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      id: "message-2",
      payload: {
        chatId: "chat-1",
        messageId: "message-2",
        kittyId: "kitty-2",
        text: "New question",
      },
      status: "queued",
      answer: "",
      run_id: null,
    });
    const beforeDelta = structuredClone(queued);
    expect(
      applyChatEvent(
        queued,
        {
          type: "delta",
          messageId: "message-2",
          round: 0,
          attempt: 0,
          text: "Premature",
        },
        "chat-1",
      ),
    ).toEqual(beforeDelta);
    expect(queued).toEqual(beforeDelta);
  });

  test("replaces a retried answer and appends only deltas from the current round and attempt", () => {
    const initial = [makeRunningMessage()];
    const before = structuredClone(initial);

    let current = applyChatEvent(
      initial,
      {
        type: "round_reset",
        messageId: "message-1",
        round: 2,
        attempt: 2,
        prefix: "Retry: ",
      },
      "chat-1",
    );

    for (const event of [
      { type: "delta", messageId: "message-1", round: 2, attempt: 1, text: "Old attempt" },
      { type: "delta", messageId: "message-1", round: 1, attempt: 99, text: "Old round" },
      { type: "delta", messageId: "message-1", round: 2, attempt: 3, text: "Unannounced retry" },
      { type: "delta", messageId: "message-1", round: 2, attempt: 2, text: "Current answer" },
    ] satisfies ChatEvent[])
      current = applyChatEvent(current, event, "chat-1");

    expect(current[0]).toMatchObject({
      answer: "Retry: Current answer",
      status: "running",
      revision: { round: 2, attempt: 2 },
    });
    expect(initial).toEqual(before);
    expect(initial[0]?.answer).toBe("Old attempt");
    expect(initial[0]?.revision).toEqual({ round: 2, attempt: 1 });
  });

  test("ignores duplicate and older resets but accepts a new round with a lower attempt", () => {
    const initial = [makeRunningMessage()];
    const before = structuredClone(initial);
    let current: readonly (typeof MessageView.Type)[] = initial;

    for (const event of [
      { type: "round_reset", messageId: "message-1", round: 2, attempt: 1, prefix: "Duplicate" },
      { type: "round_reset", messageId: "message-1", round: 1, attempt: 99, prefix: "Old round" },
      { type: "round_reset", messageId: "message-1", attempt: 99, prefix: "Missing round" },
    ] satisfies ChatEvent[])
      current = applyChatEvent(current, event, "chat-1");

    expect(current).toEqual(before);
    expect(initial).toEqual(before);
    expect(
      applyChatEvent(
        current,
        {
          type: "round_reset",
          messageId: "message-1",
          round: 3,
          attempt: 0,
          prefix: "Next round",
        },
        "chat-1",
      )[0],
    ).toMatchObject({ answer: "Next round", revision: { round: 3, attempt: 0 } });
    expect(current).toEqual(before);
    expect(initial).toEqual(before);
  });

  test("keeps an authoritative final answer when a buffered delta arrives before completion", () => {
    const initial = [makeRunningMessage()];
    const before = structuredClone(initial);

    const finalAnswer = applyChatEvent(
      initial,
      {
        type: "round_reset",
        messageId: "message-1",
        attempt: -1,
        prefix: "Final answer",
      },
      "chat-1",
    );

    expect(finalAnswer[0]).toMatchObject({ answer: "Final answer", revision: undefined });
    expect(initial).toEqual(before);
    const beforeDelta = structuredClone(finalAnswer);
    expect(
      applyChatEvent(
        finalAnswer,
        {
          type: "delta",
          messageId: "message-1",
          round: 2,
          attempt: 1,
          text: "Late fragment",
        },
        "chat-1",
      ),
    ).toEqual(beforeDelta);
    expect(finalAnswer).toEqual(beforeDelta);
  });

  const terminalEvents: ChatEvent[] = [
    { type: "completed", messageId: "message-1" },
    { type: "cancelled", messageId: "message-1" },
    { type: "failed", messageId: "message-1" },
  ];

  test.each(terminalEvents)("does not reopen a $type answer on late stream events", (terminal) => {
    const initial = [makeRunningMessage()];
    const before = structuredClone(initial);
    const expectedFinished = before.map((message) => ({ ...message, status: terminal.type }));
    const finished = applyChatEvent(initial, terminal, "chat-1");

    expect(finished).toEqual(expectedFinished);
    expect(initial).toEqual(before);

    const afterReset = applyChatEvent(
      finished,
      {
        type: "round_reset",
        messageId: "message-1",
        round: 3,
        attempt: 2,
        prefix: "Too late",
      },
      "chat-1",
    );

    expect(afterReset).toEqual(expectedFinished);
    expect(finished).toEqual(expectedFinished);

    const afterDelta = applyChatEvent(
      afterReset,
      {
        type: "delta",
        messageId: "message-1",
        round: 2,
        attempt: 1,
        text: "Too late",
      },
      "chat-1",
    );

    expect(afterDelta[0]).toMatchObject({ answer: "Old attempt", status: terminal.type });
    expect(afterDelta).toEqual(expectedFinished);
    expect(afterReset).toEqual(expectedFinished);
    expect(finished).toEqual(expectedFinished);
    expect(initial).toEqual(before);
  });

  test("ignores updates to an unknown message without appending a phantom answer", () => {
    const current = [makeRunningMessage()];
    const before = structuredClone(current);
    expect(
      applyChatEvent(
        current,
        {
          type: "delta",
          messageId: "unknown",
          round: 2,
          attempt: 1,
          text: "Wrong message",
        },
        "chat-1",
      ),
    ).toEqual(before);
    expect(current).toEqual(before);
  });
});

describe("chat event boundary", () => {
  it.effect("rejects a delta without the attempt needed to fence retries", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        Schema.decodeUnknownEffect(ChatEvent)({
          type: "delta",
          messageId: "message-1",
          round: 2,
          text: "Unversioned fragment",
        }),
      );

      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect.prop(
    "decoded deltas from a different retry never change the displayed answer",
    [Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000000 })), Schema.String],
    ([attempt, text]) =>
      Effect.gen(function* () {
        const current = [{ ...makeRunningMessage(), revision: { round: 2, attempt } }];
        const before = structuredClone(current);

        const event = yield* Schema.decodeUnknownEffect(ChatEvent)({
          type: "delta",
          messageId: "message-1",
          round: 2,
          attempt: attempt + 1,
          text,
        });

        expect(applyChatEvent(current, event, "chat-1")).toEqual(before);
        expect(current).toEqual(before);
      }),
    { arbitrary: { runs: 100, seed: "chat-retry-fence-v1" } },
  );
});
