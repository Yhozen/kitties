import { Option } from "effect";
import { FieldValidation } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { Message } from "./message.ts";
import { Authentication, Model, bodyRules, nameRules } from "./model.ts";
import {
  failCatalogue,
  failDetail,
  receiveCatalogue,
  receiveDetail,
  reviewSkill,
} from "./update.read.ts";
import { reauthenticated, reconnect, requestReauthentication } from "./update.session.ts";
import {
  handleLibraryMessage,
  retryOperation,
  submitDecision,
  submitProposal,
} from "./update.submission.ts";
import type { UpdateReturn } from "./update.types.ts";

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    UpdatedName: ({ value }) => ({
      model: modifyFields(model, { name: () => FieldValidation.validate(nameRules)(value) }),
    }),
    UpdatedBody: ({ value }) => ({
      model: modifyFields(model, { body: () => FieldValidation.validate(bodyRules)(value) }),
    }),
    UpdatedLanguage: ({ language }) => ({
      model: modifyFields(model, { language: () => language }),
    }),
    SubmittedProposal: () => submitProposal(model),
    ClickedReview: ({ skillId }) => reviewSkill(model, skillId),
    ClickedAccept: () => submitDecision(model, "Accept"),
    ClickedRemove: () => submitDecision(model, "Remove"),
    ClickedRetry: () => retryOperation(model),
    ClickedReconnect: () => reconnect(model),
    ClickedReauthenticate: () => requestReauthentication(model),
    GotLibraryMessage: ({ message }) => handleLibraryMessage(model, message),
    UpdatedCatalogue: ({ generation, state }) => receiveCatalogue(model, generation, state),
    FailedCatalogueWatch: ({ generation, problem }) => failCatalogue(model, generation, problem),
    UpdatedDetail: ({ generation, key, state }) => receiveDetail(model, generation, key, state),
    FailedDetailWatch: ({ generation, key, problem }) =>
      failDetail(model, generation, key, problem),
    SucceededReadSkillDetail: ({ generation, key, state }) =>
      receiveDetail(model, generation, key, state),
    FailedReadSkillDetail: ({ generation, key, problem }) =>
      failDetail(model, generation, key, problem),
    SucceededReauthenticateLibrary: ({ attempt }) => reauthenticated(model, attempt),
    FailedReauthenticateLibrary: ({ attempt, reason }) => ({
      model:
        model.authenticationAttempt === attempt &&
        Authentication.guards.Reauthenticating(model.authentication)
          ? modifyFields(model, {
              authentication: () => Authentication.Failed({ reason }),
              maybeNotice: () => Option.none(),
            })
          : model,
    }),
  });
