import { LibraryId } from "@kitties/domain/Library/Library.id";
import { Context, Effect, Schema } from "effect";

export const LibraryClientScope = Schema.Struct({
  owner: LibraryId,
  epoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sessionId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,80}$/)),
});

export type LibraryClientScope = typeof LibraryClientScope.Type;

export const ReauthenticationReason = Schema.Literals([
  "ChangedAuthority",
  "Denied",
  "Unavailable",
]);

export class LibraryReauthenticationFailed extends Schema.TaggedError<
  LibraryReauthenticationFailed,
  { readonly brand: unique symbol }
>()("LibraryReauthenticationFailed", { reason: ReauthenticationReason }) {}

// Success means a fresh same-owner/epoch client and watches are available.
export class LibraryClientAuthentication extends Context.Service<
  LibraryClientAuthentication,
  {
    readonly reauthenticate: (
      scope: LibraryClientScope,
    ) => Effect.Effect<void, LibraryReauthenticationFailed>;
  }
>()("@kitties/web/library/LibraryClientAuthentication") {}
