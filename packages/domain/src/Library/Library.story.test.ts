import { Story } from "@alchemy.run/domain/Story";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { LibraryModel } from "../Library.model.ts";
import { LibraryActor } from "../LibraryActor.context.ts";
import { AcceptSkill, SkillAccepted } from "./AcceptSkill.command.ts";
import { FinalizeLibraryImport, LibraryImportFinalized } from "./FinalizeLibraryImport.command.ts";
import { ImportSkill, SkillImported } from "./ImportSkill.command.ts";
import { Library } from "./Library.aggregate.ts";
import { LibraryId } from "./Library.id.ts";
import {
  InvalidImportedSkillId,
  LibraryAlreadyFinalized,
  LibraryImportConflict,
  LibraryImportForbidden,
  LibraryImportRequired,
  LibraryNotOwner,
  SkillAllocatorExhausted,
  SkillAlreadyAccepted,
  SkillIdentityExists,
  SkillMissing,
  StaleSkillProposal,
} from "./Library.rejection.ts";
import { ProposeSkill, SkillProposed } from "./ProposeSkill.command.ts";
import { RemoveSkill, SkillRemoved } from "./RemoveSkill.command.ts";
import { SkillId, skillDetailKey } from "./Skill.id.ts";
import { SkillDetail } from "./SkillDetail.view.ts";

const story = Story.make(LibraryModel);
const owner = LibraryId.make("owner");
const ref = Library.ref(owner);
const first = SkillId.make("kitties-skill-0000000000000001");
const second = SkillId.make("kitties-skill-0000000000000002");
const importer = { libraryId: owner, authority: "import", importFinalized: false } as const;
const actor = { libraryId: owner, authority: "owner", importFinalized: true } as const;

const emptyFinalized = new LibraryImportFinalized({
  libraryId: owner,
  inventoryId: "empty-v1",
  importedCount: 0,
  highWaterAfter: 0,
  revision: 1,
});

const proposal = new SkillProposed({
  libraryId: owner,
  skill: {
    id: first,
    name: "Welcome",
    body: "Say hello",
    status: "proposed",
    createdAt: 0,
    updatedAt: 0,
  },
  proposalRevision: 2,
  highWaterAfter: 1,
});

