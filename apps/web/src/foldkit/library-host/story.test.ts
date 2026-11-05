import { Option } from "effect";
import { Story } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { expect, test } from "vite-plus/test";
import * as Library from "../library/index.ts";
import { LibraryClient } from "../library/client.ts";
import { FixtureFailure, commandId, empty, flags as leafFlags } from "../library/fixtures.ts";
import { Operation } from "../library/model.ts";
import { ConnectLibrary, SavePreferences } from "./command.ts";
import { Message } from "./message.ts";
import { Flags, init } from "./model.ts";
import { subscriptions } from "./subscription.ts";
import { update } from "./update.ts";

const flags = Flags.make({
  preferences: { version: 1, language: "en", theme: "system" },
  platform: "browser",
  maybeBrowserSignInHref: Option.some("https://kitties.example/library.html"),
  maybePreferencesLoadError: Option.none(),
});

const initial = init(flags);

const connected = update(
  initial.model,
  Message.SucceededConnectLibrary({ attempt: 1, scope: leafFlags.scope }),
).model;

test("initial connection is noninteractive, never saves defaults and leaves child watches unmounted", () => {
  expect(initial.commands.map((command) => ({ name: command.name, args: command.args }))).toEqual([
    { name: "ConnectLibrary", args: { interactive: false, attempt: 1 } },
  ]);
  expect(initial.model.maybeLibrary).toEqual(Option.none());
  expect(subscriptions.catalogue.modelToDependencies(initial.model)).toEqual({
    maybeDependencies: Option.none(),
  });
  expect(update(initial.model, Message.ClickedSignIn())).toEqual({ model: initial.model });
});

test("sign-in after denial is interactive, rejects duplicate clicks and stale connection replies", () => {
  const denied = update(
    initial.model,
    Message.FailedConnectLibrary({ attempt: 1, reason: "Denied" }),
  ).model;

  Story.story(
    update,
    Story.given(denied),
    Story.message(Message.ClickedSignIn()),
    Story.Command.expectExact(ConnectLibrary({ interactive: true, attempt: 2 })),
    Story.model((model) => {
      expect(update(model, Message.ClickedSignIn())).toEqual({ model });
      expect(
        update(model, Message.SucceededConnectLibrary({ attempt: 1, scope: leafFlags.scope })),
      ).toEqual({ model });
      expect(model.maybeLibrary).toEqual(Option.none());
    }),
    Story.Command.resolve(
      ConnectLibrary,
      Message.SucceededConnectLibrary({ attempt: 2, scope: leafFlags.scope }),
    ),
    Story.message(Message.ClickedSignIn()),
    Story.Command.expectNone(),
    Story.model((model) => {
      expect(model.session._tag).toBe("Success");
      expect(model.session).toMatchObject({ data: leafFlags.scope });
      expect(Option.map(model.maybeLibrary, (library) => library.scope)).toEqual(
        Option.some(leafFlags.scope),
      );
      expect(subscriptions.catalogue.modelToDependencies(model)).toEqual({
        maybeDependencies: Option.some({
          owner: leafFlags.scope.owner,
          generation: 0,
          isEnabled: true,
        }),
      });
    }),
  );
});

test("changed authority is terminal and cannot adopt a late successful connection", () => {
  const changed = update(
    initial.model,
    Message.FailedConnectLibrary({ attempt: 1, reason: "ChangedAuthority" }),
  ).model;

  Story.story(
    update,
    Story.given(changed),
    Story.message(Message.ClickedSignIn()),
    Story.message(Message.SucceededConnectLibrary({ attempt: 1, scope: leafFlags.scope })),
    Story.Command.expectNone(),
    Story.model((model) => expect(model).toEqual(changed)),
  );
});

