import * as Domain from "@alchemy.run/domain";
import { LibraryImportSession } from "../LibrarySession.middleware.ts";
import { LibraryId } from "./Library.id.ts";
import { FrozenSkill, ImportInventoryId, LibraryVersion, ProposalRevision } from "./Skill.ts";
import {
  InvalidImportedSkillId,
  LibraryAlreadyFinalized,
  LibraryFull,
  LibraryImportConflict,
  LibraryImportForbidden,
  LibraryNotOwner,
  LibraryVersionExhausted,
  SkillIdentityExists,
  SkillPayloadTooLarge,
} from "./Library.rejection.ts";

export class SkillImported extends Domain.Event("SkillImported", {
  libraryId: LibraryId,
  inventoryId: ImportInventoryId,
  skill: FrozenSkill,
  proposalRevision: ProposalRevision,
  highWaterAfter: LibraryVersion,
}) {}

export class ImportSkill extends Domain.Command("ImportSkill", {
  target: LibraryId,
  middleware: [LibraryImportSession],
  input: { inventoryId: ImportInventoryId, skill: FrozenSkill },
  events: [SkillImported],
  rejects: [
    LibraryNotOwner,
    LibraryImportForbidden,
    LibraryAlreadyFinalized,
    LibraryImportConflict,
    InvalidImportedSkillId,
    SkillIdentityExists,
    LibraryFull,
    SkillPayloadTooLarge,
    LibraryVersionExhausted,
  ],
}) {}
