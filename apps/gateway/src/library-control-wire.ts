import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { flow } from "effect/Function";
import * as Schema from "effect/Schema";
import { LibraryRecoveryError } from "./library-recovery-records.ts";

type LibraryControlReply<A> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Refused"; readonly reason: LibraryRecoveryError["reason"] };

/** Preserve expected journal refusals across native RPC's generic error boundary. */
export const libraryControlReply = <A, R>(effect: Effect.Effect<A, LibraryRecoveryError, R>) => {
  const Reply = Data.taggedEnum<LibraryControlReply<A>>();

  return effect.pipe(
    Effect.match({
      onFailure: (error) => Reply.Refused({ reason: error.reason }),
      onSuccess: (value) => Reply.Success({ value }),
    }),
  );
};

const Wire = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Success"), value: Schema.optional(Schema.Unknown) }),
  Schema.Struct({ _tag: Schema.Literal("Refused"), reason: LibraryRecoveryError.fields.reason }),
]);

export const decodeLibraryControlReply = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  flow(
    Schema.decodeUnknownEffect(Wire),
    Effect.mapError(() => new LibraryRecoveryError({ reason: "storage" })),
    Effect.flatMap((reply) =>
      Predicate.isTagged(reply, "Refused")
        ? Effect.fail(new LibraryRecoveryError({ reason: reply.reason }))
        : Schema.decodeUnknownEffect(schema)(reply.value).pipe(
            Effect.mapError(() => new LibraryRecoveryError({ reason: "storage" })),
          ),
    ),
  );
