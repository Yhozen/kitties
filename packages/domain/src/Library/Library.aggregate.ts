import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { LibraryActor } from "../LibraryActor.context.ts";
import { LibrarySession } from "../LibrarySession.middleware.ts";
import { AcceptSkill, SkillAccepted } from "./AcceptSkill.command.ts";
import {
  AdvanceLibraryAllocatorFloor,
  LibraryAllocatorFloorAdvanced,
  LibraryRecoveryForbidden,
} from "./AdvanceLibraryAllocatorFloor.command.ts";
import { LibraryRecoveryActor } from "./LibraryRecoveryActor.context.ts";
import { FinalizeLibraryImport, LibraryImportFinalized } from "./FinalizeLibraryImport.command.ts";
import { ImportSkill, SkillImported } from "./ImportSkill.command.ts";
import { LibraryId } from "./Library.id.ts";
import {
  FinalizedImport,
  ImportingLibrary,
  LibraryState,
  initialLibrary,
  reservedCatalogueBytes,
} from "./Library.state.ts";
import {
  InvalidImportedSkillId,
  LibraryAlreadyFinalized,
  LibraryFull,
  LibraryImportConflict,
  LibraryImportForbidden,
  LibraryImportRequired,
  LibraryNotOwner,
  LibraryVersionExhausted,
  SkillAllocatorExhausted,
  SkillAlreadyAccepted,
  SkillIdentityExists,
  SkillMissing,
  SkillPayloadTooLarge,
  StaleSkillProposal,
} from "./Library.rejection.ts";
import { ProposeSkill, SkillProposed } from "./ProposeSkill.command.ts";
import { RemoveSkill, SkillRemoved } from "./RemoveSkill.command.ts";
import { MAX_SKILL_ORDINAL, SkillOrdinal, importedOrdinal, skillIdForOrdinal } from "./Skill.id.ts";
import {
  FrozenSkill,
  MAX_LIBRARY_JSON_BYTES,
  MAX_SKILL_JSON_BYTES,
  SkillMetadata,
  encodedJsonBytes,
} from "./Skill.ts";

const requireOwner = Effect.fnUntraced(function* (id: LibraryId) {
  const actor = yield* LibraryActor;

  if (actor.libraryId !== id || actor.authority !== "owner") {
    return yield* new LibraryNotOwner();
  }
});

const requireImporter = Effect.fnUntraced(function* (id: LibraryId) {
  const actor = yield* LibraryActor;

  if (actor.libraryId !== id) {
    return yield* new LibraryNotOwner();
  }

  if (actor.authority !== "import") {
    return yield* new LibraryImportForbidden();
  }
});

const metadata = (skill: FrozenSkill, revision: number): SkillMetadata => ({
  id: skill.id,
  name: skill.name,
  status: skill.status,
  createdAt: skill.createdAt,
  updatedAt: skill.updatedAt,
  proposalRevision: revision,
  detailRevision: revision,
});

const proposalState = (
  state: LibraryState,
  skill: FrozenSkill,
  revision: number,
  highWater: number,
): LibraryState => ({
  ...state,
  active: [...state.active, metadata(skill, revision)],
  highWater,
  catalogueRevision: revision,
});

