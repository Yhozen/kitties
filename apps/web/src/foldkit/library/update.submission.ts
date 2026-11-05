import { next } from "@alchemy.run/domain/Foldkit";
import { SkillId } from "@kitties/domain/Library/Skill.id";
import { Match, Option } from "effect";
import { AsyncData, Command, FieldValidation } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { LibraryClient } from "./client.ts";
import { Message } from "./message.ts";
import {
  Authentication,
  Model,
  Operation,
  Receipt,
  Request,
  Submission,
  bodyRules,
  nameRules,
} from "./model.ts";
import { canReachLibrary, canStartOperation, confirmedDetail } from "./selection.ts";
import { selectSkill } from "./update.read.ts";
import { requestReauthentication } from "./update.session.ts";
import type { LibraryServices, UpdateReturn } from "./update.types.ts";

const sendRequest = (model: Model, request: Request): UpdateReturn => {
  const target = model.scope.owner;
  const commandId = request.commandId;

  const command = Operation.match<
    Command.Command<typeof LibraryClient.Message.Type, never, LibraryServices>
  >(request.operation, {
    Propose: ({ name, body }) =>
      LibraryClient.ProposeSkill({ target, input: { name, body }, commandId }),
    Accept: ({ skillId, expectedProposalRevision }) =>
      LibraryClient.AcceptSkill({
        target,
        input: { skillId, expectedProposalRevision },
        commandId,
      }),
    Remove: ({ skillId, expectedProposalRevision }) =>
      LibraryClient.RemoveSkill({
        target,
        input: { skillId, expectedProposalRevision },
        commandId,
      }),
  });

  return {
    model: modifyFields(model, {
      submission: () => Submission.Sending({ request }),
      maybeNotice: () => Option.none(),
    }),
    commands: [Command.mapMessage(command, (message) => Message.GotLibraryMessage({ message }))],
  };
};

const startOperation = (model: Model, operation: Operation): UpdateReturn => {
  if (!canStartOperation(model)) {
    return { model };
  }

  if (model.commandIds.sent >= Number.MAX_SAFE_INTEGER) {
    return { model: modifyFields(model, { maybeNotice: () => Option.some("CounterExhausted") }) };
  }

  const allocation = next(model.commandIds);

  const request = Request.make({
    commandId: `library:${model.scope.epoch}:${allocation.commandId}`,
    operation,
  });

  return sendRequest(modifyFields(model, { commandIds: () => allocation.commandIds }), request);
};

export const submitProposal = (model: Model): UpdateReturn => {
  const name = FieldValidation.validate(nameRules)(model.name.value);
  const body = FieldValidation.validate(bodyRules)(model.body.value);
  const validated = modifyFields(model, { name: () => name, body: () => body });

  if (
    !FieldValidation.allValid([
      [name, nameRules],
      [body, bodyRules],
    ])
  ) {
    return { model: modifyFields(validated, { maybeNotice: () => Option.some("InvalidDraft") }) };
  }

  return startOperation(validated, Operation.Propose({ name: name.value, body: body.value }));
};

export const submitDecision = (model: Model, kind: "Accept" | "Remove"): UpdateReturn =>
  Option.match(confirmedDetail(model), {
    onNone: () => ({ model }),
    onSome: (detail) =>
      detail.status === "removed" || (kind === "Accept" && detail.status !== "proposed")
        ? { model }
        : startOperation(
            model,
            kind === "Accept"
              ? Operation.Accept({
                  skillId: detail.id,
                  expectedProposalRevision: detail.proposalRevision,
                })
              : Operation.Remove({
                  skillId: detail.id,
                  expectedProposalRevision: detail.proposalRevision,
                }),
          ),
  });

export const retryOperation = (model: Model): UpdateReturn =>
  Submission.guards.Unknown(model.submission) && canReachLibrary(model)
    ? sendRequest(model, model.submission.request)
    : { model };

const matchesPending = (model: Model, commandId: string): boolean =>
  Submission.guards.Sending(model.submission) && model.submission.request.commandId === commandId;

const confirmReceipt = (model: Model, request: Request, receipt: Receipt): Model => {
  const catalogue = AsyncData.getData(model.catalogue);

  const isSubmittedDraft =
    Operation.guards.Propose(request.operation) &&
    model.name.value === request.operation.name &&
    model.body.value === request.operation.body;

  return modifyFields(model, {
    submission: () =>
      Option.isSome(catalogue) && catalogue.value.catalogueRevision >= receipt.version
        ? Submission.Idle()
        : Submission.Confirming({ request, receipt }),
    maybeNotice: () => Option.some("Saved"),
    name: (name) => (isSubmittedDraft ? FieldValidation.NotValidated({ value: "" }) : name),
    body: (body) => (isSubmittedDraft ? FieldValidation.NotValidated({ value: "" }) : body),
  });
};

const succeedOperation = (
  model: Model,
  commandId: string,
  receipt: Receipt,
  maybeSkillId: Option.Option<SkillId>,
): UpdateReturn => {
  if (
    !matchesPending(model, commandId) ||
    !Submission.guards.Sending(model.submission) ||
    (Authentication.guards.Failed(model.authentication) &&
      model.authentication.reason === "ChangedAuthority")
  ) {
    return { model };
  }

  const request = model.submission.request;

  const maybeTarget = Option.orElse(maybeSkillId, () =>
    Operation.match(request.operation, {
      Propose: () => Option.none<SkillId>(),
      Accept: ({ skillId }) => Option.some(skillId),
      Remove: ({ skillId }) => Option.some(skillId),
    }),
  );

  if (Option.isNone(maybeTarget)) {
    return { model };
  }

  const nextModel = confirmReceipt(model, request, receipt);

  return selectSkill(nextModel, maybeTarget.value, Option.some(receipt));
};

const failOperation = (
  model: Model,
  commandId: string,
  kind: "Unknown" | "Denied" | "Rejected",
): UpdateReturn => {
  if (!matchesPending(model, commandId) || !Submission.guards.Sending(model.submission)) {
    return { model };
  }

  const request = model.submission.request;

  const nextModel = modifyFields(model, {
    submission: () =>
      Match.value(kind).pipe(
        Match.when("Unknown", () => Submission.Unknown({ request })),
        Match.when("Denied", () => Submission.Denied({ request })),
        Match.when("Rejected", () => Submission.Idle()),
        Match.exhaustive,
      ),
    maybeNotice: () => (kind === "Rejected" ? Option.some("Rejected") : Option.none()),
  });

  return kind === "Denied" ? requestReauthentication(nextModel) : { model: nextModel };
};

export const handleLibraryMessage = (
  model: Model,
  message: typeof LibraryClient.Message.Type,
): UpdateReturn =>
  LibraryClient.Message.match<UpdateReturn>(message, {
    SucceededProposeSkill: ({ commandId, receipt, reply }) =>
      succeedOperation(model, commandId, receipt, Option.some(reply.skillId)),
    SucceededAcceptSkill: ({ commandId, receipt }) =>
      succeedOperation(model, commandId, receipt, Option.none()),
    SucceededRemoveSkill: ({ commandId, receipt }) =>
      succeedOperation(model, commandId, receipt, Option.none()),
    FailedProposeSkill: ({ commandId, failure }) => failOperation(model, commandId, failure._tag),
    FailedAcceptSkill: ({ commandId, failure }) => failOperation(model, commandId, failure._tag),
    FailedRemoveSkill: ({ commandId, failure }) => failOperation(model, commandId, failure._tag),
  });
