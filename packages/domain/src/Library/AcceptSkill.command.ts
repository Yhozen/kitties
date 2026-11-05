import * as Domain from "@alchemy.run/domain";
import { LibrarySession } from "../LibrarySession.middleware.ts";
import { LibraryId } from "./Library.id.ts";
import { SkillId } from "./Skill.id.ts";
import { ProposalRevision, SkillTimestamp } from "./Skill.ts";
import {
  LibraryImportRequired,
  LibraryNotOwner,
  LibraryVersionExhausted,
  SkillAlreadyAccepted,
  SkillMissing,
  StaleSkillProposal,
} from "./Library.rejection.ts";

export class SkillAccepted extends Domain.Event("SkillAccepted", {
  libraryId: LibraryId,
  skillId: SkillId,
  proposalRevision: ProposalRevision,
  revision: ProposalRevision,
  updatedAt: SkillTimestamp,
}) {}

export class AcceptSkill extends Domain.Command("AcceptSkill", {
  target: LibraryId,
  middleware: [LibrarySession],
  input: { skillId: SkillId, expectedProposalRevision: ProposalRevision },
  events: [SkillAccepted],
  rejects: [
    LibraryNotOwner,
    LibraryImportRequired,
    SkillMissing,
    SkillAlreadyAccepted,
    StaleSkillProposal,
    LibraryVersionExhausted,
  ],
}) {}
