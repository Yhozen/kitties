import * as Domain from "@alchemy.run/domain";
import { LibraryRecoverySession } from "../LibrarySession.middleware.ts";
import { LibraryId } from "./Library.id.ts";
import {
  LibraryImportRequired,
  LibraryNotOwner,
  LibraryVersionExhausted,
} from "./Library.rejection.ts";
import { LibraryVersion, ProposalRevision } from "./Skill.ts";

export class LibraryRecoveryForbidden extends Domain.Rejection("LibraryRecoveryForbidden") {}

export class LibraryAllocatorFloorAdvanced extends Domain.Event("LibraryAllocatorFloorAdvanced", {
  libraryId: LibraryId,
  highWaterAfter: LibraryVersion,
  revision: ProposalRevision,
}) {}

export class AdvanceLibraryAllocatorFloor extends Domain.Command("AdvanceLibraryAllocatorFloor", {
  target: LibraryId,
  middleware: [LibraryRecoverySession],
  input: { floor: LibraryVersion },
  events: [LibraryAllocatorFloorAdvanced],
  rejects: [
    LibraryRecoveryForbidden,
    LibraryNotOwner,
    LibraryImportRequired,
    LibraryVersionExhausted,
  ],
}) {}
