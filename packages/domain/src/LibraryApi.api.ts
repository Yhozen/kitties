import * as Domain from "@alchemy.run/domain";
import { LibraryModel } from "./Library.model.ts";

export class LibraryApi extends Domain.Api("LibraryApi", {
  model: LibraryModel,
  commands: ["ProposeSkill", "AcceptSkill", "RemoveSkill"],
  views: ["SkillDetail"],
  aggregates: ["Library"],
  streams: [],
  parseOptions: { onExcessProperty: "error" },
}) {}
