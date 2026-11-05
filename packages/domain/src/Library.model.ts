import * as Domain from "@alchemy.run/domain";
import { Library } from "./Library/Library.aggregate.ts";
import { SkillDetail } from "./Library/SkillDetail.view.ts";

export class LibraryModel extends Domain.Model("LibraryModel", {
  aggregates: [Library],
  views: [SkillDetail],
}) {}
