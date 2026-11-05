import { flow } from "effect/Function";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { LibraryArchiveError } from "./library-retained-archive-store.ts";

type ArchiveReply<A> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Refused"; readonly reason: LibraryArchiveError["reason"] };

/** Expected archive refusals must survive the native RPC error boundary. */
export const libraryArchiveReply = <A, R>(effect: Effect.Effect<A, LibraryArchiveError, R>) => {
  const Reply = Data.taggedEnum<ArchiveReply<A>>();

  return effect.pipe(
    Effect.match({
      onFailure: (error) => Reply.Refused({ reason: error.reason }),
      onSuccess: (value) => Reply.Success({ value }),
    }),
  );
};

const Wire = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Success"), value: Schema.optional(Schema.Unknown) }),
  Schema.Struct({ _tag: Schema.Literal("Refused"), reason: LibraryArchiveError.fields.reason }),
]);

export const decodeLibraryArchiveReply = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  flow(
    Schema.decodeUnknownEffect(Wire),
    Effect.mapError(() => new LibraryArchiveError({ reason: "storage" })),
    Effect.flatMap((reply) =>
      Predicate.isTagged(reply, "Refused")
        ? Effect.fail(new LibraryArchiveError({ reason: reply.reason }))
        : Schema.decodeUnknownEffect(schema)(reply.value).pipe(
            Effect.mapError(() => new LibraryArchiveError({ reason: "storage" })),
          ),
    ),
  );
