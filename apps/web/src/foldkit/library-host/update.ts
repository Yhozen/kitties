import { DevicePreferences, Language, Theme } from "@kitties/device/DevicePreferences";
import { Option, Schema } from "effect";
import { AsyncData, Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import * as Library from "../library/index.ts";
import { ConnectLibrary, SavePreferences } from "./command.ts";
import { LibraryConnection } from "./LibraryConnection.ts";
import { Message } from "./message.ts";
import { Model, PreferenceSave, Session } from "./model.ts";

export type HostServices = LibraryConnection | DevicePreferences | Library.LibraryServices;

type UpdateReturn = Update.Return<Model, Message, HostServices>;

const foldLibrary = Update.foldChild({
  update: Library.update,
  read: (model: Model) => model.maybeLibrary,
  write: (model, library) => modifyFields(model, { maybeLibrary: () => Option.some(library) }),
  toParentMessage: (message) => Message.GotLibraryMessage({ message }),
});

const reflectLanguage = Update.foldChild({
  update: (library: Library.Model, language: typeof Language.Type) => ({
    model: modifyFields(library, { language: () => language }),
  }),
  read: (model: Model) => model.maybeLibrary,
  write: (model, library) => modifyFields(model, { maybeLibrary: () => Option.some(library) }),
  toParentMessage: (message: Library.Message) => Message.GotLibraryMessage({ message }),
});

const selectLanguage = (model: Model, value: string): UpdateReturn =>
  Option.match(Schema.decodeUnknownOption(Language)(value), {
    onNone: () => ({ model }),
    onSome: (language) =>
      PreferenceSave.guards.Saving(model.save)
        ? { model }
        : reflectLanguage(
            modifyFields(model, {
              preferences: (preferences) => modifyFields(preferences, { language: () => language }),
              save: () => PreferenceSave.Idle(),
            }),
            language,
          ),
  });

const connect = (model: Model): UpdateReturn => {
  if (
    Option.isSome(model.maybeLibrary) ||
    AsyncData.isPending(model.session) ||
    (AsyncData.isFailure(model.session) && model.session.error === "ChangedAuthority") ||
    model.connectionAttempt === Number.MAX_SAFE_INTEGER
  ) {
    return { model };
  }

  const attempt = model.connectionAttempt + 1;

  return {
    model: modifyFields(model, {
      session: () => Session.Loading(),
      connectionAttempt: () => attempt,
    }),
    commands: [ConnectLibrary({ interactive: true, attempt })],
  };
};

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ClickedSignIn: () => connect(model),
    SucceededConnectLibrary: ({ attempt, scope }) => {
      if (
        attempt !== model.connectionAttempt ||
        !AsyncData.isPending(model.session) ||
        Option.isSome(model.maybeLibrary)
      ) {
        return { model };
      }

      return Update.foldChildInit<Model, Message, Library.Model, Library.Message>(
        Library.init({ scope, language: model.preferences.language }),
        {
          toParentModel: (library) =>
            modifyFields(model, {
              session: () => Session.Success({ data: scope }),
              maybeLibrary: () => Option.some(library),
            }),
          toParentMessage: (message) => Message.GotLibraryMessage({ message }),
        },
      );
    },
    FailedConnectLibrary: ({ attempt, reason }) => ({
      model:
        attempt === model.connectionAttempt && AsyncData.isPending(model.session)
          ? modifyFields(model, { session: () => Session.Failure({ error: reason }) })
          : model,
    }),
    SelectedLanguage: ({ value }) => selectLanguage(model, value),
    SelectedTheme: ({ value }) =>
      Option.match(Schema.decodeUnknownOption(Theme)(value), {
        onNone: () => ({ model }),
        onSome: (theme) => ({
          model: PreferenceSave.guards.Saving(model.save)
            ? model
            : modifyFields(model, {
                preferences: (preferences) => modifyFields(preferences, { theme: () => theme }),
                save: () => PreferenceSave.Idle(),
              }),
        }),
      }),
    SubmittedPreferences: () => {
      if (
        PreferenceSave.guards.Saving(model.save) ||
        model.saveAttempt === Number.MAX_SAFE_INTEGER
      ) {
        return { model };
      }

      const attempt = model.saveAttempt + 1;

      return {
        model: modifyFields(model, {
          save: () => PreferenceSave.Saving(),
          saveAttempt: () => attempt,
        }),
        commands: [SavePreferences({ preferences: model.preferences, attempt })],
      };
    },
    SucceededSavePreferences: ({ attempt }) => ({
      model:
        attempt === model.saveAttempt && PreferenceSave.guards.Saving(model.save)
          ? modifyFields(model, {
              save: () => PreferenceSave.Saved(),
              savedPreferences: () => model.preferences,
              maybePreferencesLoadError: () => Option.none(),
            })
          : model,
    }),
    FailedSavePreferences: ({ attempt, reason }) => ({
      model:
        attempt === model.saveAttempt && PreferenceSave.guards.Saving(model.save)
          ? modifyFields(model, { save: () => PreferenceSave.Failed({ reason }) })
          : model,
    }),
    GotLibraryMessage: ({ message }) => foldLibrary(model, message),
  });