it.effect(
  "allocates once, rejects stale and redundant lifecycle commands, retains removed detail and never reuses an ID",
  () =>
    story(
      Story.provide(LibraryActor, importer),
      Story.clock(0),
      Story.when(
        ref,
        new FinalizeLibraryImport({
          inventoryId: "empty-v1",
          expectedImportedCount: 0,
          expectedHighWater: 0,
        }),
      ),
      Story.then(ref, emptyFinalized),
      Story.provide(LibraryActor, actor),
      Story.when(ref, new ProposeSkill({ name: "Welcome", body: "Say hello" }), {
        commandId: "proposal-1",
      }),
      Story.then(ref, proposal),
      Story.replied({ skillId: first, proposalRevision: 2 }),
      Story.state(ref, (state) => {
        expect(state).toMatchObject({
          highWater: 1,
          catalogueRevision: 2,
          active: [{ id: first, status: "proposed", proposalRevision: 2, detailRevision: 2 }],
        });
        expect(state.active[0]).not.toHaveProperty("body");
      }),
      Story.when(ref, new ProposeSkill({ name: "Different", body: "Changed resend" }), {
        commandId: "proposal-1",
      }),
      Story.then(ref),
      Story.replied({ skillId: first, proposalRevision: 2 }),
      Story.when(ref, new AcceptSkill({ skillId: first, expectedProposalRevision: 1 })),
      Story.rejected(new StaleSkillProposal({ skillId: first, actualRevision: 2 })),
      Story.when(ref, new AcceptSkill({ skillId: first, expectedProposalRevision: 2 }), {
        commandId: "accept-1",
      }),
      Story.then(
        ref,
        new SkillAccepted({
          libraryId: owner,
          skillId: first,
          proposalRevision: 2,
          revision: 3,
          updatedAt: 0,
        }),
      ),
      Story.state(ref, (state) => {
        expect(state.active[0]).toMatchObject({
          status: "accepted",
          proposalRevision: 2,
          detailRevision: 3,
        });
      }),
      Story.view(SkillDetail, skillDetailKey(owner, first), (detail) => {
        expect(detail).toMatchObject({
          name: "Welcome",
          body: "Say hello",
          status: "accepted",
          proposalRevision: 2,
          detailRevision: 3,
        });
      }),
      Story.when(ref, new AcceptSkill({ skillId: first, expectedProposalRevision: 2 })),
      Story.rejected(new SkillAlreadyAccepted({ skillId: first })),
      Story.when(ref, new AcceptSkill({ skillId: first, expectedProposalRevision: 2 }), {
        commandId: "accept-1",
      }),
      Story.then(ref),
      Story.when(ref, new RemoveSkill({ skillId: first, expectedProposalRevision: 1 })),
      Story.rejected(new StaleSkillProposal({ skillId: first, actualRevision: 2 })),
      Story.when(ref, new RemoveSkill({ skillId: first, expectedProposalRevision: 2 }), {
        commandId: "remove-1",
      }),
      Story.then(
        ref,
        new SkillRemoved({
          libraryId: owner,
          skillId: first,
          proposalRevision: 2,
          revision: 4,
          updatedAt: 0,
        }),
      ),
      Story.when(ref, new RemoveSkill({ skillId: first, expectedProposalRevision: 2 })),
      Story.rejected(new SkillMissing({ skillId: first })),
      Story.when(ref, new RemoveSkill({ skillId: first, expectedProposalRevision: 2 }), {
        commandId: "remove-1",
      }),
      Story.then(ref),
      Story.view(SkillDetail, skillDetailKey(owner, first), (detail) => {
        expect(detail).toMatchObject({
          body: "Say hello",
          status: "removed",
          proposalRevision: 2,
          detailRevision: 4,
        });
      }),
      Story.when(ref, new ProposeSkill({ name: "Next", body: "Second body" })),
      Story.then(
        ref,
        new SkillProposed({
          libraryId: owner,
          skill: {
            id: second,
            name: "Next",
            body: "Second body",
            status: "proposed",
            createdAt: 0,
            updatedAt: 0,
          },
          proposalRevision: 5,
          highWaterAfter: 2,
        }),
      ),
      Story.replied({ skillId: second, proposalRevision: 5 }),
      Story.state(ref, (state) => {
        expect(state.active.map((skill) => skill.id)).toEqual([second]);
        expect(state.highWater).toBe(2);
        expect(state.catalogueRevision).toBe(5);
      }),
    ),
);

it.effect(
  "requires explicit trusted finalization and distinguishes owner, other owner and importer",
  () =>
    story(
      Story.provide(LibraryActor, { ...actor, importFinalized: false }),
      Story.when(ref, new ProposeSkill({ name: "Blocked", body: "" })),
      Story.rejected(new LibraryImportRequired()),
      Story.when(ref, new AcceptSkill({ skillId: first, expectedProposalRevision: 1 })),
      Story.rejected(new LibraryImportRequired()),
      Story.when(ref, new RemoveSkill({ skillId: first, expectedProposalRevision: 1 })),
      Story.rejected(new LibraryImportRequired()),
      Story.when(
        ref,
        new FinalizeLibraryImport({
          inventoryId: "empty-v1",
          expectedImportedCount: 0,
          expectedHighWater: 0,
        }),
      ),
      Story.rejected(new LibraryImportForbidden()),
      Story.provide(LibraryActor, { ...actor, libraryId: LibraryId.make("other") }),
      Story.when(ref, new ProposeSkill({ name: "Blocked", body: "" })),
      Story.rejected(new LibraryNotOwner()),
      Story.provide(LibraryActor, importer),
      Story.when(ref, new ProposeSkill({ name: "Blocked", body: "" })),
      Story.rejected(new LibraryNotOwner()),
      Story.state(ref, (state) => {
        expect(state).toMatchObject({
          active: [],
          highWater: 0,
          catalogueRevision: 0,
          importProgress: { inventoryId: null, importedCount: 0 },
        });
      }),
    ),
);

const legacy = {
  id: SkillId.make("legacy_A-1"),
  name: "Legacy",
  body: "Keep exact body",
  status: "accepted",
  updatedAt: 42,
} as const;

