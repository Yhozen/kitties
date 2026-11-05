import * as Schema from "effect/Schema";
import { ImportInventoryId, LibraryVersion, SkillMetadata, encodedJsonBytes } from "./Skill.ts";

export const PendingImport = Schema.TaggedStruct("Pending", {
  inventoryId: Schema.Null,
  importedCount: Schema.Literal(0),
});

export const ImportingLibrary = Schema.TaggedStruct("Importing", {
  inventoryId: ImportInventoryId,
  importedCount: LibraryVersion,
});

export const FinalizedImport = Schema.TaggedStruct("Finalized", {
  inventoryId: ImportInventoryId,
  importedCount: LibraryVersion,
});

export const LibraryState = Schema.Struct({
  active: Schema.Array(SkillMetadata),
  highWater: LibraryVersion,
  catalogueRevision: LibraryVersion,
  importProgress: Schema.Union([PendingImport, ImportingLibrary, FinalizedImport]),
});

export type LibraryState = typeof LibraryState.Type;

export const initialLibrary: LibraryState = {
  active: [],
  highWater: 0,
  catalogueRevision: 0,
  importProgress: PendingImport.make({ inventoryId: null, importedCount: 0 }),
};

export const reservedCatalogueBytes = (state: LibraryState): number =>
  encodedJsonBytes({
    ...state,
    highWater: Number.MAX_SAFE_INTEGER,
    catalogueRevision: Number.MAX_SAFE_INTEGER,
    importProgress: FinalizedImport.make({
      inventoryId: "x".repeat(128),
      importedCount: Number.MAX_SAFE_INTEGER,
    }),
    active: state.active.map((entry) => ({
      ...entry,
      updatedAt: Number.MAX_SAFE_INTEGER,
      detailRevision: Number.MAX_SAFE_INTEGER,
    })),
  });
