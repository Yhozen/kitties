import { LibraryApi } from "@kitties/domain/LibraryApi.api";
import { LibraryId } from "@kitties/domain/Library/Library.id";
import { SkillDetailKey } from "@kitties/domain/Library/Skill.id";
import { LibraryVersion } from "@kitties/domain/Library/Skill";
import { Option, Schema, Stream } from "effect";
import { AsyncData, Subscription } from "foldkit";
import { LibraryClient } from "./client.ts";
import { readProblem } from "./command.ts";
import { Message } from "./message.ts";
import { Authentication, Model } from "./model.ts";
import { selectedKey } from "./selection.ts";

export const subscriptions = Subscription.make<
  Model,
  Message,
  typeof LibraryApi.Client.Identifier
>()((entry) => ({
  catalogue: entry(
    { owner: LibraryId, generation: LibraryVersion, isEnabled: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        owner: model.scope.owner,
        generation: model.catalogueGeneration,
        isEnabled:
          Authentication.guards.Ready(model.authentication) && model.catalogueWatch !== "Stopped",
      }),
      dependenciesToStream: ({ owner, generation, isEnabled }) =>
        LibraryClient.Library.watch<Model, Message>({
          key: () => owner,
          toMessage: ({ state }) =>
            Option.match(state, {
              onNone: () => Message.FailedCatalogueWatch({ generation, problem: "NotReady" }),
              onSome: (state) => Message.UpdatedCatalogue({ generation, state }),
            }),
          onFailure: (error) =>
            Message.FailedCatalogueWatch({ generation, problem: readProblem(error) }),
          onDefect: () => Message.FailedCatalogueWatch({ generation, problem: "Unavailable" }),
        }).dependenciesToStream({ key: owner, isEnabled }),
    },
  ),
  detail: entry(
    {
      maybeKey: Schema.Option(SkillDetailKey),
      generation: LibraryVersion,
      isEnabled: Schema.Boolean,
    },
    {
      modelToDependencies: (model) => ({
        maybeKey: selectedKey(model),
        generation: model.detailGeneration,
        isEnabled:
          Authentication.guards.Ready(model.authentication) &&
          model.catalogueWatch !== "Stopped" &&
          AsyncData.isSuccess(model.detail),
      }),
      dependenciesToStream: ({ maybeKey, generation, isEnabled }) =>
        Option.match(maybeKey, {
          onNone: () => Stream.empty,
          onSome: (key) =>
            LibraryClient.SkillDetail.watch<Model, Message>({
              key: () => key,
              toMessage: ({ state }) =>
                Message.UpdatedDetail({ key, generation, state: Option.getOrNull(state) }),
              onFailure: (error) =>
                Message.FailedDetailWatch({ key, generation, problem: readProblem(error) }),
              onDefect: () =>
                Message.FailedDetailWatch({ key, generation, problem: "Unavailable" }),
            }).dependenciesToStream({ key, isEnabled }),
        }),
    },
  ),
}));
