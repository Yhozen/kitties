import * as Schema from "effect/Schema";
import { LibraryId } from "./Library.id.ts";

export const SkillId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/)).pipe(
  Schema.brand("SkillId"),
);

export type SkillId = typeof SkillId.Type;

export const SkillDetailKey = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}\/[a-zA-Z0-9_-]{1,128}$/),
).pipe(Schema.brand("SkillDetailKey"));

export type SkillDetailKey = typeof SkillDetailKey.Type;

export const skillDetailKey = (libraryId: LibraryId, skillId: SkillId): SkillDetailKey =>
  SkillDetailKey.make(`${libraryId}/${skillId}`);

export const detailOwner = (key: SkillDetailKey): LibraryId => LibraryId.make(key.split("/")[0]);

export const ALLOCATED_SKILL_PREFIX = "kitties-skill-";
export const MAX_SKILL_ORDINAL = Number.MAX_SAFE_INTEGER;

export const SkillOrdinal = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("SkillOrdinal"),
);

export type SkillOrdinal = typeof SkillOrdinal.Type;

export const skillIdForOrdinal = (ordinal: SkillOrdinal): SkillId =>
  SkillId.make(`${ALLOCATED_SKILL_PREFIX}${String(ordinal).padStart(16, "0")}`);

export const importedOrdinal = (id: SkillId): number | "invalid" => {
  if (!id.startsWith(ALLOCATED_SKILL_PREFIX)) {
    return 0;
  }

  const suffix = id.slice(ALLOCATED_SKILL_PREFIX.length);
  const ordinal = Number(suffix);

  return /^\d{16}$/.test(suffix) &&
    Schema.is(SkillOrdinal)(ordinal) &&
    skillIdForOrdinal(ordinal) === id
    ? ordinal
    : "invalid";
};
