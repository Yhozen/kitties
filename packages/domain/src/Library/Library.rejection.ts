import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { SkillId } from "./Skill.id.ts";

export class LibraryNotOwner extends Domain.Rejection("LibraryNotOwner") {}

export class LibraryImportRequired extends Domain.Rejection("LibraryImportRequired") {}

export class LibraryImportForbidden extends Domain.Rejection("LibraryImportForbidden") {}

export class LibraryAlreadyFinalized extends Domain.Rejection("LibraryAlreadyFinalized") {}

export class LibraryImportConflict extends Domain.Rejection("LibraryImportConflict") {}

export class LibraryFull extends Domain.Rejection("LibraryFull") {}

export class SkillPayloadTooLarge extends Domain.Rejection("SkillPayloadTooLarge") {}

export class SkillAllocatorExhausted extends Domain.Rejection("SkillAllocatorExhausted") {}

export class LibraryVersionExhausted extends Domain.Rejection("LibraryVersionExhausted") {}

export class InvalidImportedSkillId extends Domain.Rejection("InvalidImportedSkillId", {
  skillId: SkillId,
}) {}

export class SkillIdentityExists extends Domain.Rejection("SkillIdentityExists", {
  skillId: SkillId,
}) {}

export class SkillMissing extends Domain.Rejection("SkillMissing", { skillId: SkillId }) {}

export class SkillAlreadyAccepted extends Domain.Rejection("SkillAlreadyAccepted", {
  skillId: SkillId,
}) {}

export class StaleSkillProposal extends Domain.Rejection("StaleSkillProposal", {
  skillId: SkillId,
  actualRevision: Schema.Number,
}) {}
