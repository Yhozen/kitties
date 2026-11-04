import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export function chatEvents(
  events: (after: number) => Effect.Effect<readonly { seq: number; body: string }[], unknown>,
  cursor: number,
) {
  let after = cursor,
    heartbeat = 0;

  return Stream.fromEffectRepeat(
    Effect.gen(function* () {
      const rows = yield* events(after);
      let text = "";

      for (const row of rows) {
        after = row.seq;
        text += `id: ${row.seq}\ndata: ${row.body}\n\n`;
      }

      if (Date.now() - heartbeat >= 20000) {
        heartbeat = Date.now();
        text += ": heartbeat\n\n";
      }

      if (!text) yield* Effect.sleep(100);

      return new TextEncoder().encode(text);
    }),
  );
}
