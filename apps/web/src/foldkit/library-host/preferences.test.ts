import { it } from "@effect/vitest";
import { DevicePreferences, DevicePreferencesError } from "@kitties/device/DevicePreferences";
import { layerMemory } from "@kitties/device/DevicePreferences.test-layer";
import { Effect, Layer, Option, Result } from "effect";
import { expect } from "vite-plus/test";
import { legacyPreferences, loadInitialPreferences, savePreferenceChange } from "./preferences.ts";

it.effect(
  "partial legacy preferences and locale remain unsaved until an explicit full-record save",
  () =>
    Effect.gen(function* () {
      const defaults = legacyPreferences(null, '{"mode":"light"}', "pt-BR");
      const initial = yield* loadInitialPreferences(defaults);
      const preferences = yield* DevicePreferences;

      expect(initial.preferences).toEqual({ version: 1, language: "pt", theme: "light" });
      expect(initial.maybePreferencesLoadError).toEqual(Option.none());
      expect(yield* preferences.load).toEqual(Option.none());
    }).pipe(Effect.provide(layerMemory())),
);

it.effect("legacy shell field changes preserve the shared acknowledged language and theme", () =>
  Effect.gen(function* () {
    const defaults = legacyPreferences("en", '{"mode":"dark"}', "en");
    const storage = yield* DevicePreferences;

    yield* savePreferenceChange(defaults, { theme: "light" });
    expect(yield* storage.load).toEqual(
      Option.some({ version: 1, language: "pt", theme: "light" }),
    );

    yield* savePreferenceChange(defaults, { language: "es" });
    expect(yield* storage.load).toEqual(
      Option.some({ version: 1, language: "es", theme: "light" }),
    );
  }).pipe(
    Effect.provide(layerMemory(Option.some({ version: 1, language: "pt", theme: "system" }))),
  ),
);

it.effect("a partial preference change refuses an unreadable record without overwriting it", () =>
  Effect.gen(function* () {
    const result = yield* savePreferenceChange(legacyPreferences(null, null, "en"), {
      theme: "light",
    }).pipe(Effect.result);

    expect(result).toEqual(
      Result.fail(new DevicePreferencesError({ operation: "load", reason: "invalid-data" })),
    );
  }).pipe(
    Effect.provide(
      Layer.succeed(DevicePreferences, {
        load: Effect.fail(
          new DevicePreferencesError({ operation: "load", reason: "invalid-data" }),
        ),
        save: () => Effect.die("partial changes must not overwrite unreadable preferences"),
      }),
    ),
  ),
);

it.effect("the acknowledged device record wins over legacy hints and navigator defaults", () =>
  Effect.gen(function* () {
    const initial = yield* loadInitialPreferences(
      legacyPreferences("es", '{"mode":"light"}', "pt"),
    );

    expect(initial.preferences).toEqual({ version: 1, language: "en", theme: "system" });
    expect(initial.maybePreferencesLoadError).toEqual(Option.none());
  }).pipe(
    Effect.provide(layerMemory(Option.some({ version: 1, language: "en", theme: "system" }))),
  ),
);

it.effect(
  "corrupt stored preferences produce a visible error without saving replacement defaults",
  () =>
    Effect.gen(function* () {
      const initial = yield* loadInitialPreferences(legacyPreferences("es", "bad json", "en"));

      expect(initial.preferences).toEqual({ version: 1, language: "es", theme: "dark" });
      expect(initial.maybePreferencesLoadError).toEqual(Option.some("invalid-data"));
    }).pipe(
      Effect.provide(
        Layer.succeed(DevicePreferences, {
          load: Effect.fail(
            new DevicePreferencesError({ operation: "load", reason: "invalid-data" }),
          ),
          save: () => Effect.die("bootstrap must not write preferences"),
        }),
      ),
    ),
);
