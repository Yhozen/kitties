import { Context, Effect, Layer, Option, Schema } from "effect";
import {
  DevicePreferences,
  DevicePreferencesError,
  Preferences,
  decodePreferences,
} from "./DevicePreferences.ts";

const NativeFailure = Schema.Struct({
  status: Schema.Literal("failed"),
  reason: Schema.Literals(["invalid-data", "unavailable"]),
});

export const NativeReadReply = Schema.Union([
  Schema.Struct({ status: Schema.Literal("absent") }),
  Schema.Struct({ status: Schema.Literal("found"), preferences: Preferences }),
  NativeFailure,
]);

export const NativeWriteReply = Schema.Union([
  Schema.Struct({ status: Schema.Literal("saved") }),
  NativeFailure,
]);

// Named IPC operations only. JSON is untrusted until decoded below.
export class NativePreferencesPort extends Context.Service<
  NativePreferencesPort,
  {
    readonly readPreferences: Effect.Effect<Schema.Json, DevicePreferencesError>;
    readonly writePreferences: (
      preferences: Preferences,
    ) => Effect.Effect<Schema.Json, DevicePreferencesError>;
  }
>()("@kitties/device/NativePreferencesPort") {}

export const layerNativeFromPort = Layer.effect(
  DevicePreferences,
  Effect.gen(function* () {
    const port = yield* NativePreferencesPort;

    const load = Effect.gen(function* () {
      const raw = yield* port.readPreferences;

      const reply = yield* Schema.decodeUnknownEffect(NativeReadReply, {
        onExcessProperty: "error",
      })(raw).pipe(
        Effect.mapError(
          () => new DevicePreferencesError({ operation: "load", reason: "invalid-data" }),
        ),
      );

      switch (reply.status) {
        case "absent":
          return Option.none<Preferences>();
        case "found":
          return Option.some(reply.preferences);
        case "failed":
          return yield* new DevicePreferencesError({ operation: "load", reason: reply.reason });
      }
    }).pipe(
      Effect.timeout("5 seconds"),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(new DevicePreferencesError({ operation: "load", reason: "timeout" })),
      ),
    );

    const save = Effect.fn("DevicePreferences.save")(
      function* (preferences: Preferences) {
        const validated = yield* decodePreferences(preferences).pipe(
          Effect.mapError(
            () => new DevicePreferencesError({ operation: "save", reason: "invalid-data" }),
          ),
        );

        const raw = yield* port.writePreferences(validated);

        const reply = yield* Schema.decodeUnknownEffect(NativeWriteReply, {
          onExcessProperty: "error",
        })(raw).pipe(
          Effect.mapError(
            () => new DevicePreferencesError({ operation: "save", reason: "invalid-data" }),
          ),
        );

        if (reply.status === "failed") {
          return yield* new DevicePreferencesError({ operation: "save", reason: reply.reason });
        }
      },
      Effect.timeout("5 seconds"),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(new DevicePreferencesError({ operation: "save", reason: "timeout" })),
      ),
    );

    return DevicePreferences.of({ load, save });
  }),
);
