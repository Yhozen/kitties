import * as Effect from "effect/Effect";
import { savedHelpDecision, type HelpDecision, type HelpRecord } from "./help-store.ts";

// The decision record doubles as a durable signaling outbox until the workflow
// completes it. DurableDeferred completion is idempotent, including lost replies.
export const retryHelpDecisions = <E>(
  home: { list: (kind: string) => Effect.Effect<readonly { body: string }[], E> },
  signal: (executionId: string, decision: HelpDecision) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const rows = yield* home.list("desktop-help");
    yield* Effect.forEach(
      rows,
      ({ body }) => {
        const row = JSON.parse(body) as HelpRecord;
        const decision = savedHelpDecision(row);

        return decision && row.status !== "completed"
          ? signal(row.executionId, decision).pipe(Effect.catchCause(() => Effect.void))
          : Effect.void;
      },
      { concurrency: 5 },
    );
  });
