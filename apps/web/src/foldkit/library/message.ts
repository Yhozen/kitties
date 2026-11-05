import { SkillDetailKey, SkillId } from "@kitties/domain/Library/Skill.id";
import { LibraryVersion } from "@kitties/domain/Library/Skill";
import { SkillDetailRecord } from "@kitties/domain/Library/SkillDetail.view";
import { LibraryState } from "@kitties/domain/Library/Library.state";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { LibraryClient } from "./client.ts";
import { ReauthenticationReason } from "./LibraryClientAuthentication.ts";
import { Language, ReadProblem } from "./model.ts";

export const Message = defineMessageUnion({
  UpdatedName: { value: Schema.String },
  UpdatedBody: { value: Schema.String },
  UpdatedLanguage: { language: Language },
  SubmittedProposal: {},
  ClickedReview: { skillId: SkillId },
  ClickedAccept: {},
  ClickedRemove: {},
  ClickedRetry: {},
  ClickedReconnect: {},
  ClickedReauthenticate: {},
  GotLibraryMessage: { message: LibraryClient.Message },
  UpdatedCatalogue: { generation: LibraryVersion, state: LibraryState },
  FailedCatalogueWatch: { generation: LibraryVersion, problem: ReadProblem },
  UpdatedDetail: {
    generation: LibraryVersion,
    key: SkillDetailKey,
    state: Schema.NullOr(SkillDetailRecord),
  },
  FailedDetailWatch: { generation: LibraryVersion, key: SkillDetailKey, problem: ReadProblem },
  SucceededReadSkillDetail: {
    generation: LibraryVersion,
    key: SkillDetailKey,
    state: Schema.NullOr(SkillDetailRecord),
  },
  FailedReadSkillDetail: { generation: LibraryVersion, key: SkillDetailKey, problem: ReadProblem },
  SucceededReauthenticateLibrary: { attempt: LibraryVersion },
  FailedReauthenticateLibrary: { attempt: LibraryVersion, reason: ReauthenticationReason },
});

export type Message = typeof Message.Type;
