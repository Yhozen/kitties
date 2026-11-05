import * as Aggregate from "@alchemy.run/domain/Aggregate";
import { Story } from "@alchemy.run/domain/Story";
import { it } from "@effect/vitest";
import { Context, DateTime, Schema } from "effect";
import { expect, test } from "vite-plus/test";
import { LibraryModel } from "../Library.model.ts";
import { LibraryActor } from "../LibraryActor.context.ts";
import {
  AdvanceLibraryAllocatorFloor,
  LibraryAllocatorFloorAdvanced,
  LibraryRecoveryForbidden,
} from "./AdvanceLibraryAllocatorFloor.command.ts";
import { LibraryImportFinalized } from "./FinalizeLibraryImport.command.ts";
import { SkillImported } from "./ImportSkill.command.ts";
import { Library } from "./Library.aggregate.ts";
import { LibraryId } from "./Library.id.ts";
import {
  LibraryImportRequired,
  LibraryNotOwner,
  LibraryVersionExhausted,
  SkillAllocatorExhausted,
} from "./Library.rejection.ts";
import { FinalizedImport, initialLibrary } from "./Library.state.ts";
import { LibraryRecoveryActor } from "./LibraryRecoveryActor.context.ts";
import { ProposeSkill, SkillProposed } from "./ProposeSkill.command.ts";
import { SkillId, skillDetailKey } from "./Skill.id.ts";
import { SkillDetail } from "./SkillDetail.view.ts";

const owner = LibraryId.make("owner");
const ref = Library.ref(owner);
const legacyId = SkillId.make("kitties-skill-0000000000000007");
const recovery = { libraryId: owner };
const actor = { libraryId: owner, authority: "owner", importFinalized: true } as const;

const imported = new SkillImported({
  libraryId: owner,
  inventoryId: "inventory",
  skill: {
    id: legacyId,
    name: "Keep",
    body: "Immutable body",
    status: "accepted",
    createdAt: 1,
    updatedAt: 2,
  },
  proposalRevision: 1,
  highWaterAfter: 7,
});

const finalized = new LibraryImportFinalized({
  libraryId: owner,
  inventoryId: "inventory",
  importedCount: 1,
  highWaterAfter: 7,
  revision: 2,
});

const advanced = new LibraryAllocatorFloorAdvanced({
  libraryId: owner,
  highWaterAfter: 12,
  revision: 3,
});

it.effect(
  "advances the outgoing floor without rewriting accepted details and never reuses an ID",
  () =>
    Story.make(LibraryModel)(
      Story.clock(0),
      Story.given(ref, imported, finalized),
      Story.provide(LibraryRecoveryActor, recovery),
      Story.when(ref, new AdvanceLibraryAllocatorFloor({ floor: 12 }), { commandId: "floor" }),
      Story.then(ref, advanced),
      Story.when(ref, new AdvanceLibraryAllocatorFloor({ floor: 99 }), { commandId: "floor" }),
      Story.then(ref),
      Story.when(ref, new AdvanceLibraryAllocatorFloor({ floor: 3 })),
      Story.then(ref),
      Story.state(ref, (state) => {
        expect(state.highWater).toBe(12);
        expect(state.catalogueRevision).toBe(3);
        expect(state.active).toEqual([
          {
            id: legacyId,
            name: "Keep",
            status: "accepted",
            createdAt: 1,
            updatedAt: 2,
            proposalRevision: 1,
            detailRevision: 1,
          },
        ]);
        expect(state.importProgress).toEqual(
          FinalizedImport.make({ inventoryId: "inventory", importedCount: 1 }),
        );
      }),
      Story.view(SkillDetail, skillDetailKey(owner, legacyId), (detail) => {
        expect(detail).toMatchObject({
          body: "Immutable body",
          status: "accepted",
          proposalRevision: 1,
          detailRevision: 1,
          updatedAt: 2,
        });
      }),
      Story.provide(LibraryActor, actor),
      Story.when(ref, new ProposeSkill({ name: "Next", body: "New body" })),
      Story.then(
        ref,
        new SkillProposed({
          libraryId: owner,
          skill: {
            id: SkillId.make("kitties-skill-0000000000000013"),
            name: "Next",
            body: "New body",
            status: "proposed",
            createdAt: 0,
            updatedAt: 0,
          },
          proposalRevision: 4,
          highWaterAfter: 13,
        }),
      ),
      Story.replied({
        skillId: SkillId.make("kitties-skill-0000000000000013"),
        proposalRevision: 4,
      }),
      Story.state(ref, (state) => {
        expect(state.highWater).toBe(13);
        expect(state.active.map((skill) => skill.id)).toEqual([
          legacyId,
          "kitties-skill-0000000000000013",
        ]);
      }),
    ),
);

