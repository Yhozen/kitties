import { SkillDetailRecord } from "@kitties/domain/Library/SkillDetail.view";
import { skillDetailKey } from "@kitties/domain/Library/Skill.id";
import { Array, Option } from "effect";
import { AsyncData } from "foldkit";
import { Authentication, Model, Submission } from "./model.ts";

export const selectedKey = (model: Model) =>
  Option.map(model.maybeSelected, (id) => skillDetailKey(model.scope.owner, id));

export const canReachLibrary = (model: Model): boolean =>
  Authentication.guards.Ready(model.authentication) &&
  model.catalogueWatch === "Live" &&
  AsyncData.isSuccess(model.catalogue);

export const canStartOperation = (model: Model): boolean =>
  canReachLibrary(model) && Submission.guards.Idle(model.submission);

export const confirmedDetail = (model: Model): Option.Option<SkillDetailRecord> => {
  if (!AsyncData.isSuccess(model.detail) || Option.isNone(model.maybeSelected)) {
    return Option.none();
  }

  const detail = model.detail.data;
  const catalogue = AsyncData.getData(model.catalogue);

  if (detail === null || Option.isNone(catalogue)) {
    return Option.none();
  }

  const metadata = Array.findFirst(catalogue.value.active, (skill) => skill.id === detail.id);

  return detail.libraryId === model.scope.owner &&
    detail.id === model.maybeSelected.value &&
    Option.isSome(metadata) &&
    metadata.value.proposalRevision === detail.proposalRevision &&
    metadata.value.detailRevision === detail.detailRevision &&
    metadata.value.status === detail.status
    ? Option.some(detail)
    : Option.none();
};
