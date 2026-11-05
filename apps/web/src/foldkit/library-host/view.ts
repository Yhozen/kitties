import { Button, Select } from "@foldkit/ui";
import { Array, Match, Option, pipe } from "effect";
import { AsyncData, Route, Submodel } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { defineRouteUnion } from "foldkit/route";
import * as Library from "../library/index.ts";
import { Authentication } from "../library/model.ts";
import { copy } from "./copy.ts";
import { Message } from "./message.ts";
import { Model, PreferenceSave } from "./model.ts";

const libraryView = Submodel.defineView<Library.Model, Library.Message>(Library.view);

const BrowserRoute = defineRouteUnion({ Home: {} });
const homeRouter = pipe(Route.root, Route.mapTo(BrowserRoute.Home));

const languageSelect = (model: Model, h: HtmlBuilder<Message>) =>
  Select.view(
    {
      id: "library-host-language",
      value: model.preferences.language,
      isDisabled: PreferenceSave.guards.Saving(model.save),
      onChange: (value) => Message.SelectedLanguage({ value }),
      toView: (attributes) =>
        h.div(
          [h.Class("grid gap-2")],
          [
            h.label(attributes.label, [copy(model.preferences.language).language]),
            h.select(
              [...attributes.select, h.Class("library-host-select rounded-lg border p-2")],
              Array.map(
                [
                  { value: "en", label: "English" },
                  { value: "es", label: "Español" },
                  { value: "pt", label: "Português" },
                ],
                (option) =>
                  h.keyed("option")(option.value, [h.Value(option.value)], [option.label]),
              ),
            ),
          ],
        ),
    },
    h,
  );

const themeSelect = (model: Model, h: HtmlBuilder<Message>) => {
  const text = copy(model.preferences.language);

  return Select.view(
    {
      id: "library-host-theme",
      value: model.preferences.theme,
      isDisabled: PreferenceSave.guards.Saving(model.save),
      onChange: (value) => Message.SelectedTheme({ value }),
      toView: (attributes) =>
        h.div(
          [h.Class("grid gap-2")],
          [
            h.label(attributes.label, [text.theme]),
            h.select(
              [...attributes.select, h.Class("library-host-select rounded-lg border p-2")],
              Array.map(
                [
                  { value: "system", label: text.system },
                  { value: "light", label: text.light },
                  { value: "dark", label: text.dark },
                ],
                (option) =>
                  h.keyed("option")(option.value, [h.Value(option.value)], [option.label]),
              ),
            ),
          ],
        ),
    },
    h,
  );
};

const preferencesView = (model: Model, h: HtmlBuilder<Message>) => {
  const text = copy(model.preferences.language);

  const status = PreferenceSave.match(model.save, {
    Idle: () =>
      model.preferences.language === model.savedPreferences.language &&
      model.preferences.theme === model.savedPreferences.theme
        ? text.preview
        : text.unsaved,
    Saving: () => text.saving,
    Saved: () => text.saved,
    Failed: ({ reason }) =>
      Match.value(reason).pipe(
        Match.when("invalid-data", () => text.saveInvalid),
        Match.when("unavailable", () => text.saveUnavailable),
        Match.when("timeout", () => text.saveTimeout),
        Match.exhaustive,
      ),
  });

  return h.section(
    [h.AriaLabel(text.preferences), h.Class("grid gap-3")],
    [
      h.h2([h.Class("text-lg font-semibold")], [text.preferences]),
      Option.match(model.maybePreferencesLoadError, {
        onNone: () => h.empty,
        onSome: (reason) =>
          h.p(
            [h.Role("alert")],
            [
              Match.value(reason).pipe(
                Match.when("invalid-data", () => text.loadInvalid),
                Match.when("unavailable", () => text.loadUnavailable),
                Match.when("timeout", () => text.loadTimeout),
                Match.exhaustive,
              ),
            ],
          ),
      }),
      h.form(
        [h.OnSubmit(Message.SubmittedPreferences()), h.Class("flex flex-wrap items-end gap-4")],
        [
          languageSelect(model, h),
          themeSelect(model, h),
          Button.view(
            {
              type: "submit",
              isDisabled:
                PreferenceSave.guards.Saving(model.save) ||
                model.saveAttempt === Number.MAX_SAFE_INTEGER,
              toView: (attributes) =>
                h.button(
                  [
                    ...attributes.button,
                    h.Class("rounded-lg border px-4 py-2 disabled:opacity-45"),
                  ],
                  [text.save],
                ),
            },
            h,
          ),
        ],
      ),
      h.p([h.Role("status"), h.AriaLabel(text.preferenceStatus), h.AriaLive("polite")], [status]),
    ],
  );
};

