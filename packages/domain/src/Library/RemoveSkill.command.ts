import * as Domain from "@alchemy.run/domain";
import { LibrarySession } from "../LibrarySession.middleware.ts";
import { LibraryId } from "./Library.id.ts";
import { SkillId } from "./Skill.id.ts";
import { ProposalRevision, SkillTimestamp } from "./Skill.ts";
import {
  LibraryImportRequired,
  LibraryNotOwner,
  LibraryVersionExhausted,
  SkillMissing,
  StaleSkillProposal,
} from "./Library.rejection.ts";

export class SkillRemoved extends Domain.Event("SkillRemoved", {
  libraryId: LibraryId,
  skillId: SkillId,
  proposalRevision: ProposalRevision,
  revision: ProposalRevision,
  updatedAt: SkillTimestamp,
}) {}

export class RemoveSkill extends Domain.Command("RemoveSkill", {
  target: LibraryId,
  middleware: [LibrarySession],
  input: { skillId: SkillId, expectedProposalRevision: ProposalRevision },
  events: [SkillRemoved],
  rejects: [
    LibraryNotOwner,
    LibraryImportRequired,
    SkillMissing,
    StaleSkillProposal,
    LibraryVersionExhausted,
  ],
}) {}
