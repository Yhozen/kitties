import * as Schema from "effect/Schema";

export function receiptResult(text: string | null | undefined, status: string): Schema.Json {
  if (!text) return { status };

  try {
    return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(text));
  } catch {
    return { text, status };
  }
}

export const failedReceipt = Schema.is(Schema.Struct({ ok: Schema.Literal(false) }));