const connectionView = (model: Model, h: HtmlBuilder<Message>) => {
  const text = copy(model.preferences.language);

  return h.section(
    [h.Class("mx-auto grid w-full max-w-6xl gap-4 p-4 sm:p-8")],
    [
      h.h1([h.Class("text-3xl font-semibold")], [text.title]),
      h.p(
        [h.Role("status"), h.AriaLive("polite")],
        [
          AsyncData.matchDataSplitEmpty(model.session, {
            onIdle: () => text.checking,
            onLoading: () => text.checking,
            onFailure: (reason) =>
              Match.value(reason).pipe(
                Match.when("Denied", () => text.denied),
                Match.when("Unavailable", () => text.unavailable),
                Match.when("NotReady", () => text.notReady),
                Match.when("ChangedAuthority", () => text.changed),
                Match.exhaustive,
              ),
            onData: () => text.checking,
          }),
        ],
      ),
      Button.view(
        {
          onClick: Message.ClickedSignIn(),
          isDisabled:
            AsyncData.isPending(model.session) ||
            model.connectionAttempt === Number.MAX_SAFE_INTEGER ||
            (AsyncData.isFailure(model.session) && model.session.error === "ChangedAuthority"),
          toView: (attributes) =>
            h.button(
              [
                ...attributes.button,
                h.Class("justify-self-start rounded-lg border px-4 py-2 disabled:opacity-45"),
              ],
              [text.signIn],
            ),
        },
        h,
      ),
    ],
  );
};

const browserSignIn = (model: Model, h: HtmlBuilder<Message>) => {
  const isDenied =
    (AsyncData.isFailure(model.session) && model.session.error === "Denied") ||
    Option.exists(
      model.maybeLibrary,
      (library) =>
        Authentication.guards.Failed(library.authentication) &&
        library.authentication.reason === "Denied",
    );

  return model.platform === "browser" && isDenied
    ? Option.match(model.maybeBrowserSignInHref, {
        onNone: () => h.empty,
        onSome: (href) =>
          h.a(
            [
              h.Href(href),
              h.Target("_blank"),
              h.Rel("noopener noreferrer"),
              h.Class("underline underline-offset-4"),
            ],
            [copy(model.preferences.language).signInTab],
          ),
      })
    : h.empty;
};

export const view = (model: Model, h: HtmlBuilder<Message>) =>
  h.main(
    [
      h.Lang(model.preferences.language),
      h.DataAttribute("theme", model.preferences.theme),
      h.Class("library-host min-h-screen"),
    ],
    [
      h.header(
        [h.Class("mx-auto grid w-full max-w-6xl gap-5 border-b border-current/15 p-4 sm:p-8")],
        [
          model.platform === "browser"
            ? h.nav(
                [h.AriaLabel(copy(model.preferences.language).navigation)],
                [
                  h.a(
                    [h.Href(homeRouter()), h.Class("underline underline-offset-4")],
                    [copy(model.preferences.language).home],
                  ),
                ],
              )
            : h.empty,
          preferencesView(model, h),
          browserSignIn(model, h),
        ],
      ),
      Option.match(model.maybeLibrary, {
        onNone: () => connectionView(model, h),
        onSome: (library) =>
          h.submodel({
            slotId: "library",
            view: libraryView,
            model: library,
            toParentMessage: (message) => Message.GotLibraryMessage({ message }),
          }),
      }),
    ],
  );
