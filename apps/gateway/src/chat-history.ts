import type * as Cloudflare from "@alchemy.run/cloudflare";
import type * as Effect from "effect/Effect";
import type { Turn } from "./turn-definition.ts";

interface MessageRow {
  [key: string]: string | number | null;
  id: string;
  payload: string;
  status: string;
  run_id: string | null;
  answer: string;
  at: number;
  stream_round: number | null;
  stream_attempt: number | null;
}

// Keyset pagination uses the same stable ordering for equal timestamps as the turn queue.
// Read the newest window first, then present it in conversation order.
export function readMessagePage(
  sql: Effect.Success<typeof Cloudflare.DurableObjectState>["raw"]["storage"]["sql"],
  before?: string,
) {
  const rows = sql
    .exec<MessageRow>(
      `SELECT messages.*,rounds.round AS stream_round,rounds.attempt AS stream_attempt
     FROM messages LEFT JOIN rounds ON rounds.id=messages.id
       AND rounds.round=(SELECT MAX(round) FROM rounds WHERE id=messages.id)
     WHERE (? IS NULL OR (messages.at,messages.rowid)<(SELECT at,rowid FROM messages WHERE id=?))
     ORDER BY messages.at DESC,messages.rowid DESC LIMIT 201`,
      before ?? null,
      before ?? null,
    )
    .toArray();
  return {
    hasMore: rows.length > 200,
    messages: rows
      .slice(0, 200)
      .reverse()
      .map(({ stream_round, stream_attempt, ...row }) => ({
        ...row,
        payload: JSON.parse(row.payload) as typeof Turn.payloadSchema.Type,
        ...(stream_round !== null && stream_attempt !== null
          ? { revision: { round: stream_round, attempt: stream_attempt } }
          : {}),
      })),
  };
}
