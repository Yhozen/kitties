import { Effect, Layer, Option, Ref, Schema } from "effect";
import {
  DevicePreferences,
  DevicePreferencesError,
  Preferences,
  decodePreferences,
} from "./DevicePreferences.ts";

export const layerMemory = (initial: Option.Option<Preferences> = Option.none()) =>
  Layer.effect(
    DevicePreferences,
    Effect.gen(function* () {
      const validated = yield* Option.match(initial, {
        onNone: (): Effect.Effect<Option.Option<Preferences>, Schema.SchemaError> =>
          Effect.succeed(Option.none<Preferences>()),
        onSome: (value) =>
          decodePreferences(value).pipe(Effect.map((record) => Option.some({ ...record }))),
      }).pipe(
        Effect.mapError(
          () => new DevicePreferencesError({ operation: "load", reason: "invalid-data" }),
        ),
      );

      const stored = yield* Ref.make(validated);

      const save = Effect.fn("DevicePreferences.save")(function* (preferences: Preferences) {
        const value = yield* decodePreferences(preferences).pipe(
          Effect.mapError(
            () => new DevicePreferencesError({ operation: "save", reason: "invalid-data" }),
          ),
        );

        yield* Ref.set(
          stored,
          Option.some({ version: 1, language: value.language, theme: value.theme }),
        );
      });

      const load = Ref.get(stored).pipe(Effect.map(Option.map((value) => ({ ...value }))));

      return DevicePreferences.of({ load, save });
    }),
  );
