import * as Domain from "@alchemy.run/domain";
import { LibraryImportSession } from "../LibrarySession.middleware.ts";
import { LibraryId } from "./Library.id.ts";
import { ImportInventoryId, LibraryVersion, ProposalRevision } from "./Skill.ts";
import {
  LibraryAlreadyFinalized,
  LibraryImportConflict,
  LibraryImportForbidden,
  LibraryNotOwner,
  LibraryVersionExhausted,
} from "./Library.rejection.ts";

export class LibraryImportFinalized extends Domain.Event("LibraryImportFinalized", {
  libraryId: LibraryId,
  inventoryId: ImportInventoryId,
  importedCount: LibraryVersion,
  highWaterAfter: LibraryVersion,
  revision: ProposalRevision,
}) {}

export class FinalizeLibraryImport extends Domain.Command("FinalizeLibraryImport", {
  target: LibraryId,
  middleware: [LibraryImportSession],
  input: {
    inventoryId: ImportInventoryId,
    expectedImportedCount: LibraryVersion,
    expectedHighWater: LibraryVersion,
  },
  events: [LibraryImportFinalized],
  rejects: [
    LibraryNotOwner,
    LibraryImportForbidden,
    LibraryAlreadyFinalized,
    LibraryImportConflict,
    LibraryVersionExhausted,
  ],
}) {}
