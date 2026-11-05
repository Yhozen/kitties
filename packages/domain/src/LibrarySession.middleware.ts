import * as Schema from "effect/Schema";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import { LibraryActor, type LibraryActorValue } from "./LibraryActor.context.ts";
import { LibraryId } from "./Library/Library.id.ts";
import { detailOwner, SkillDetailKey } from "./Library/Skill.id.ts";
import {
  LibraryRecoveryActor,
  type LibraryRecoveryActorValue,
} from "./Library/LibraryRecoveryActor.context.ts";

export class LibraryUnauthorized extends Schema.TaggedError<
  LibraryUnauthorized,
  { readonly brand: unique symbol }
>()("LibraryUnauthorized", {}) {}

export class LibrarySession extends RpcMiddleware.Service<
  LibrarySession,
  { provides: LibraryActor }
>()("@kitties/domain/LibrarySession", { error: LibraryUnauthorized }) {}

export class LibraryImportSession extends RpcMiddleware.Service<
  LibraryImportSession,
  { provides: LibraryActor }
>()("@kitties/domain/LibraryImportSession", { error: LibraryUnauthorized }) {}

export class LibraryRecoverySession extends RpcMiddleware.Service<
  LibraryRecoverySession,
  { provides: LibraryRecoveryActor }
>()("@kitties/domain/LibraryRecoverySession", { error: LibraryUnauthorized }) {}

// Decode both selectors together: a union could discard the conflicting selector.
export const LibraryRequestPayload = Schema.Struct({
  target: Schema.optional(LibraryId),
  key: Schema.optional(Schema.Union([LibraryId, SkillDetailKey])),
});

export type LibraryRequestPayload = typeof LibraryRequestPayload.Type;

export const ownsLibraryRecoveryPayload = (
  actor: LibraryRecoveryActorValue,
  rpcTag: string,
  payload: LibraryRequestPayload,
): boolean =>
  rpcTag === "AdvanceLibraryAllocatorFloor" &&
  payload.key === undefined &&
  payload.target === actor.libraryId;

export const ownsLibraryPayload = (
  actor: LibraryActorValue,
  rpcTag: string,
  payload: LibraryRequestPayload,
): boolean => {
  if (payload.target !== undefined && payload.key !== undefined) {
    return false;
  }

  switch (rpcTag) {
    case "ProposeSkill":
    case "AcceptSkill":
    case "RemoveSkill":
      return actor.authority === "owner" && payload.target === actor.libraryId;
    case "ImportSkill":
    case "FinalizeLibraryImport":
      return actor.authority === "import" && payload.target === actor.libraryId;
    case "Library.get":
    case "Library.watch":
    case "Library.events":
      return actor.authority === "owner" && payload.key === actor.libraryId;
    case "SkillDetail.get":
    case "SkillDetail.snapshot":
    case "SkillDetail.watch":
    case "SkillDetail.events":
    case "SkillDetail.list":
      return (
        actor.authority === "owner" &&
        payload.key !== undefined &&
        Schema.is(SkillDetailKey)(payload.key) &&
        detailOwner(payload.key) === actor.libraryId
      );
    default:
      return false;
  }
};
