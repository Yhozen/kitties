import { Option } from "effect";
import { modifyFields } from "foldkit/struct";
import { ReadSkillDetail, ReauthenticateLibrary } from "./command.ts";
import { Authentication, Model, Submission, refreshRead } from "./model.ts";
import { selectedKey } from "./selection.ts";
import type { UpdateReturn } from "./update.types.ts";

export const requestReauthentication = (model: Model): UpdateReturn => {
  if (
    Authentication.guards.Reauthenticating(model.authentication) ||
    (Authentication.guards.Failed(model.authentication) &&
      model.authentication.reason === "ChangedAuthority")
  ) {
    return { model };
  }

  if (model.authenticationAttempt >= Number.MAX_SAFE_INTEGER) {
    return { model: modifyFields(model, { maybeNotice: () => Option.some("CounterExhausted") }) };
  }

  const attempt = model.authenticationAttempt + 1;

  return {
    model: modifyFields(model, {
      authentication: () => Authentication.Reauthenticating(),
      authenticationAttempt: () => attempt,
      catalogueWatch: () => "Stopped",
    }),
    commands: [ReauthenticateLibrary({ scope: model.scope, attempt })],
  };
};

export const reconnect = (model: Model): UpdateReturn => {
  if (!Authentication.guards.Ready(model.authentication)) {
    return { model };
  }

  if (
    model.catalogueGeneration >= Number.MAX_SAFE_INTEGER ||
    model.detailGeneration >= Number.MAX_SAFE_INTEGER
  ) {
    return { model: modifyFields(model, { maybeNotice: () => Option.some("CounterExhausted") }) };
  }

  const generation = model.detailGeneration + 1;
  const maybeKey = selectedKey(model);

  return {
    model: modifyFields(model, {
      catalogue: refreshRead,
      catalogueWatch: () => "Starting",
      catalogueGeneration: (current) => current + 1,
      detail: Option.isSome(maybeKey) ? refreshRead : () => model.detail,
      detailGeneration: () => generation,
    }),
    commands: Option.match(maybeKey, {
      onNone: () => [],
      onSome: (key) => [
        ReadSkillDetail({ key, generation, maybeAtLeast: model.maybeDetailBarrier }),
      ],
    }),
  };
};

export const reauthenticated = (model: Model, attempt: number): UpdateReturn => {
  if (
    !Authentication.guards.Reauthenticating(model.authentication) ||
    model.authenticationAttempt !== attempt
  ) {
    return { model };
  }

  const nextModel = modifyFields(model, {
    authentication: () => Authentication.Ready(),
    submission: (submission) =>
      Submission.guards.Denied(submission)
        ? Submission.Unknown({ request: submission.request })
        : submission,
  });

  return reconnect(nextModel);
};
