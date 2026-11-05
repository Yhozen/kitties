import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { Effect, Layer, Option, Schema, flow } from "effect";
import { NativeAccessError } from "./NativeAccessAuthentication.ts";
import { NativeAccessPort, NativeHttpPort, layerNativeAccess } from "./NativeAccess.native.ts";

const NativeFailure = Schema.Struct({ reason: NativeAccessError.fields.reason });

const failure = flow(
  Schema.decodeUnknownOption(NativeFailure),
  Option.match({
    onNone: () => new NativeAccessError({ reason: "Unavailable" }),
    onSome: ({ reason }) => new NativeAccessError({ reason }),
  }),
);

export const layerTauriNativeAccess = layerNativeAccess.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(NativeAccessPort, {
        configuration: Effect.tryPromise({
          try: () => invoke<unknown>("native_access_configuration"),
          catch: failure,
        }),
        begin: Effect.tryPromise({
          try: () => invoke<unknown>("begin_native_authentication"),
          catch: failure,
        }),
        finish: (attemptId) =>
          Effect.tryPromise({
            try: () => invoke<unknown>("finish_native_authentication", { attemptId }),
            catch: failure,
          }),
        cancel: (attemptId) =>
          Effect.tryPromise({
            try: () => invoke<unknown>("cancel_native_authentication", { attemptId }),
            catch: failure,
          }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Null)),
            Effect.mapError(() => new NativeAccessError({ reason: "Unavailable" })),
            Effect.asVoid,
          ),
      }),
      Layer.succeed(NativeHttpPort, { send: (url, options) => fetch(url, options) }),
    ),
  ),
);
