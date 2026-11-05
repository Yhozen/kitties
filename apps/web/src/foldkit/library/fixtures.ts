import { LibraryId } from "@kitties/domain/Library/Library.id";
import { FinalizedImport, LibraryState } from "@kitties/domain/Library/Library.state";
import { SkillId, skillDetailKey } from "@kitties/domain/Library/Skill.id";
import { SkillDetailRecord } from "@kitties/domain/Library/SkillDetail.view";
import { SkillAlreadyAccepted } from "@kitties/domain/Library/Library.rejection";
import { LibraryUnauthorized } from "@kitties/domain/LibrarySession.middleware";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import { Catalogue, Flags, init } from "./model.ts";

export const owner = LibraryId.make("owner");
export const first = SkillId.make("kitties-skill-0000000000000001");
export const second = SkillId.make("kitties-skill-0000000000000002");
export const key = skillDetailKey(owner, first);

export const flags = Flags.make({
  scope: { owner, epoch: 7, sessionId: "fixture" },
  language: "en",
});

export const commandId = "library:7:fixture:0";
export const receipt = { stream: "Library/owner", version: 2 };

export const FixtureFailure = defineTaggedUnion({
  Unknown: {},
  Denied: { error: LibraryUnauthorized },
  Rejected: { rejection: SkillAlreadyAccepted },
});

export const empty = LibraryState.make({
  active: [],
  highWater: 0,
  catalogueRevision: 1,
  importProgress: FinalizedImport.make({ inventoryId: "empty", importedCount: 0 }),
});

export const proposed = SkillDetailRecord.make({
  libraryId: owner,
  id: first,
  name: "Welcome",
  body: "Say hello",
  status: "proposed",
  createdAt: 0,
  updatedAt: 0,
  proposalRevision: 2,
  detailRevision: 2,
});

export const catalogue = LibraryState.make({
  active: [
    {
      id: first,
      name: "Welcome",
      status: "proposed",
      createdAt: 0,
      updatedAt: 0,
      proposalRevision: 2,
      detailRevision: 2,
    },
  ],
  highWater: 1,
  catalogueRevision: 2,
  importProgress: empty.importProgress,
});

export const ready = modifyFields(init(flags).model, {
  catalogue: () => Catalogue.Success({ data: empty }),
  catalogueWatch: () => "Live",
});
