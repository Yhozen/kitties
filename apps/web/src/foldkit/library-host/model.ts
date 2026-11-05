import { DevicePreferencesError, Preferences } from "@kitties/device/DevicePreferences";
import { Option, Schema } from "effect";
import { AsyncData } from "foldkit";
import { defineTaggedUnion } from "foldkit/schema";
import * as Library from "../library/index.ts";
import { ConnectLibrary } from "./command.ts";
import { LibraryConnectionError } from "./LibraryConnection.ts";

export const Flags = Schema.Struct({
  preferences: Preferences,
  platform: Schema.Literals(["browser", "native"]),
  maybeBrowserSignInHref: Schema.Option(Schema.String),
  maybePreferencesLoadError: Schema.Option(DevicePreferencesError.fields.reason),
});

export type Flags = typeof Flags.Type;

export const Session = AsyncData.Schema(
  Library.LibraryClientScope,
  LibraryConnectionError.fields.reason,
);

export const PreferenceSave = defineTaggedUnion({
  Idle: {},
  Saving: {},
  Saved: {},
  Failed: { reason: DevicePreferencesError.fields.reason },
});

export const Model = Schema.Struct({
  platform: Flags.fields.platform,
  maybeBrowserSignInHref: Flags.fields.maybeBrowserSignInHref,
  maybePreferencesLoadError: Flags.fields.maybePreferencesLoadError,
  preferences: Preferences,
  savedPreferences: Preferences,
  save: PreferenceSave,
  saveAttempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  session: Session.schema,
  connectionAttempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  maybeLibrary: Schema.Option(Library.Model),
});

export type Model = typeof Model.Type;

export const init = (flags: Flags) => ({
  model: Model.make({
    platform: flags.platform,
    maybeBrowserSignInHref: flags.maybeBrowserSignInHref,
    maybePreferencesLoadError: flags.maybePreferencesLoadError,
    preferences: flags.preferences,
    savedPreferences: flags.preferences,
    save: PreferenceSave.Idle(),
    saveAttempt: 0,
    session: Session.Loading(),
    connectionAttempt: 1,
    maybeLibrary: Option.none(),
  }),
  commands: [ConnectLibrary({ interactive: false, attempt: 1 })],
});
