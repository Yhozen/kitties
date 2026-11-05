import * as Domain from "@alchemy.run/domain";
import { LibraryModel } from "./Library.model.ts";

export class LibraryImportApi extends Domain.Api("LibraryImportApi", {
  model: LibraryModel,
  commands: ["ImportSkill", "FinalizeLibraryImport"],
  views: [],
  aggregates: [],
  streams: [],
}) {}
