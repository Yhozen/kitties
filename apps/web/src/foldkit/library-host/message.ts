import { DevicePreferencesError } from "@kitties/device/DevicePreferences";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import * as Library from "../library/index.ts";
import { LibraryConnectionError } from "./LibraryConnection.ts";

export const Message = defineMessageUnion({
  ClickedSignIn: {},
  SucceededConnectLibrary: { attempt: Schema.Int, scope: Library.LibraryClientScope },
  FailedConnectLibrary: { attempt: Schema.Int, reason: LibraryConnectionError.fields.reason },
  SelectedLanguage: { value: Schema.String },
  SelectedTheme: { value: Schema.String },
  SubmittedPreferences: {},
  SucceededSavePreferences: { attempt: Schema.Int },
  FailedSavePreferences: { attempt: Schema.Int, reason: DevicePreferencesError.fields.reason },
  GotLibraryMessage: { message: Library.Message },
});

export type Message = typeof Message.Type;
