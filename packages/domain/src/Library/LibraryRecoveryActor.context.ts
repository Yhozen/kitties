import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { LibraryId } from "./Library.id.ts";

// A separate capability provided only by the trusted server recovery coordinator.
export const LibraryRecoveryActorValue = Schema.Struct({ libraryId: LibraryId });

export type LibraryRecoveryActorValue = typeof LibraryRecoveryActorValue.Type;

export class LibraryRecoveryActor extends Domain.RequestContext<LibraryRecoveryActor>()(
  "@kitties/domain/LibraryRecoveryActor",
  LibraryRecoveryActorValue,
) {}
