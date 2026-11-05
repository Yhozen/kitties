import { Context, Effect, Option, Schema } from "effect";

export const Language = Schema.Literals(["en", "es", "pt"]);
export const Theme = Schema.Literals(["system", "light", "dark"]);

export const Preferences = Schema.Struct({
  version: Schema.Literal(1),
  language: Language,
  theme: Theme,
});

export type Preferences = typeof Preferences.Type;

export const MAX_PREFERENCES_BYTES = 512;

export class DevicePreferencesError extends Schema.TaggedError<
  DevicePreferencesError,
  { readonly brand: unique symbol }
>()("DevicePreferencesError", {
  operation: Schema.Literals(["load", "save"]),
  reason: Schema.Literals(["invalid-data", "unavailable", "timeout"]),
}) {}

export class DevicePreferences extends Context.Service<
  DevicePreferences,
  {
    readonly load: Effect.Effect<Option.Option<Preferences>, DevicePreferencesError>;
    readonly save: (preferences: Preferences) => Effect.Effect<void, DevicePreferencesError>;
  }
>()("@kitties/device/DevicePreferences") {}

// Defaults are a caller decision; resolving absence never writes them to storage.
export const preferencesOrDefaults = (stored: Option.Option<Preferences>, defaults: Preferences) =>
  Option.getOrElse(stored, () => defaults);

export const decodePreferences = Schema.decodeUnknownEffect(Preferences, {
  onExcessProperty: "error",
});
