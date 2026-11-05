import * as Domain from "@alchemy.run/domain";
import { LibrarySession } from "../LibrarySession.middleware.ts";
import { LibraryId } from "./Library.id.ts";
import { SkillId } from "./Skill.id.ts";
import { FrozenSkill, LibraryVersion, ProposalRevision, SkillBody, SkillName } from "./Skill.ts";
import {
  LibraryFull,
  LibraryImportRequired,
  LibraryNotOwner,
  LibraryVersionExhausted,
  SkillAllocatorExhausted,
  SkillPayloadTooLarge,
} from "./Library.rejection.ts";

export class SkillProposed extends Domain.Event("SkillProposed", {
  libraryId: LibraryId,
  skill: FrozenSkill,
  proposalRevision: ProposalRevision,
  highWaterAfter: LibraryVersion,
}) {}

export class ProposeSkill extends Domain.Command("ProposeSkill", {
  target: LibraryId,
  middleware: [LibrarySession],
  input: { name: SkillName, body: SkillBody },
  events: [SkillProposed],
  rejects: [
    LibraryNotOwner,
    LibraryImportRequired,
    LibraryFull,
    SkillPayloadTooLarge,
    SkillAllocatorExhausted,
    LibraryVersionExhausted,
  ],
  reply: { skillId: SkillId, proposalRevision: ProposalRevision },
}) {}