it.effect("replays the floor fact before a fresh allocation with the same immutable details", () =>
  Story.make(LibraryModel)(
    Story.clock(0),
    Story.given(ref, imported, finalized, advanced),
    Story.provide(LibraryActor, actor),
    Story.when(ref, new ProposeSkill({ name: "After replay", body: "" })),
    Story.then(
      ref,
      new SkillProposed({
        libraryId: owner,
        skill: {
          id: SkillId.make("kitties-skill-0000000000000013"),
          name: "After replay",
          body: "",
          status: "proposed",
          createdAt: 0,
          updatedAt: 0,
        },
        proposalRevision: 4,
        highWaterAfter: 13,
      }),
    ),
    Story.replied({ skillId: SkillId.make("kitties-skill-0000000000000013"), proposalRevision: 4 }),
    Story.state(ref, (state) => {
      expect(state.highWater).toBe(13);
      expect(state.active[0]).toMatchObject({ proposalRevision: 1, detailRevision: 1 });
    }),
    Story.view(SkillDetail, skillDetailKey(owner, legacyId), (detail) => {
      expect(detail).toMatchObject({ body: "Immutable body", detailRevision: 1 });
    }),
  ),
);

test("requires durable finalization and the recovery capability for the target owner", () => {
  const command = new AdvanceLibraryAllocatorFloor({ floor: 12 });
  const options = { id: owner, now: DateTime.makeUnsafe(0), version: 0 };

  // Exercise the kernel boundary when a trusted host omits the declared capability.
  expect(Aggregate.predict(Library, initialLibrary, command, options)).toMatchObject({
    rejection: new LibraryRecoveryForbidden(),
  });
  expect(
    Aggregate.predict(Library, initialLibrary, command, {
      ...options,
      context: Context.make(LibraryActor, actor),
    }),
  ).toMatchObject({ rejection: new LibraryRecoveryForbidden() });
  expect(
    Aggregate.predict(Library, initialLibrary, command, {
      ...options,
      context: Context.make(LibraryActor, { ...actor, authority: "import" }),
    }),
  ).toMatchObject({ rejection: new LibraryRecoveryForbidden() });

  expect(
    Library.predict(initialLibrary, command, {
      ...options,
      context: Context.make(LibraryRecoveryActor, { libraryId: LibraryId.make("other") }),
    }),
  ).toMatchObject({ rejection: new LibraryNotOwner() });
  expect(
    Library.predict(initialLibrary, command, {
      ...options,
      context: Context.make(LibraryRecoveryActor, recovery),
    }),
  ).toMatchObject({ rejection: new LibraryImportRequired() });
  expect(
    Library.predict(initialLibrary, new AdvanceLibraryAllocatorFloor({ floor: 0 }), {
      ...options,
      context: Context.make(LibraryRecoveryActor, recovery),
    }),
  ).toMatchObject({ rejection: new LibraryImportRequired() });
});

test("checks safe floor and version ceilings while allowing a covered floor without another event", () => {
  const state = {
    ...initialLibrary,
    highWater: 7,
    catalogueRevision: 2,
    importProgress: FinalizedImport.make({ inventoryId: "inventory", importedCount: 0 }),
  };

  const options = {
    id: owner,
    now: DateTime.makeUnsafe(0),
    context: Context.make(LibraryRecoveryActor, recovery),
    version: Number.MAX_SAFE_INTEGER,
  };

  expect(
    Library.predict(state, new AdvanceLibraryAllocatorFloor({ floor: 12 }), options),
  ).toMatchObject({ rejection: new LibraryVersionExhausted() });
  expect(
    Library.predict(state, new AdvanceLibraryAllocatorFloor({ floor: 3 }), options),
  ).toMatchObject({ state, events: [] });
  expect(
    Library.predict(state, new AdvanceLibraryAllocatorFloor({ floor: Number.MAX_SAFE_INTEGER }), {
      ...options,
      version: Number.MAX_SAFE_INTEGER - 1,
    }),
  ).toMatchObject({
    state: { highWater: Number.MAX_SAFE_INTEGER, catalogueRevision: Number.MAX_SAFE_INTEGER },
    events: [
      new LibraryAllocatorFloorAdvanced({
        libraryId: owner,
        highWaterAfter: Number.MAX_SAFE_INTEGER,
        revision: Number.MAX_SAFE_INTEGER,
      }),
    ],
  });
  expect(
    Library.predict(
      { ...state, highWater: Number.MAX_SAFE_INTEGER },
      new ProposeSkill({ name: "Exhausted", body: "" }),
      { id: owner, now: options.now, context: Context.make(LibraryActor, actor) },
    ),
  ).toMatchObject({ rejection: new SkillAllocatorExhausted() });
  expect(
    [0, 7, Number.MAX_SAFE_INTEGER].map(Schema.is(AdvanceLibraryAllocatorFloor.fields.floor)),
  ).toEqual([true, true, true]);
  expect(
    [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity].map(
      Schema.is(AdvanceLibraryAllocatorFloor.fields.floor),
    ),
  ).toEqual([false, false, false, false, false]);
});
