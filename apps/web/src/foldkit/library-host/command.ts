import { DevicePreferences, Preferences } from "@kitties/device/DevicePreferences";
import { Cause, Effect, Schema } from "effect";
import { Command } from "foldkit";
import { LibraryConnection } from "./LibraryConnection.ts";
import { Message } from "./message.ts";

export const ConnectLibrary = Command.define("ConnectLibrary", {
  args: { interactive: Schema.Boolean, attempt: Schema.Int },
  messages: [Message.SucceededConnectLibrary, Message.FailedConnectLibrary],
  execute: ({ interactive, attempt }) =>
    Effect.gen(function* () {
      const connection = yield* LibraryConnection;
      const scope = yield* connection.connect(interactive);

      return Message.SucceededConnectLibrary({ attempt, scope });
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(Message.FailedConnectLibrary({ attempt, reason: error.reason })),
      ),
      Effect.catchCauseIf(Cause.hasDies, () =>
        Effect.succeed(Message.FailedConnectLibrary({ attempt, reason: "Unavailable" })),
      ),
    ),
});

export const SavePreferences = Command.define("SavePreferences", {
  args: { preferences: Preferences, attempt: Schema.Int },
  messages: [Message.SucceededSavePreferences, Message.FailedSavePreferences],
  execute: ({ preferences, attempt }) =>
    Effect.gen(function* () {
      const device = yield* DevicePreferences;

      yield* device.save(preferences);

      return Message.SucceededSavePreferences({ attempt });
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(Message.FailedSavePreferences({ attempt, reason: error.reason })),
      ),
      Effect.catchCauseIf(Cause.hasDies, () =>
        Effect.succeed(Message.FailedSavePreferences({ attempt, reason: "unavailable" })),
      ),
    ),
});
