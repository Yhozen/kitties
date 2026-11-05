import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { LibraryActor } from "../LibraryActor.context.ts";
import { LibrarySession } from "../LibrarySession.middleware.ts";
import { Library } from "./Library.aggregate.ts";
import { LibraryId } from "./Library.id.ts";
import { LibraryImportRequired, LibraryNotOwner } from "./Library.rejection.ts";
import { SkillDetailKey, SkillId, detailOwner, skillDetailKey } from "./Skill.id.ts";
import { ProposalRevision, SkillBody, SkillName, SkillTimestamp } from "./Skill.ts";

export const SkillDetailRecord = Schema.Struct({
  libraryId: LibraryId,
  id: SkillId,
  name: SkillName,
  body: SkillBody,
  status: Schema.Literals(["proposed", "accepted", "removed"]),
  createdAt: Schema.optional(SkillTimestamp),
  updatedAt: SkillTimestamp,
  proposalRevision: ProposalRevision,
  detailRevision: ProposalRevision,
});

export type SkillDetailRecord = typeof SkillDetailRecord.Type;

export class SkillDetail extends Domain.View("SkillDetail", {
  from: [Library],
  key: SkillDetailKey,
  version: 1,
  middleware: [LibrarySession],
  rejects: [LibraryNotOwner, LibraryImportRequired],
  state: Schema.NullOr(SkillDetailRecord),
  initial: null,
  keyOf: {
    SkillProposed: ({ event }) => skillDetailKey(event.libraryId, event.skill.id),
    SkillImported: ({ event }) => skillDetailKey(event.libraryId, event.skill.id),
    SkillAccepted: ({ event }) => skillDetailKey(event.libraryId, event.skillId),
    SkillRemoved: ({ event }) => skillDetailKey(event.libraryId, event.skillId),
    LibraryImportFinalized: () => undefined,
    LibraryAllocatorFloorAdvanced: () => undefined,
  },
  evolve: {
    SkillProposed: (_state, event) => ({
      ...event.skill,
      libraryId: event.libraryId,
      proposalRevision: event.proposalRevision,
      detailRevision: event.proposalRevision,
    }),
    SkillImported: (_state, event) => ({
      ...event.skill,
      libraryId: event.libraryId,
      proposalRevision: event.proposalRevision,
      detailRevision: event.proposalRevision,
    }),
    SkillAccepted: (state, event): SkillDetailRecord | null =>
      state === null || state.proposalRevision !== event.proposalRevision
        ? state
        : {
            ...state,
            status: "accepted",
            updatedAt: event.updatedAt,
            detailRevision: event.revision,
          },
    SkillRemoved: (state, event): SkillDetailRecord | null =>
      state === null || state.proposalRevision !== event.proposalRevision
        ? state
        : {
            ...state,
            status: "removed",
            updatedAt: event.updatedAt,
            detailRevision: event.revision,
          },
  },
  validate: Effect.fnUntraced(function* (request, state) {
    const actor = yield* LibraryActor;

    if (
      actor.authority !== "owner" ||
      actor.libraryId !== detailOwner(request.key) ||
      (state !== null && state.libraryId !== actor.libraryId)
    ) {
      return yield* new LibraryNotOwner();
    }

    if (!actor.importFinalized) {
      return yield* new LibraryImportRequired();
    }
  }),
}) {}