const reserved = {
  ...legacy,
  id: SkillId.make("kitties-skill-0000000000000020"),
  name: "Reserved",
  status: "proposed",
  createdAt: 11,
  updatedAt: 12,
} as const;

const legacyEvent = new SkillImported({
  libraryId: owner,
  inventoryId: "frozen-v1",
  skill: legacy,
  proposalRevision: 1,
  highWaterAfter: 0,
});

const reservedEvent = new SkillImported({
  libraryId: owner,
  inventoryId: "frozen-v1",
  skill: reserved,
  proposalRevision: 2,
  highWaterAfter: 20,
});

it.effect(
  "resumes the frozen inventory, preserves legacy values, rejects conflicts and allocates past its high-water",
  () =>
    story(
      Story.provide(LibraryActor, importer),
      Story.clock(0),
      Story.given(ref, legacyEvent),
      Story.when(ref, new ImportSkill({ inventoryId: "different", skill: reserved })),
      Story.rejected(new LibraryImportConflict()),
      Story.when(
        ref,
        new ImportSkill({
          inventoryId: "frozen-v1",
          skill: { ...legacy, body: "Conflicting body" },
        }),
      ),
      Story.rejected(new SkillIdentityExists({ skillId: legacy.id })),
      Story.when(
        ref,
        new FinalizeLibraryImport({
          inventoryId: "frozen-v1",
          expectedImportedCount: 2,
          expectedHighWater: 20,
        }),
      ),
      Story.rejected(new LibraryImportConflict()),
      Story.when(ref, new ImportSkill({ inventoryId: "frozen-v1", skill: reserved }), {
        commandId: "import-2",
      }),
      Story.then(ref, reservedEvent),
      Story.when(
        ref,
        new ImportSkill({ inventoryId: "frozen-v1", skill: { ...reserved, name: "Changed" } }),
        { commandId: "import-2" },
      ),
      Story.then(ref),
      Story.state(ref, (state) => {
        expect(state.importProgress._tag).toBe("Importing");
        expect(state.importProgress).toMatchObject({ inventoryId: "frozen-v1", importedCount: 2 });
        expect(state.highWater).toBe(20);
        expect(state.active[0]).toMatchObject({ id: legacy.id, status: "accepted", updatedAt: 42 });
      }),
      Story.view(SkillDetail, skillDetailKey(owner, legacy.id), (detail) => {
        expect(detail).toMatchObject({ ...legacy, proposalRevision: 1, detailRevision: 1 });
        expect(detail).not.toHaveProperty("createdAt");
      }),
      Story.when(
        ref,
        new FinalizeLibraryImport({
          inventoryId: "frozen-v1",
          expectedImportedCount: 2,
          expectedHighWater: 0,
        }),
      ),
      Story.rejected(new LibraryImportConflict()),
      Story.when(
        ref,
        new FinalizeLibraryImport({
          inventoryId: "frozen-v1",
          expectedImportedCount: 2,
          expectedHighWater: 20,
        }),
        { commandId: "finalize" },
      ),
      Story.then(
        ref,
        new LibraryImportFinalized({
          libraryId: owner,
          inventoryId: "frozen-v1",
          importedCount: 2,
          highWaterAfter: 20,
          revision: 3,
        }),
      ),
      Story.when(
        ref,
        new FinalizeLibraryImport({
          inventoryId: "frozen-v1",
          expectedImportedCount: 2,
          expectedHighWater: 20,
        }),
        { commandId: "finalize" },
      ),
      Story.then(ref),
      Story.when(
        ref,
        new FinalizeLibraryImport({
          inventoryId: "frozen-v1",
          expectedImportedCount: 2,
          expectedHighWater: 20,
        }),
      ),
      Story.rejected(new LibraryAlreadyFinalized()),
      Story.when(ref, new ImportSkill({ inventoryId: "frozen-v1", skill: reserved })),
      Story.rejected(new LibraryAlreadyFinalized()),
      Story.provide(LibraryActor, actor),
      Story.when(ref, new ProposeSkill({ name: "New", body: "" })),
      Story.then(
        ref,
        new SkillProposed({
          libraryId: owner,
          skill: {
            id: SkillId.make("kitties-skill-0000000000000021"),
            name: "New",
            body: "",
            status: "proposed",
            createdAt: 0,
            updatedAt: 0,
          },
          proposalRevision: 4,
          highWaterAfter: 21,
        }),
      ),
      Story.state(ref, (state) => {
        expect(state.highWater).toBe(21);
        expect(state.importProgress._tag).toBe("Finalized");
        expect(state.importProgress.importedCount).toBe(2);
      }),
    ),
);

