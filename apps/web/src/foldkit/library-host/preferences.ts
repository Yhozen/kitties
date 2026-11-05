import { DevicePreferences, Language, Preferences, Theme } from "@kitties/device/DevicePreferences";
import { Effect, Option, Schema } from "effect";

const LegacyTheme = Schema.fromJsonString(Schema.Struct({ mode: Theme }));

/** Compatibility defaults are previews. Only an explicit Save writes a full record. */
export const legacyPreferences = (
  language: string | null,
  theme: string | null,
  locale: string,
): Preferences =>
  Preferences.make({
    version: 1,
    language: Option.getOrElse(Schema.decodeUnknownOption(Language)(language), () =>
      Option.getOrElse(
        Schema.decodeUnknownOption(Language)(locale.toLowerCase().slice(0, 2)),
        () => "en",
      ),
    ),
    theme: Option.match(Schema.decodeUnknownOption(LegacyTheme)(theme), {
      onNone: () => "dark",
      onSome: (saved) => saved.mode,
    }),
  });

export const loadInitialPreferences = Effect.fnUntraced(function* (defaults: Preferences) {
  const storage = yield* DevicePreferences;

  return yield* storage.load.pipe(
    Effect.match({
      onFailure: (error) => ({
        preferences: defaults,
        maybePreferencesLoadError: Option.some(error.reason),
      }),
      onSuccess: (stored) => ({
        preferences: Option.getOrElse(stored, () => defaults),
        maybePreferencesLoadError: Option.none(),
      }),
    }),
  );
});

/** The legacy shell changes one field; preserve the rest of the acknowledged record. */
export const savePreferenceChange = Effect.fnUntraced(function* (
  defaults: Preferences,
  change: Partial<Pick<Preferences, "language" | "theme">>,
) {
  const storage = yield* DevicePreferences;
  const stored = yield* storage.load;
  const preferences = { ...Option.getOrElse(stored, () => defaults), ...change };

  yield* storage.save(preferences);

  return preferences;
});
