import { Option } from "effect";
import { Scene } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { expect, test } from "vite-plus/test";
import * as Library from "../library/index.ts";
import { ReauthenticateLibrary } from "../library/command.ts";
import { flags as leafFlags } from "../library/fixtures.ts";
import { ConnectLibrary, SavePreferences } from "./command.ts";
import { Message } from "./message.ts";
import { Flags, init } from "./model.ts";
import { update } from "./update.ts";
import { view } from "./view.ts";

const flags = Flags.make({
  preferences: { version: 1, language: "en", theme: "system" },
  platform: "browser",
  maybeBrowserSignInHref: Option.some("https://kitties.example/library.html"),
  maybePreferencesLoadError: Option.none(),
});

const initial = init(flags).model;

const denied = update(
  initial,
  Message.FailedConnectLibrary({ attempt: 1, reason: "Denied" }),
).model;

test("leaf authentication denial exposes browser sign-in without remounting the original draft", () => {
  const connected = update(
    initial,
    Message.SucceededConnectLibrary({ attempt: 1, scope: leafFlags.scope }),
  ).model;

  Scene.scene(
    { update, view },
    Scene.given(connected),
    Scene.type(Scene.label("Name"), "Keep original work"),
    Scene.Subscription.emit(
      Message.GotLibraryMessage({
        message: Library.Message.FailedCatalogueWatch({ generation: 0, problem: "Authentication" }),
      }),
    ),
    Scene.Command.resolve(
      ReauthenticateLibrary,
      Library.Message.FailedReauthenticateLibrary({ attempt: 1, reason: "Denied" }),
    ),
    Scene.expect(Scene.role("link", { name: "Sign in in a new tab" })).toHaveAttr(
      "href",
      "https://kitties.example/library.html",
    ),
    Scene.expect(Scene.label("Name")).toHaveValue("Keep original work"),
    Scene.tap(({ html }) => expect(Scene.textContent(html)).toContain("Sign in in a new tab")),
  );
});

test("browser denial offers safe separate-tab sign-in and mounts the leaf after explicit connection succeeds", () =>
  Scene.scene(
    { update, view },
    Scene.given(denied),
    Scene.expect(Scene.role("link", { name: "Return to Kitties" })).toHaveAttr("href", "/"),
    Scene.expect(Scene.role("link", { name: "Sign in in a new tab" })).toHaveAttr(
      "target",
      "_blank",
    ),
    Scene.expect(Scene.role("link", { name: "Sign in in a new tab" })).toHaveAttr(
      "rel",
      "noopener noreferrer",
    ),
    Scene.click(Scene.role("button", { name: "Sign in" })),
    Scene.expect(Scene.role("button", { name: "Sign in" })).toBeDisabled(),
    Scene.Command.expectExact(ConnectLibrary({ interactive: true, attempt: 2 })),
    Scene.Command.resolve(
      ConnectLibrary,
      Message.SucceededConnectLibrary({ attempt: 2, scope: leafFlags.scope }),
    ),
    Scene.expect(Scene.label("Name")).toHaveValue(""),
    Scene.expect(Scene.role("link", { name: "Sign in in a new tab" })).toBeAbsent(),
    Scene.tap(({ html }) =>
      expect(Scene.getAllByRole("heading", { level: 1 })(html)).toHaveLength(1),
    ),
  ));

test("native shell has no browser navigation or browser authentication link", () =>
  Scene.scene(
    { update, view },
    Scene.given(modifyFields(denied, { platform: () => "native" })),
    Scene.expect(Scene.role("link", { name: "Return to Kitties" })).toBeAbsent(),
    Scene.expect(Scene.role("link", { name: "Sign in in a new tab" })).toBeAbsent(),
    Scene.expect(Scene.role("button", { name: "Sign in" })).toBeEnabled(),
    Scene.tap(({ html }) => expect(Scene.getAllByRole("link")(html)).toHaveLength(0)),
  ));

