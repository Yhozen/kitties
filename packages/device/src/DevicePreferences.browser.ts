import { Context, Effect, Layer, Option, Schema } from "effect";
import {
  DevicePreferences,
  DevicePreferencesError,
  MAX_PREFERENCES_BYTES,
  Preferences,
  decodePreferences,
} from "./DevicePreferences.ts";

export const BROWSER_PREFERENCES_KEY = "kitties.device-preferences.v1";

// This port grants access to exactly one preference record, never arbitrary keys.
export class BrowserPreferencesStorage extends Context.Service<
  BrowserPreferencesStorage,
  {
    readonly readPreferences: () => string | null;
    readonly writePreferences: (text: string) => void;
  }
>()("@kitties/device/BrowserPreferencesStorage") {
  static readonly layer = Layer.succeed(BrowserPreferencesStorage, {
    readPreferences: () => globalThis.localStorage.getItem(BROWSER_PREFERENCES_KEY),
    writePreferences: (text) => globalThis.localStorage.setItem(BROWSER_PREFERENCES_KEY, text),
  });
}

export const layerBrowserFromStorage = Layer.effect(
  DevicePreferences,
  Effect.gen(function* () {
    const storage = yield* BrowserPreferencesStorage;

    const load = Effect.gen(function* () {
      const text = yield* Effect.try({
        try: storage.readPreferences,
        catch: () => new DevicePreferencesError({ operation: "load", reason: "unavailable" }),
      });

      if (text === null) return Option.none<Preferences>();

      if (
        text.length > MAX_PREFERENCES_BYTES ||
        new TextEncoder().encode(text).byteLength > MAX_PREFERENCES_BYTES
      ) {
        return yield* new DevicePreferencesError({ operation: "load", reason: "invalid-data" });
      }

      const value = yield* Effect.try({
        try: () => JSON.parse(text),
        catch: () => new DevicePreferencesError({ operation: "load", reason: "invalid-data" }),
      });

      const preferences = yield* decodePreferences(value).pipe(
        Effect.mapError(
          () => new DevicePreferencesError({ operation: "load", reason: "invalid-data" }),
        ),
      );

      return Option.some(preferences);
    });

    const save = Effect.fn("DevicePreferences.save")(function* (preferences: Preferences) {
      const validated = yield* decodePreferences(preferences).pipe(
        Effect.mapError(
          () => new DevicePreferencesError({ operation: "save", reason: "invalid-data" }),
        ),
      );

      const text = Schema.encodeSync(Schema.fromJsonString(Preferences))(validated);
      yield* Effect.try({
        try: () => storage.writePreferences(text),
        catch: () => new DevicePreferencesError({ operation: "save", reason: "unavailable" }),
      });
    });

    return DevicePreferences.of({ load, save });
  }),
);

export const layerBrowser = layerBrowserFromStorage.pipe(
  Layer.provide(BrowserPreferencesStorage.layer),
);
