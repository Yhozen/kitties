import { CommandIds } from "@alchemy.run/domain/Foldkit";
import { LibraryState } from "@kitties/domain/Library/Library.state";
import { SkillId } from "@kitties/domain/Library/Skill.id";
import {
  LibraryVersion,
  ProposalRevision,
  SkillBody,
  SkillName,
} from "@kitties/domain/Library/Skill";
import { SkillDetailRecord } from "@kitties/domain/Library/SkillDetail.view";
import { Option, Schema } from "effect";
import { AsyncData, FieldValidation } from "foldkit";
import { defineTaggedUnion } from "foldkit/schema";
import { LibraryClientScope, ReauthenticationReason } from "./LibraryClientAuthentication.ts";

export const Language = Schema.Literals(["en", "es", "pt"]);

export type Language = typeof Language.Type;

export const Flags = Schema.Struct({ scope: LibraryClientScope, language: Language });

export type Flags = typeof Flags.Type;

export const ReadProblem = Schema.Literals(["Authentication", "NotReady", "Unavailable"]);

export type ReadProblem = typeof ReadProblem.Type;

export const Receipt = Schema.Struct({ stream: Schema.String, version: LibraryVersion });

export type Receipt = typeof Receipt.Type;

export const Operation = defineTaggedUnion({
  Propose: { name: SkillName, body: SkillBody },
  Accept: { skillId: SkillId, expectedProposalRevision: ProposalRevision },
  Remove: { skillId: SkillId, expectedProposalRevision: ProposalRevision },
});

export type Operation = typeof Operation.Type;

export const Request = Schema.Struct({ commandId: Schema.String, operation: Operation });

export type Request = typeof Request.Type;

export const Submission = defineTaggedUnion({
  Idle: {},
  Sending: { request: Request },
  Unknown: { request: Request },
  Denied: { request: Request },
  Confirming: { request: Request, receipt: Receipt },
});

export const Authentication = defineTaggedUnion({
  Ready: {},
  Reauthenticating: {},
  Failed: { reason: ReauthenticationReason },
});

export const Catalogue = AsyncData.Schema(LibraryState, ReadProblem);
export const Detail = AsyncData.Schema(Schema.NullOr(SkillDetailRecord), ReadProblem);

export const Model = Schema.Struct({
  scope: LibraryClientScope,
  language: Language,
  commandIds: CommandIds,
  name: FieldValidation.Field(Schema.String),
  body: FieldValidation.Field(Schema.String),
  catalogue: Catalogue.schema,
  catalogueWatch: Schema.Literals(["Starting", "Live", "Stopped"]),
  catalogueGeneration: LibraryVersion,
  maybeSelected: Schema.Option(SkillId),
  detail: Detail.schema,
  detailGeneration: LibraryVersion,
  maybeDetailBarrier: Schema.Option(Receipt),
  submission: Submission,
  authentication: Authentication,
  authenticationAttempt: LibraryVersion,
  maybeNotice: Schema.Option(
    Schema.Literals(["Saved", "Rejected", "InvalidDraft", "CounterExhausted"]),
  ),
});

export type Model = typeof Model.Type;

export const refreshRead = <A, E>(value: AsyncData.AsyncData<A, E>) =>
  Option.getOrElse(AsyncData.revalidateOrLoad(value), () => value);

export const nameRules = FieldValidation.makeRules({
  required: "Name",
  rules: [FieldValidation.Rule.fromSchema(SkillName, "Name")],
});

export const bodyRules = FieldValidation.makeRules({
  rules: [FieldValidation.Rule.fromSchema(SkillBody, "Instructions")],
});

export const init = (flags: Flags) => ({
  model: Model.make({
    scope: flags.scope,
    language: flags.language,
    commandIds: { session: flags.scope.sessionId, sent: 0 },
    name: FieldValidation.NotValidated({ value: "" }),
    body: FieldValidation.NotValidated({ value: "" }),
    catalogue: Catalogue.Loading(),
    catalogueWatch: "Starting",
    catalogueGeneration: 0,
    maybeSelected: Option.none(),
    detail: Detail.Idle(),
    detailGeneration: 0,
    maybeDetailBarrier: Option.none(),
    submission: Submission.Idle(),
    authentication: Authentication.Ready(),
    authenticationAttempt: 0,
    maybeNotice: Option.none(),
  }),
});