test("explicit preference save announces ACK or failure, disables duplicate submission and reports invalid loaded data", () =>
  Scene.scene(
    { update, view },
    Scene.given(
      modifyFields(initial, { maybePreferencesLoadError: () => Option.some("invalid-data") }),
    ),
    Scene.expect(Scene.role("alert")).toContainText("nothing was overwritten"),
    Scene.change(Scene.label("Appearance"), "dark"),
    Scene.Command.expectNone(),
    Scene.click(Scene.role("button", { name: "Save preferences" })),
    Scene.expect(Scene.role("button", { name: "Save preferences" })).toBeDisabled(),
    Scene.expect(Scene.label("Language")).toBeDisabled(),
    Scene.expect(Scene.role("status", { name: "Preference status" })).toContainText(
      "Saving preferences",
    ),
    Scene.Command.resolve(
      SavePreferences,
      Message.FailedSavePreferences({ attempt: 1, reason: "unavailable" }),
    ),
    Scene.expect(Scene.role("status", { name: "Preference status" })).toContainText(
      "could not be saved",
    ),
    Scene.expect(Scene.role("button", { name: "Save preferences" })).toBeEnabled(),
    Scene.click(Scene.role("button", { name: "Save preferences" })),
    Scene.Command.expectExact(
      SavePreferences({ preferences: { version: 1, language: "en", theme: "dark" }, attempt: 2 }),
    ),
    Scene.Command.resolve(SavePreferences, Message.SucceededSavePreferences({ attempt: 2 })),
    Scene.expect(Scene.role("status", { name: "Preference status" })).toHaveText(
      "Preferences saved on this device.",
    ),
    Scene.expect(Scene.role("alert")).toBeAbsent(),
    Scene.expect(Scene.role("main")).toHaveAttr("data-theme", "dark"),
    Scene.tap(({ html }) =>
      expect(Scene.textContent(html)).toContain("Preferences saved on this device."),
    ),
  ));

test.each([
  [
    "es",
    "Idioma",
    "Apariencia",
    "Guardar preferencias",
    "Preferencias guardadas en este dispositivo.",
  ],
  ["pt", "Idioma", "Aparência", "Salvar preferências", "Preferências salvas neste dispositivo."],
] as const)(
  "%s translates host controls, updates leaf labels and announces explicit save",
  (language, languageLabel, themeLabel, save, saved) => {
    const connected = update(
      initial,
      Message.SucceededConnectLibrary({ attempt: 1, scope: leafFlags.scope }),
    ).model;

    Scene.scene(
      { update, view },
      Scene.given(connected),
      Scene.type(Scene.label("Name"), "Keep my draft"),
      Scene.change(Scene.label("Language"), language),
      Scene.expect(Scene.label(languageLabel)).toHaveValue(language),
      Scene.expect(Scene.label(themeLabel)).toHaveValue("system"),
      Scene.expect(Scene.label(language === "es" ? "Nombre" : "Nome")).toHaveValue("Keep my draft"),
      Scene.click(Scene.role("button", { name: save })),
      Scene.Command.resolve(SavePreferences, Message.SucceededSavePreferences({ attempt: 1 })),
      Scene.expect(
        Scene.role("status", {
          name: language === "es" ? "Estado de las preferencias" : "Estado das preferências",
        }),
      ).toHaveText(saved),
      Scene.expect(Scene.role("main")).toHaveAttr("lang", language),
      Scene.tap(({ html }) => expect(Scene.textContent(html)).toContain(saved)),
    );
  },
);

test("changed authority stays visible and disables sign-in instead of replaying into a new session", () =>
  Scene.scene(
    { update, view },
    Scene.given(
      update(initial, Message.FailedConnectLibrary({ attempt: 1, reason: "ChangedAuthority" }))
        .model,
    ),
    Scene.expect(Scene.role("button", { name: "Sign in" })).toBeDisabled(),
    Scene.tap(({ html }) =>
      expect(Scene.textContent(html)).toContain("previous requests will not be replayed"),
    ),
  ));
