import { Story } from "@alchemy.run/domain/Story";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { LibraryModel } from "../Library.model.ts";
import { LibraryActor } from "../LibraryActor.context.ts";
import { AcceptSkill, SkillAccepted } from "./AcceptSkill.command.ts";
import { LibraryImportFinalized } from "./FinalizeLibraryImport.command.ts";
import { ImportSkill, SkillImported } from "./ImportSkill.command.ts";
import { Library } from "./Library.aggregate.ts";
import { LibraryId } from "./Library.id.ts";
import { LibraryFull } from "./Library.rejection.ts";
import { reservedCatalogueBytes } from "./Library.state.ts";
import { ProposeSkill, SkillProposed } from "./ProposeSkill.command.ts";
import { RemoveSkill, SkillRemoved } from "./RemoveSkill.command.ts";
import { SkillId } from "./Skill.id.ts";
import { encodedJsonBytes } from "./Skill.ts";

const owner = LibraryId.make("owner");
const ref = Library.ref(owner);
const name = "界".repeat(80);

const inventory = Array.from(
  { length: 1389 },
  (_, index) =>
    new SkillImported({
      libraryId: owner,
      inventoryId: "frozen-v1",
      skill: {
        id: SkillId.make(`legacy-${String(index).padStart(4, "0")}`),
        name,
        body: "",
        status: "proposed",
        updatedAt: 0,
      },
      proposalRevision: index + 1,
      highWaterAfter: 0,
    }),
);

const first = SkillId.make("legacy-0000");

it.effect(
  "budgets Unicode encoded bytes without an arbitrary 512-item ceiling; removal frees admission capacity",
  () =>
    Story.make(LibraryModel)(
      Story.clock(0),
      Story.given(
        ref,
        ...inventory,
        new LibraryImportFinalized({
          libraryId: owner,
          inventoryId: "frozen-v1",
          importedCount: 1389,
          highWaterAfter: 0,
          revision: 1390,
        }),
      ),
      Story.provide(LibraryActor, { libraryId: owner, authority: "owner", importFinalized: true }),
      Story.state(ref, (state) => {
        expect(state.active).toHaveLength(1389);
        // Independently measured UTF-8 JSON fixture: 80 CJK characters use 240 bytes.
        expect(reservedCatalogueBytes(state)).toBe(524229);
        expect(encodedJsonBytes(state)).toBeLessThan(524288);
      }),
      Story.when(ref, new ProposeSkill({ name, body: "" })),
      Story.rejected(new LibraryFull()),
      Story.when(ref, new AcceptSkill({ skillId: first, expectedProposalRevision: 1 })),
      Story.then(
        ref,
        new SkillAccepted({
          libraryId: owner,
          skillId: first,
          proposalRevision: 1,
          revision: 1391,
          updatedAt: 0,
        }),
      ),
      Story.when(ref, new RemoveSkill({ skillId: first, expectedProposalRevision: 1 })),
      Story.then(
        ref,
        new SkillRemoved({
          libraryId: owner,
          skillId: first,
          proposalRevision: 1,
          revision: 1392,
          updatedAt: 0,
        }),
      ),
      Story.when(ref, new ProposeSkill({ name, body: "" })),
      Story.then(
        ref,
        new SkillProposed({
          libraryId: owner,
          skill: {
            id: SkillId.make("kitties-skill-0000000000000001"),
            name,
            body: "",
            status: "proposed",
            createdAt: 0,
            updatedAt: 0,
          },
          proposalRevision: 1393,
          highWaterAfter: 1,
        }),
      ),
      Story.state(ref, (state) => {
        expect(state.active).toHaveLength(1389);
        expect(state.active.some((skill) => skill.id === first)).toBe(false);
        expect(reservedCatalogueBytes(state)).toBeLessThanOrEqual(524288);
        expect(state.highWater).toBe(1);
      }),
    ),
);

it.effect("rejects over-capacity import visibly without truncating already imported entries", () =>
  Story.make(LibraryModel)(
    Story.given(ref, ...inventory),
    Story.provide(LibraryActor, { libraryId: owner, authority: "import", importFinalized: false }),
    Story.when(
      ref,
      new ImportSkill({
        inventoryId: "frozen-v1",
        skill: { id: SkillId.make("one-more"), name, body: "", status: "accepted", updatedAt: 0 },
      }),
    ),
    Story.rejected(new LibraryFull()),
    Story.state(ref, (state) => {
      expect(state.active).toHaveLength(1389);
      expect(state.importProgress.importedCount).toBe(1389);
      expect(state.importProgress._tag).toBe("Importing");
    }),
  ),
);
