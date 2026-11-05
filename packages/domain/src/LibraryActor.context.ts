import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { LibraryId } from "./Library/Library.id.ts";

export const LibraryActorValue = Schema.Struct({
  libraryId: LibraryId,
  authority: Schema.Literals(["owner", "import"]),
  // Set by trusted middleware after reading the owner's authoritative import state.
  importFinalized: Schema.Boolean,
});

export type LibraryActorValue = typeof LibraryActorValue.Type;

export class LibraryActor extends Domain.RequestContext<LibraryActor>()(
  "@kitties/domain/LibraryActor",
  LibraryActorValue,
) {}
