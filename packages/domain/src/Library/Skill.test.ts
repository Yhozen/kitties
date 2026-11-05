import { it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { expect, test } from "vite-plus/test";
import { LibraryActorValue } from "../LibraryActor.context.ts";
import { LibraryRequestPayload, ownsLibraryPayload } from "../LibrarySession.middleware.ts";
import { LibraryId } from "./Library.id.ts";
import { SkillProposed } from "./ProposeSkill.command.ts";
import {
  SkillDetailKey,
  SkillId,
  SkillOrdinal,
  importedOrdinal,
  skillIdForOrdinal,
} from "./Skill.id.ts";
import {
  FrozenSkill,
  SkillBody,
  SkillMetadata,
  SkillName,
  acceptedSkillsForTurn,
  encodedJsonBytes,
  skillPrompt,
} from "./Skill.ts";

it.prop(
  "names enforce non-whitespace content and the existing UTF-16 character bounds",
  [Schema.String],
  ([name]) => {
    expect(Schema.is(SkillName)(name)).toBe(
      name.length >= 1 && name.length <= 80 && /\S/u.test(name),
    );
  },
);

it.prop(
  "every safe positive ordinal round-trips in the canonical reserved namespace",
  [SkillOrdinal],
  ([ordinal]) => {
    const id = skillIdForOrdinal(ordinal);

    expect(id).toBe(`kitties-skill-${String(ordinal).padStart(16, "0")}`);
    expect(importedOrdinal(id)).toBe(ordinal);
  },
);

test.each(["", " ", "\t\n", "a".repeat(81), "😀".repeat(41)])("rejects invalid name %j", (name) => {
  expect(Schema.is(SkillName)(name)).toBe(false);
});

test("preserves the legacy ID alphabet and exact name/body bounds, with no arbitrary body trimming", () => {
  expect(Schema.is(SkillId)("A_z-09")).toBe(true);
  expect(Schema.is(SkillId)("a".repeat(128))).toBe(true);
  expect(Schema.is(SkillId)("a".repeat(129))).toBe(false);
  expect(Schema.is(SkillId)("bad/id")).toBe(false);
  expect(Schema.is(SkillId)("bad.id")).toBe(false);
  expect(Schema.is(SkillName)("界".repeat(80))).toBe(true);
  expect(Schema.is(SkillName)("😀".repeat(40))).toBe(true);
  expect(Schema.is(SkillBody)(" ".repeat(64000))).toBe(true);
  expect(Schema.is(SkillBody)("a".repeat(64001))).toBe(false);
});

test.each([
  "kitties-skill-1",
  "kitties-skill-0000000000000000",
  "kitties-skill-9007199254740992",
  "kitties-skill-9999999999999999",
  "kitties-skill-00000000000000e1",
])("rejects invalid reserved import %s", (id) => {
  expect(importedOrdinal(SkillId.make(id))).toBe("invalid");
});

test("measures UTF-8 JSON escaping and keeps the largest schema-valid event and detail below the record fence", () => {
  expect(encodedJsonBytes({ text: "界" })).toBe(14);
  expect(encodedJsonBytes({ text: "\u0000" })).toBe(17);

  const skill = FrozenSkill.make({
    id: SkillId.make("a".repeat(128)),
    name: "\u0000".repeat(79) + "X",
    body: "\u0000".repeat(64000),
    status: "proposed",
    createdAt: 9007199254740991,
    updatedAt: 9007199254740991,
  });

  const event = new SkillProposed({
    libraryId: LibraryId.make("a".repeat(128)),
    skill,
    proposalRevision: 9007199254740991,
    highWaterAfter: 9007199254740991,
  });

  const encodedEvent = Schema.encodeSync(SkillProposed)(event);

  expect(encodedJsonBytes(encodedEvent)).toBeGreaterThan(384000);
  expect(encodedJsonBytes(encodedEvent)).toBeLessThan(524288);
  expect(
    encodedJsonBytes({
      ...skill,
      libraryId: event.libraryId,
      proposalRevision: 9007199254740991,
      detailRevision: 9007199254740991,
    }),
  ).toBeLessThan(524288);
});

test("selects only accepted IDs in lexical order, caps eight and keeps the existing prompt format and body bound", () => {
  const skills: ReadonlyArray<SkillMetadata> = Array.from({ length: 12 }, (_, index) => ({
    id: SkillId.make(`skill-${String(12 - index).padStart(2, "0")}`),
    name: "Name",
    status: index === 11 ? "proposed" : "accepted",
    updatedAt: 0,
    proposalRevision: index + 1,
    detailRevision: index + 1,
  }));

  expect(acceptedSkillsForTurn(skills).map((skill) => skill.id)).toEqual([
    "skill-02",
    "skill-03",
    "skill-04",
    "skill-05",
    "skill-06",
    "skill-07",
    "skill-08",
    "skill-09",
  ]);
  expect(skillPrompt({ name: "Name", body: "a".repeat(12001) })).toBe("Name\n" + "a".repeat(12000));
  expect(skills[0]?.id).toBe("skill-12");
});

test("authorizes exactly the RPC selector and rejects ambiguity, unknown operations and private authority confusion", () => {
  const actor = LibraryActorValue.make({
    libraryId: LibraryId.make("owner"),
    authority: "owner",
    importFinalized: true,
  });

  const ambiguous = Schema.decodeUnknownSync(LibraryRequestPayload)({
    target: "owner",
    key: "other/skill",
  });

  const ownTarget = { target: actor.libraryId };
  const ownKey = { key: SkillDetailKey.make("owner/skill") };

  expect(ambiguous).toEqual({ target: "owner", key: "other/skill" });
  expect(ownsLibraryPayload(actor, "ProposeSkill", ambiguous)).toBe(false);
  expect(ownsLibraryPayload(actor, "SkillDetail.get", ambiguous)).toBe(false);
  expect(ownsLibraryPayload(actor, "SkillDetail.get", ownTarget)).toBe(false);
  expect(ownsLibraryPayload(actor, "ProposeSkill", ownKey)).toBe(false);
  expect(ownsLibraryPayload(actor, "Unregistered.get", ownKey)).toBe(false);
  expect(ownsLibraryPayload(actor, "ImportSkill", ownTarget)).toBe(false);
  expect(ownsLibraryPayload({ ...actor, authority: "import" }, "ProposeSkill", ownTarget)).toBe(
    false,
  );
  expect(ownsLibraryPayload(actor, "SkillDetail.get", ownKey)).toBe(true);
  expect(ownsLibraryPayload(actor, "ProposeSkill", ownTarget)).toBe(true);
});
