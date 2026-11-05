import { Context, Effect, Schema } from "effect";

export const HttpsOrigin = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/),
  Schema.makeFilter((text) => {
    try {
      const url = new URL(text);

      return (
        url.protocol === "https:" &&
        url.origin === text &&
        url.username === "" &&
        url.password === ""
      );
    } catch {
      return false;
    }
  }),
);

export const NativeAccessConfiguration = Schema.Struct({
  applicationUrl: HttpsOrigin,
  issuer: HttpsOrigin,
});

export type NativeAccessConfiguration = typeof NativeAccessConfiguration.Type;

// Safe to report to the UI. Provider responses and IPC exceptions are never causes.
export class NativeAccessError extends Schema.TaggedError<
  NativeAccessError,
  { readonly brand: unique symbol }
>()("NativeAccessError", {
  reason: Schema.Literals(["Denied", "Unavailable", "Cancelled", "Configuration"]),
}) {}

export class NativeAccessAuthentication extends Context.Service<
  NativeAccessAuthentication,
  {
    readonly configuration: NativeAccessConfiguration;
    readonly authenticate: Effect.Effect<void, NativeAccessError>;
    readonly clear: Effect.Effect<void>;
  }
>()("@kitties/device/NativeAccessAuthentication") {}
