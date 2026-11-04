import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { stored } from "./stored-records.ts";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";

export type HelpDecision = "accept" | "skip";

export const HelpRecord = Schema.Struct({
  status: Schema.String,
  expiresAt: Schema.Number,
  executionId: Schema.String,
  kittyId: Schema.String,
  decision: Schema.optional(Schema.Literals(["accept", "skip"])),
});

export type HelpRecord = typeof HelpRecord.Type;

export const savedHelpDecision = (row: HelpRecord): HelpDecision | undefined =>
  row.decision ?? (row.status === "accept" || row.status === "skip" ? row.status : undefined);

function makeHelpStore(state: Effect.Success<typeof Cloudflare.DurableObjectState>) {
  const { sql } = state.raw.storage;

  const read = (id: string) => {
    const row = sql
      .exec<{ body: string }>("SELECT body FROM records WHERE kind='desktop-help' AND id=?", id)
      .toArray()[0];

    return row ? stored(HelpRecord, row.body) : undefined;
  };

  const write = (id: string, row: HelpRecord) =>
    sql.exec(
      "UPDATE records SET body=?,updated_at=? WHERE kind='desktop-help' AND id=?",
      JSON.stringify(row),
      Date.now(),
      id,
    );

  return {
    decide: (id: string, decision: HelpDecision) =>
      state.raw.storage.transactionSync(() => {
        const row = read(id);

        if (!row) return false;
        const accepted = savedHelpDecision(row);

        // The same accepted choice remains retryable even after expiry/completion.
        if (accepted) return accepted === decision;

        if (row.status !== "pending" || row.expiresAt <= Date.now()) return false;
        write(id, { ...row, status: decision, decision });

        return true;
      }),
    complete: (id: string) =>
      state.raw.storage.transactionSync(() => {
        const row = read(id);

        if (!row) return null;
        // Serialize completion with owner decisions. A timer or lost signal must
        // never override a choice already committed by the actor.
        const decision = savedHelpDecision(row) ?? "skip";
        write(id, { ...row, status: "completed", decision });

        return decision;
      }),
  };
}

export class HelpStore extends Context.Service<HelpStore, ReturnType<typeof makeHelpStore>>()(
  "@kitties/gateway/HelpStore",
) {
  static readonly layer = Layer.effect(
    HelpStore,
    Effect.map(Cloudflare.DurableObjectState, makeHelpStore),
  );
}