it.effect(
  "replays import, proposal, acceptance and removal with the relevant detail versions intact",
  () =>
    story(
      Story.given(
        ref,
        emptyFinalized,
        proposal,
        new SkillAccepted({
          libraryId: owner,
          skillId: first,
          proposalRevision: 2,
          revision: 3,
          updatedAt: 100,
        }),
        new SkillRemoved({
          libraryId: owner,
          skillId: first,
          proposalRevision: 2,
          revision: 4,
          updatedAt: 200,
        }),
      ),
      Story.state(ref, (state) => {
        expect(state).toMatchObject({
          active: [],
          highWater: 1,
          catalogueRevision: 4,
          importProgress: { inventoryId: "empty-v1", importedCount: 0 },
        });
      }),
      Story.view(SkillDetail, skillDetailKey(owner, first), (detail) => {
        expect(detail).toEqual({
          libraryId: owner,
          id: first,
          name: "Welcome",
          body: "Say hello",
          status: "removed",
          createdAt: 0,
          updatedAt: 200,
          proposalRevision: 2,
          detailRevision: 4,
        });
      }),
    ),
);

it.effect("rejects noncanonical and overflowing reserved IDs without advancing import", () =>
  story(
    Story.provide(LibraryActor, importer),
    Story.when(
      ref,
      new ImportSkill({
        inventoryId: "frozen-v1",
        skill: { ...legacy, id: SkillId.make("kitties-skill-1") },
      }),
    ),
    Story.rejected(new InvalidImportedSkillId({ skillId: SkillId.make("kitties-skill-1") })),
    Story.when(
      ref,
      new ImportSkill({
        inventoryId: "frozen-v1",
        skill: { ...legacy, id: SkillId.make("kitties-skill-9007199254740992") },
      }),
    ),
    Story.rejected(
      new InvalidImportedSkillId({ skillId: SkillId.make("kitties-skill-9007199254740992") }),
    ),
    Story.state(ref, (state) => {
      expect(state).toMatchObject({
        active: [],
        highWater: 0,
        importProgress: { inventoryId: null, importedCount: 0 },
      });
    }),
  ),
);

it.effect("imports the last exact ordinal and rejects allocation before numeric overflow", () =>
  story(
    Story.clock(0),
    Story.provide(LibraryActor, importer),
    Story.when(
      ref,
      new ImportSkill({
        inventoryId: "frozen-v1",
        skill: { ...legacy, id: SkillId.make("kitties-skill-9007199254740991") },
      }),
    ),
    Story.then(
      ref,
      new SkillImported({
        libraryId: owner,
        inventoryId: "frozen-v1",
        skill: { ...legacy, id: SkillId.make("kitties-skill-9007199254740991") },
        proposalRevision: 1,
        highWaterAfter: 9007199254740991,
      }),
    ),
    Story.when(
      ref,
      new FinalizeLibraryImport({
        inventoryId: "frozen-v1",
        expectedImportedCount: 1,
        expectedHighWater: 9007199254740991,
      }),
    ),
    Story.then(
      ref,
      new LibraryImportFinalized({
        libraryId: owner,
        inventoryId: "frozen-v1",
        importedCount: 1,
        highWaterAfter: 9007199254740991,
        revision: 2,
      }),
    ),
    Story.provide(LibraryActor, actor),
    Story.when(ref, new ProposeSkill({ name: "Would overflow", body: "" })),
    Story.rejected(new SkillAllocatorExhausted()),
    Story.state(ref, (state) => {
      expect(state.highWater).toBe(9007199254740991);
      expect(state.active).toHaveLength(1);
    }),
  ),
);
