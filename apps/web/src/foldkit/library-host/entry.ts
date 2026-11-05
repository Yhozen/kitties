import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { layerBrowser } from "@kitties/device/DevicePreferences.browser";
import { layerTauri } from "@kitties/device/DevicePreferences.tauri";
import { layerTauriNativeAccess } from "@kitties/device/NativeAccess.tauri";
import { NativeAccessAuthentication } from "@kitties/device/NativeAccessAuthentication";
import { isTauri } from "@kitties/device/NativeRuntime";
import { Effect, Layer, Option } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { Runtime } from "foldkit";
import {
  LibraryConnection,
  LibraryConnectionError,
  LibraryConnectionTransport,
} from "./LibraryConnection.ts";
import { Flags, Model, init } from "./model.ts";
import { Message } from "./message.ts";
import { update } from "./update.ts";
import { view } from "./view.ts";
import { subscriptions } from "./subscription.ts";
import { copy } from "./copy.ts";
import { legacyPreferences, loadInitialPreferences } from "./preferences.ts";
import "./library.css";

const native = isTauri();

const browserTransport = LibraryConnectionTransport.layerHttp(
  { origin: location.origin, allowLoopback: import.meta.env.DEV },
  Effect.void,
).pipe(
  Layer.provide(
    FetchHttpClient.layer.pipe(
      Layer.provide(
        Layer.succeed(FetchHttpClient.RequestInit, {
          credentials: "same-origin",
          redirect: "manual",
          cache: "no-store",
        }),
      ),
    ),
  ),
);

const nativeTransport = Layer.unwrap(
  Effect.gen(function* () {
    const authentication = yield* NativeAccessAuthentication;

    return LibraryConnectionTransport.layerHttp(
      { origin: authentication.configuration.applicationUrl, allowLoopback: false },
      authentication.authenticate.pipe(
        Effect.mapError(
          (error) =>
            new LibraryConnectionError({
              reason: error.reason === "Denied" ? "Denied" : "Unavailable",
            }),
        ),
      ),
    );
  }),
).pipe(
  Layer.provide(layerTauriNativeAccess),
  Layer.catch(() => LibraryConnectionTransport.unavailable),
);

const resources = Layer.mergeAll(
  native ? layerTauri : layerBrowser,
  LibraryConnection.layer.pipe(
    Layer.provide(native ? nativeTransport : browserTransport),
    Layer.provide(BrowserCrypto.layerSecureRandom),
  ),
);

const flags = Effect.gen(function* () {
  const defaults = yield* Effect.try({
    try: () =>
      legacyPreferences(
        native ? null : localStorage.getItem("kitties.lang"),
        native ? null : localStorage.getItem("kitties.ui.theme"),
        navigator.language,
      ),
    catch: () => legacyPreferences(null, null, navigator.language),
  }).pipe(Effect.catch(Effect.succeed));

  const initial = yield* loadInitialPreferences(defaults);

  return Flags.make({
    ...initial,
    platform: native ? "native" : "browser",
    maybeBrowserSignInHref: native
      ? Option.none()
      : Option.some(new URL("/library.html", location.origin).href),
  });
});

const application = Runtime.makeApplication({
  Model,
  Flags,
  init,
  update,
  view: (model, h) => ({
    title: `${copy(model.preferences.language).title} · Kitties`,
    lang: model.preferences.language,
    body: view(model, h),
  }),
  subscriptions,
  resources,
  container: document.getElementById("library-root"),
  devTools: import.meta.env.DEV ? { Message, mode: "Inspect" } : false,
});

Runtime.run(application, { flags });
