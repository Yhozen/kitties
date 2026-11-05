import { DevicePreferencesError, type Preferences } from "@kitties/device/DevicePreferences";
import { layerBrowser } from "@kitties/device/DevicePreferences.browser";
import { Effect } from "effect";
import {
  legacyPreferences,
  loadInitialPreferences,
  savePreferenceChange,
} from "./foldkit/library-host/preferences.ts";

const defaults = Effect.try({
  try: () =>
    legacyPreferences(
      localStorage.getItem("kitties.lang"),
      localStorage.getItem("kitties.ui.theme"),
      navigator.language,
    ),
  catch: () => new DevicePreferencesError({ operation: "load", reason: "unavailable" }),
}).pipe(Effect.catch(() => Effect.succeed(legacyPreferences(null, null, navigator.language))));

// Preact's synchronous bootstrap and event handlers are runtime boundaries.
export const readBrowserPreferences = () =>
  Effect.runSync(
    defaults.pipe(
      Effect.flatMap(loadInitialPreferences),
      Effect.map((initial) => initial.preferences),
      Effect.provide(layerBrowser),
    ),
  );

export const changeBrowserPreferences = (
  change: Partial<Pick<Preferences, "language" | "theme">>,
) =>
  Effect.runPromise(
    defaults.pipe(
      Effect.flatMap((initial) => savePreferenceChange(initial, change)),
      Effect.provide(layerBrowser),
    ),
  );