export class Library extends Domain.Aggregate("Library", {
  id: LibraryId,
  state: LibraryState,
  initial: initialLibrary,
  commands: [
    ProposeSkill,
    AcceptSkill,
    RemoveSkill,
    ImportSkill,
    FinalizeLibraryImport,
    AdvanceLibraryAllocatorFloor,
  ],
  decide: {
    AdvanceLibraryAllocatorFloor: Effect.fnUntraced(function* (state, command, { id, version }) {
      const actor = yield* Effect.serviceOption(LibraryRecoveryActor);

      if (Option.isNone(actor)) {
        return yield* new LibraryRecoveryForbidden();
      }

      if (actor.value.libraryId !== id) {
        return yield* new LibraryNotOwner();
      }

      if (!Schema.is(FinalizedImport)(state.importProgress)) {
        return yield* new LibraryImportRequired();
      }

      const highWaterAfter = Math.max(state.highWater, command.floor);

      if (highWaterAfter === state.highWater) return [];

      if (version >= Number.MAX_SAFE_INTEGER) {
        return yield* new LibraryVersionExhausted();
      }

      return [
        new LibraryAllocatorFloorAdvanced({ libraryId: id, highWaterAfter, revision: version + 1 }),
      ];
    }),
    ProposeSkill: Effect.fnUntraced(function* (state, command, { id, now, version }) {
      yield* requireOwner(id);

      if (!Schema.is(FinalizedImport)(state.importProgress)) {
        return yield* new LibraryImportRequired();
      }

      if (state.highWater >= MAX_SKILL_ORDINAL) {
        return yield* new SkillAllocatorExhausted();
      }

      if (version >= Number.MAX_SAFE_INTEGER) {
        return yield* new LibraryVersionExhausted();
      }

      const ordinal = SkillOrdinal.make(state.highWater + 1);
      const revision = version + 1;
      const at = DateTime.toEpochMillis(now);

      const skill = FrozenSkill.make({
        id: skillIdForOrdinal(ordinal),
        name: command.name,
        body: command.body,
        status: "proposed",
        createdAt: at,
        updatedAt: at,
      });

      const event = new SkillProposed({
        libraryId: id,
        skill,
        proposalRevision: revision,
        highWaterAfter: ordinal,
      });

      if (
        encodedJsonBytes(Schema.encodeSync(SkillProposed)(event)) > MAX_SKILL_JSON_BYTES ||
        encodedJsonBytes({
          ...skill,
          libraryId: id,
          proposalRevision: revision,
          updatedAt: Number.MAX_SAFE_INTEGER,
          detailRevision: Number.MAX_SAFE_INTEGER,
        }) > MAX_SKILL_JSON_BYTES
      ) {
        return yield* new SkillPayloadTooLarge();
      }

      if (
        reservedCatalogueBytes(proposalState(state, skill, revision, ordinal)) >
        MAX_LIBRARY_JSON_BYTES
      ) {
        return yield* new LibraryFull();
      }

      return [event];
    }),
    AcceptSkill: Effect.fnUntraced(function* (state, command, { id, now, version }) {
      yield* requireOwner(id);

      if (!Schema.is(FinalizedImport)(state.importProgress)) {
        return yield* new LibraryImportRequired();
      }

      const skill = state.active.find((entry) => entry.id === command.skillId);

      if (!skill) {
        return yield* new SkillMissing({ skillId: command.skillId });
      }

      if (skill.proposalRevision !== command.expectedProposalRevision) {
        return yield* new StaleSkillProposal({
          skillId: skill.id,
          actualRevision: skill.proposalRevision,
        });
      }

      if (skill.status === "accepted") {
        return yield* new SkillAlreadyAccepted({ skillId: skill.id });
      }

      if (version >= Number.MAX_SAFE_INTEGER) {
        return yield* new LibraryVersionExhausted();
      }

      return [
        new SkillAccepted({
          libraryId: id,
          skillId: skill.id,
          proposalRevision: skill.proposalRevision,
          revision: version + 1,
          updatedAt: DateTime.toEpochMillis(now),
        }),
      ];
    }),
    RemoveSkill: Effect.fnUntraced(function* (state, command, { id, now, version }) {
      yield* requireOwner(id);

      if (!Schema.is(FinalizedImport)(state.importProgress)) {
        return yield* new LibraryImportRequired();
      }

      const skill = state.active.find((entry) => entry.id === command.skillId);

      if (!skill) {
        return yield* new SkillMissing({ skillId: command.skillId });
      }

      if (skill.proposalRevision !== command.expectedProposalRevision) {
        return yield* new StaleSkillProposal({
          skillId: skill.id,
          actualRevision: skill.proposalRevision,
        });
      }

      if (version >= Number.MAX_SAFE_INTEGER) {
        return yield* new LibraryVersionExhausted();
      }

      return [
        new SkillRemoved({
          libraryId: id,
          skillId: skill.id,
          proposalRevision: skill.proposalRevision,
          revision: version + 1,
          updatedAt: DateTime.toEpochMillis(now),
        }),
      ];
    }),
    ImportSkill: Effect.fnUntraced(function* (state, command, { id, version }) {
      yield* requireImporter(id);

      if (Schema.is(FinalizedImport)(state.importProgress)) {
        return yield* new LibraryAlreadyFinalized();
      }

      if (
        state.importProgress.inventoryId !== null &&
        state.importProgress.inventoryId !== command.inventoryId
      ) {
        return yield* new LibraryImportConflict();
      }

      const ordinal = importedOrdinal(command.skill.id);

      if (ordinal === "invalid") {
        return yield* new InvalidImportedSkillId({ skillId: command.skill.id });
      }

      if (state.active.some((skill) => skill.id === command.skill.id)) {
        return yield* new SkillIdentityExists({ skillId: command.skill.id });
      }

      if (version >= Number.MAX_SAFE_INTEGER) {
        return yield* new LibraryVersionExhausted();
      }

      const revision = version + 1;
      const highWater = Math.max(state.highWater, ordinal);

      const event = new SkillImported({
        libraryId: id,
        inventoryId: command.inventoryId,
        skill: command.skill,
        proposalRevision: revision,
        highWaterAfter: highWater,
      });

      if (
        encodedJsonBytes(Schema.encodeSync(SkillImported)(event)) > MAX_SKILL_JSON_BYTES ||
        encodedJsonBytes({
          ...command.skill,
          libraryId: id,
          proposalRevision: revision,
          updatedAt: Number.MAX_SAFE_INTEGER,
          detailRevision: Number.MAX_SAFE_INTEGER,
        }) > MAX_SKILL_JSON_BYTES
      ) {
        return yield* new SkillPayloadTooLarge();
      }

      if (
        reservedCatalogueBytes(proposalState(state, command.skill, revision, highWater)) >
        MAX_LIBRARY_JSON_BYTES
      ) {
        return yield* new LibraryFull();
      }

      return [event];
    }),
    FinalizeLibraryImport: Effect.fnUntraced(function* (state, command, { id, version }) {
      yield* requireImporter(id);

      if (Schema.is(FinalizedImport)(state.importProgress)) {
        return yield* new LibraryAlreadyFinalized();
      }

      if (
        (state.importProgress.inventoryId !== null &&
          state.importProgress.inventoryId !== command.inventoryId) ||
        state.importProgress.importedCount !== command.expectedImportedCount ||
        state.highWater !== command.expectedHighWater
      ) {
        return yield* new LibraryImportConflict();
      }

      if (version >= Number.MAX_SAFE_INTEGER) {
        return yield* new LibraryVersionExhausted();
      }

      return [
        new LibraryImportFinalized({
          libraryId: id,
          inventoryId: command.inventoryId,
          importedCount: state.importProgress.importedCount,
          highWaterAfter: state.highWater,
          revision: version + 1,
        }),
      ];
    }),
  },
  evolve: {
    LibraryAllocatorFloorAdvanced: (state, event) => ({
      ...state,
      highWater: event.highWaterAfter,
      catalogueRevision: event.revision,
    }),
    SkillProposed: (state, event) =>
      proposalState(state, event.skill, event.proposalRevision, event.highWaterAfter),
    SkillImported: (state, event) => ({
      ...proposalState(state, event.skill, event.proposalRevision, event.highWaterAfter),
      importProgress: ImportingLibrary.make({
        inventoryId: event.inventoryId,
        importedCount: state.importProgress.importedCount + 1,
      }),
    }),
    LibraryImportFinalized: (state, event) => ({
      ...state,
      catalogueRevision: event.revision,
      highWater: event.highWaterAfter,
      importProgress: FinalizedImport.make({
        inventoryId: event.inventoryId,
        importedCount: event.importedCount,
      }),
    }),
    SkillAccepted: (state, event) => ({
      ...state,
      catalogueRevision: event.revision,
      active: state.active.map((skill): SkillMetadata =>
        skill.id === event.skillId
          ? {
              ...skill,
              status: "accepted",
              updatedAt: event.updatedAt,
              detailRevision: event.revision,
            }
          : skill,
      ),
    }),
    SkillRemoved: (state, event) => ({
      ...state,
      catalogueRevision: event.revision,
      active: state.active.filter((skill) => skill.id !== event.skillId),
    }),
  },
  reply: {
    ProposeSkill: (_state, events) => {
      // SAFETY: ProposeSkill decide succeeds only with one SkillProposed event;
      // Domain computes the reply from those committed events and retains it in the receipt.
      const event = events.find(Schema.is(SkillProposed)) as SkillProposed;

      return {
        skillId: event.skill.id,
        proposalRevision: event.proposalRevision,
      };
    },
  },
  read: {
    middleware: [LibrarySession],
    rejects: [LibraryNotOwner, LibraryImportRequired],
    validate: Effect.fnUntraced(function* (request, state) {
      yield* requireOwner(request.key.id);

      if (!Schema.is(FinalizedImport)(state.importProgress)) {
        return yield* new LibraryImportRequired();
      }
    }),
  },
}) {}
