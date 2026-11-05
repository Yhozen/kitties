import { invoke } from "@tauri-apps/api/core";
import { Effect, Layer, Schema } from "effect";
import { DevicePreferencesError, Preferences } from "./DevicePreferences.ts";
import { NativePreferencesPort, layerNativeFromPort } from "./DevicePreferences.native.ts";

export const layerTauriPort = Layer.succeed(NativePreferencesPort, {
  readPreferences: Effect.tryPromise({
    try: () => invoke<unknown>("read_device_preferences"),
    catch: () => new DevicePreferencesError({ operation: "load", reason: "unavailable" }),
  }).pipe(
    Effect.flatMap((reply) =>
      Schema.decodeUnknownEffect(Schema.Json)(reply).pipe(
        Effect.mapError(
          () => new DevicePreferencesError({ operation: "load", reason: "invalid-data" }),
        ),
      ),
    ),
  ),
  writePreferences: (preferences: Preferences) =>
    Effect.tryPromise({
      try: () => invoke<unknown>("write_device_preferences", { preferences }),
      catch: () => new DevicePreferencesError({ operation: "save", reason: "unavailable" }),
    }).pipe(
      Effect.flatMap((reply) =>
        Schema.decodeUnknownEffect(Schema.Json)(reply).pipe(
          Effect.mapError(
            () => new DevicePreferencesError({ operation: "save", reason: "invalid-data" }),
          ),
        ),
      ),
    ),
});

export const layerTauri = layerNativeFromPort.pipe(Layer.provide(layerTauriPort));
