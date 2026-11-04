import { expect, test } from "vitest";
import * as Schema from "effect/Schema";
import { MessageView } from "@kitties/domain/entities";
import { readMessagePage } from "./chat-history.ts";
import { sqliteFixture } from "./test/sqlite.ts";
import { applyChatEvent } from "../../web/src/chat-events.ts";

function fixture(count: number) {
  const fixture = sqliteFixture();
  fixture.database.exec(
    "CREATE TABLE messages (id TEXT PRIMARY KEY,payload TEXT,status TEXT,run_id TEXT,answer TEXT,at INTEGER); CREATE TABLE rounds (id TEXT,round INTEGER,attempt INTEGER,PRIMARY KEY(id,round))",
  );
  for (let i = 0; i < count; i++)
    fixture.database.prepare("INSERT INTO messages VALUES (?,?,'running',NULL,'partial',?)").run(
      `m${i}`,
      JSON.stringify({
        chatId: "chat",
        messageId: `m${i}`,
        kittyId: "cat",
        text: `question ${i}`,
      }),
      Math.floor(i / 3),
    );
  return fixture;
}

test("recent history and older pages keep a stable chronological order past 200 messages", () => {
  const { database, state } = fixture(405);
  try {
    const recent = readMessagePage(state.raw.storage.sql);
    expect(recent.hasMore).toBe(true);
    expect(recent.messages.map((m) => m.id)).toEqual(
      Array.from({ length: 200 }, (_, i) => `m${i + 205}`),
    );
    // A new turn between page requests cannot shift the keyset or hide an older turn.
    database.prepare("INSERT INTO messages VALUES ('new','{}','queued',NULL,'',999)").run();
    const earlier = readMessagePage(state.raw.storage.sql, recent.messages[0]!.id);
    expect(earlier.hasMore).toBe(true);
    expect(earlier.messages.map((m) => m.id)).toEqual(
      Array.from({ length: 200 }, (_, i) => `m${i + 5}`),
    );
    const first = readMessagePage(state.raw.storage.sql, earlier.messages[0]!.id);
    expect(first.hasMore).toBe(false);
    expect(first.messages.map((m) => m.id)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(readMessagePage(state.raw.storage.sql, "missing").messages).toEqual([]);
  } finally {
    database.close();
  }
});

test("a mid-round snapshot carries its latest round and attempt through the API into SSE", () => {
  const { database, state } = fixture(1);
  try {
    database.exec("INSERT INTO rounds VALUES ('m0',0,9),('m0',1,1)");
    const page = readMessagePage(state.raw.storage.sql);
    const message = Schema.decodeUnknownSync(MessageView)(page.messages[0]);
    expect(message.revision).toEqual({ round: 1, attempt: 1 });
    const next = applyChatEvent(
      [message],
      { type: "delta", messageId: "m0", round: 1, attempt: 1, text: " continued" },
      "chat",
    );
    expect(next[0]!.answer).toBe("partial continued");
    expect(
      applyChatEvent(
        next,
        { type: "delta", messageId: "m0", round: 0, attempt: 1, text: " stale" },
        "chat",
      )[0]!.answer,
    ).toBe("partial continued");
  } finally {
    database.close();
  }
});
