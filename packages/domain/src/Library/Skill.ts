import * as Schema from "effect/Schema";
import { SkillId } from "./Skill.id.ts";

export const SkillName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.isPattern(/\S/u),
);

export const SkillBody = Schema.String.check(Schema.isMaxLength(64000));
export const LibraryVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const ProposalRevision = Schema.Int.check(Schema.isGreaterThan(0));
export const SkillTimestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const ImportInventoryId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));

export const SkillMetadata = Schema.Struct({
  id: SkillId,
  name: SkillName,
  status: Schema.Literals(["proposed", "accepted"]),
  createdAt: Schema.optional(SkillTimestamp),
  updatedAt: SkillTimestamp,
  proposalRevision: ProposalRevision,
  detailRevision: ProposalRevision,
});

export type SkillMetadata = typeof SkillMetadata.Type;

export const FrozenSkill = Schema.Struct({
  id: SkillId,
  name: SkillName,
  body: SkillBody,
  status: Schema.Literals(["proposed", "accepted"]),
  createdAt: Schema.optional(SkillTimestamp),
  updatedAt: SkillTimestamp,
});

export type FrozenSkill = typeof FrozenSkill.Type;

export const MAX_LIBRARY_JSON_BYTES = 512 * 1024;
export const MAX_SKILL_JSON_BYTES = 512 * 1024;

export const encodedJsonBytes = (value: Schema.Json): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

export const acceptedSkillsForTurn = (skills: ReadonlyArray<SkillMetadata>) =>
  skills
    .toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .filter((skill) => skill.status === "accepted")
    .slice(0, 8);

export const skillPrompt = (skill: Pick<FrozenSkill, "name" | "body">): string =>
  `${skill.name}\n${skill.body.slice(0, 12000)}`;
