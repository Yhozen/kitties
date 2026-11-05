import * as Aggregate from "@alchemy.run/domain/Aggregate";
import { Library } from "@kitties/domain/Library/Library.aggregate";
import { SkillDetailKey, SkillId, skillDetailKey } from "@kitties/domain/Library/Skill.id";
import { LibraryState } from "@kitties/domain/Library/Library.state";
import { SkillDetailRecord } from "@kitties/domain/Library/SkillDetail.view";
import { Array, Option, Result } from "effect";
import { AsyncData } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { ReadSkillDetail } from "./command.ts";
import {
  Authentication,
  Catalogue,
  Detail,
  Model,
  ReadProblem,
  Receipt,
  Submission,
} from "./model.ts";
import { selectedKey } from "./selection.ts";
import { requestReauthentication } from "./update.session.ts";
import type { UpdateReturn } from "./update.types.ts";

export const selectSkill = (
  model: Model,
  skillId: SkillId,
  maybeAtLeast: Option.Option<Receipt> = Option.none(),
): UpdateReturn => {
  if (
    (!Authentication.guards.Ready(model.authentication) && Option.isNone(maybeAtLeast)) ||
    model.detailGeneration >= Number.MAX_SAFE_INTEGER
  ) {
    return { model };
  }

  const generation = model.detailGeneration + 1;
  const key = skillDetailKey(model.scope.owner, skillId);

  return {
    model: modifyFields(model, {
      maybeSelected: () => Option.some(skillId),
      detail: () => Detail.Loading(),
      detailGeneration: () => generation,
      maybeDetailBarrier: () => maybeAtLeast,
    }),
    commands: Array.fromOption(
      Authentication.guards.Ready(model.authentication)
        ? Option.some(ReadSkillDetail({ key, generation, maybeAtLeast }))
        : Option.none(),
    ),
  };
};

export const receiveCatalogue = (
  model: Model,
  generation: number,
  state: LibraryState,
): UpdateReturn => {
  if (
    generation !== model.catalogueGeneration ||
    !Authentication.guards.Ready(model.authentication) ||
    model.catalogueWatch === "Stopped"
  ) {
    return { model };
  }

  const previous = AsyncData.getData(model.catalogue);

  if (Option.isSome(previous) && previous.value.catalogueRevision > state.catalogueRevision) {
    return { model };
  }

  return {
    model: modifyFields(model, {
      catalogue: () => Catalogue.Success({ data: state }),
      catalogueWatch: () => "Live",
      submission: (submission) =>
        Submission.guards.Confirming(submission) &&
        state.catalogueRevision >= submission.receipt.version
          ? Submission.Idle()
          : submission,
    }),
  };
};

export const receiveDetail = (
  model: Model,
  generation: number,
  key: SkillDetailKey,
  state: SkillDetailRecord | null,
): UpdateReturn => {
  if (
    generation !== model.detailGeneration ||
    !Option.contains(selectedKey(model), key) ||
    !Authentication.guards.Ready(model.authentication) ||
    AsyncData.hasError(model.detail)
  ) {
    return { model };
  }

  const previous = AsyncData.getData(model.detail);

  if (
    state !== null &&
    (state.libraryId !== model.scope.owner || !Option.contains(model.maybeSelected, state.id))
  ) {
    return failDetail(model, generation, key, "Unavailable");
  }

  const minimum = Option.getOrElse(
    Option.map(model.maybeDetailBarrier, (receipt) => receipt.version),
    () => 0,
  );

  if (
    state !== null &&
    (state.detailRevision < minimum ||
      (Option.isSome(previous) &&
        previous.value !== null &&
        state.detailRevision < previous.value.detailRevision))
  ) {
    return { model };
  }

  return { model: modifyFields(model, { detail: () => Detail.Success({ data: state }) }) };
};

export const failCatalogue = (
  model: Model,
  generation: number,
  problem: ReadProblem,
): UpdateReturn => {
  if (generation !== model.catalogueGeneration || model.catalogueWatch === "Stopped") {
    return { model };
  }

  const nextModel = modifyFields(model, {
    catalogue: (catalogue) => AsyncData.settle(catalogue, Result.fail(problem)),
    catalogueWatch: () => "Stopped",
  });

  return problem === "Authentication" ? requestReauthentication(nextModel) : { model: nextModel };
};

export const failDetail = (
  model: Model,
  generation: number,
  key: SkillDetailKey,
  problem: ReadProblem,
): UpdateReturn => {
  if (generation !== model.detailGeneration || !Option.contains(selectedKey(model), key)) {
    return { model };
  }

  const nextModel = modifyFields(model, {
    detail: (detail) => AsyncData.settle(detail, Result.fail(problem)),
  });

  return problem === "Authentication" ? requestReauthentication(nextModel) : { model: nextModel };
};

export const reviewSkill = (model: Model, skillId: SkillId): UpdateReturn => {
  const catalogue = AsyncData.getData(model.catalogue);

  if (!Authentication.guards.Ready(model.authentication) || Option.isNone(catalogue)) {
    return { model };
  }

  return Option.match(
    Array.findFirst(catalogue.value.active, (skill) => skill.id === skillId),
    {
      onNone: () => ({ model }),
      onSome: (skill) =>
        selectSkill(
          model,
          skillId,
          Option.some({
            stream: Aggregate.streamOf(Library.ref(model.scope.owner)),
            version: skill.detailRevision,
          }),
        ),
    },
  );
};
