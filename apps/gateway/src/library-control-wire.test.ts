import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { libraryControlReply, decodeLibraryControlReply } from "./library-control-wire.ts";
import { LibraryRecoveryError } from "./library-recovery-records.ts";

it.effect("preserves expected authority refusals through serialized native RPC replies", () =>
  Effect.gen(function* () {
    const reply = yield* libraryControlReply(
      Effect.fail(new LibraryRecoveryError({ reason: "fenced" })),
    );

    const wire: unknown = JSON.parse(JSON.stringify(reply));
    expect(yield* Effect.flip(decodeLibraryControlReply(Schema.String)(wire))).toEqual(
      new LibraryRecoveryError({ reason: "fenced" }),
    );
  }),
);

it.effect("validates successful values and void acknowledgements after transport", () =>
  Effect.gen(function* () {
    const value = yield* libraryControlReply(Effect.succeed(7));
    const done = yield* libraryControlReply(Effect.void);
    expect(yield* decodeLibraryControlReply(Schema.Int)(JSON.parse(JSON.stringify(value)))).toBe(7);
    expect(
      yield* decodeLibraryControlReply(Schema.Undefined)(JSON.parse(JSON.stringify(done))),
    ).toBeUndefined();
    expect(yield* Effect.flip(decodeLibraryControlReply(Schema.String)(value))).toEqual(
      new LibraryRecoveryError({ reason: "storage" }),
    );
  }),
);