test("language preview folds through the mounted leaf without changing its unknown request, draft or subscription generation", () =>
  Story.story(
    update,
    Story.given(connected),
    Story.message(
      Message.GotLibraryMessage({
        message: Library.Message.UpdatedCatalogue({ generation: 0, state: empty }),
      }),
    ),
    Story.message(
      Message.GotLibraryMessage({
        message: Library.Message.UpdatedName({ value: "Keep this draft" }),
      }),
    ),
    Story.message(
      Message.GotLibraryMessage({
        message: Library.Message.UpdatedBody({ value: "Do not resend" }),
      }),
    ),
    Story.message(Message.GotLibraryMessage({ message: Library.Message.SubmittedProposal() })),
    Story.Command.resolve(
      LibraryClient.ProposeSkill,
      LibraryClient.Message.FailedProposeSkill({ commandId, failure: FixtureFailure.Unknown() }),
    ),
    Story.message(Message.SelectedLanguage({ value: "es" })),
    Story.Command.expectNone(),
    Story.message(Message.SubmittedPreferences()),
    Story.Command.expectExact(
      SavePreferences({ preferences: { version: 1, language: "es", theme: "system" }, attempt: 1 }),
    ),
    Story.Command.resolve(SavePreferences, Message.SucceededSavePreferences({ attempt: 1 })),
    Story.model((model) => {
      expect(model.preferences).toEqual({ version: 1, language: "es", theme: "system" });
      expect(model.savedPreferences).toEqual({ version: 1, language: "es", theme: "system" });
      expect(model.save._tag).toBe("Saved");
      expect(
        Option.map(model.maybeLibrary, (library) => ({
          language: library.language,
          name: library.name.value,
          body: library.body.value,
          submissionTag: library.submission._tag,
          request: "request" in library.submission ? library.submission.request : undefined,
          sent: library.commandIds.sent,
          generation: library.catalogueGeneration,
        })),
      ).toEqual(
        Option.some({
          language: "es",
          name: "Keep this draft",
          body: "Do not resend",
          sent: 1,
          generation: 0,
          submissionTag: "Unknown",
          request: {
            commandId,
            operation: Operation.Propose({ name: "Keep this draft", body: "Do not resend" }),
          },
        }),
      );
    }),
  ));

test("preferences save only on submission, freeze edits until ACK, and keep failures retryable without accepting stale replies", () =>
  Story.story(
    update,
    Story.given(
      modifyFields(initial.model, { maybePreferencesLoadError: () => Option.some("invalid-data") }),
    ),
    Story.message(Message.SelectedLanguage({ value: "pt" })),
    Story.message(Message.SelectedTheme({ value: "dark" })),
    Story.message(Message.SelectedTheme({ value: "untrusted-value" })),
    Story.message(Message.SelectedLanguage({ value: "fr" })),
    Story.Command.expectNone(),
    Story.message(Message.SubmittedPreferences()),
    Story.Command.expectExact(
      SavePreferences({ preferences: { version: 1, language: "pt", theme: "dark" }, attempt: 1 }),
    ),
    Story.model((model) => {
      expect(update(model, Message.SubmittedPreferences())).toEqual({ model });
      expect(update(model, Message.SelectedLanguage({ value: "en" }))).toEqual({ model });
      expect(update(model, Message.SelectedTheme({ value: "light" }))).toEqual({ model });
      expect(model.save._tag).toBe("Saving");
      expect(model.savedPreferences.language).toBe("en");
    }),
    Story.Command.resolve(
      SavePreferences,
      Message.FailedSavePreferences({ attempt: 1, reason: "timeout" }),
    ),
    Story.message(Message.SubmittedPreferences()),
    Story.model((model) => {
      expect(update(model, Message.SucceededSavePreferences({ attempt: 1 }))).toEqual({ model });
      expect(model.save._tag).toBe("Saving");
      expect(model.maybePreferencesLoadError).toEqual(Option.some("invalid-data"));
    }),
    Story.Command.resolve(SavePreferences, Message.SucceededSavePreferences({ attempt: 2 })),
    Story.model((model) => {
      expect(model.savedPreferences).toEqual({ version: 1, language: "pt", theme: "dark" });
      expect(model.save._tag).toBe("Saved");
      expect(model.maybePreferencesLoadError).toEqual(Option.none());
    }),
  ));
