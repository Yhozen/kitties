import type { SkillMetadata } from "@kitties/domain/Library/Skill";
import { Array, Match, Option } from "effect";
import { AsyncData } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { copy } from "./copy.ts";
import { Message } from "./message.ts";
import { Authentication, Model, Submission } from "./model.ts";
import { canStartOperation, confirmedDetail } from "./selection.ts";
import { button, proposalForm } from "./view.controls.ts";

const status = (model: Model, h: HtmlBuilder<Message>) => {
  const text = copy(model.language);

  const authentication = Authentication.match(model.authentication, {
    Ready: () => undefined,
    Reauthenticating: () => text.signingIn,
    Failed: ({ reason }) =>
      Match.value(reason).pipe(
        Match.when("ChangedAuthority", () => text.changed),
        Match.when("Denied", () => text.denied),
        Match.when("Unavailable", () => text.unavailable),
        Match.exhaustive,
      ),
  });

  const submission = Submission.match(model.submission, {
    Idle: () => undefined,
    Sending: () => text.sending,
    Unknown: () => text.unknown,
    Denied: () => text.expired,
    Confirming: () => text.confirming,
  });

  const notice = Option.map(
    model.maybeNotice,
    (value) =>
      ({
        Saved: text.saved,
        Rejected: text.rejected,
        InvalidDraft: text.invalid,
        CounterExhausted: text.counter,
      })[value],
  );

  return h.div(
    [h.Role("status"), h.AriaLive("polite"), h.Class("grid gap-2 text-sm")],
    [
      authentication ?? submission ?? Option.getOrElse(notice, () => text.connected),
      Match.value(model.catalogueWatch).pipe(
        Match.when("Starting", () => text.reconnecting),
        Match.when("Stopped", () =>
          Authentication.guards.Ready(model.authentication) ? text.offline : "",
        ),
        Match.when("Live", () => ""),
        Match.exhaustive,
      ),
    ],
  );
};

const connectionControls = (model: Model, h: HtmlBuilder<Message>) => {
  const text = copy(model.language);

  return h.div(
    [h.Class("flex flex-wrap items-center gap-3")],
    [
      Authentication.guards.Ready(model.authentication)
        ? button(text.reconnect, Message.ClickedReconnect(), model.catalogueWatch === "Starting", h)
        : button(
            text.signIn,
            Message.ClickedReauthenticate(),
            Authentication.guards.Reauthenticating(model.authentication) ||
              model.authentication.reason === "ChangedAuthority",
            h,
          ),
      Submission.guards.Unknown(model.submission)
        ? button(
            text.retry,
            Message.ClickedRetry(),
            !Authentication.guards.Ready(model.authentication) || model.catalogueWatch !== "Live",
            h,
          )
        : h.empty,
    ],
  );
};

const skillRow = (model: Model, skill: SkillMetadata, h: HtmlBuilder<Message>) =>
  h.keyed("li")(
    skill.id,
    [
      h.Class(
        "flex flex-wrap items-center justify-between gap-3 rounded-xl border border-current/15 p-4",
      ),
    ],
    [
      h.div(
        [h.Class("min-w-0 flex-1")],
        [
          h.h3([h.Class("break-words font-semibold")], [skill.name]),
          h.p(
            [h.Class("mt-1 text-sm opacity-65")],
            [
              skill.status === "accepted"
                ? copy(model.language).accepted
                : copy(model.language).proposed,
            ],
          ),
        ],
      ),
      button(
        `${copy(model.language).review} · ${skill.name}`,
        Message.ClickedReview({ skillId: skill.id }),
        !Authentication.guards.Ready(model.authentication),
        h,
      ),
    ],
  );

const catalogueView = (model: Model, h: HtmlBuilder<Message>) =>
  AsyncData.matchDataSplitEmpty(model.catalogue, {
    onIdle: () => h.p([], [copy(model.language).loading]),
    onLoading: () => h.p([], [copy(model.language).loading]),
    onFailure: (problem) =>
      h.p(
        [h.Role("alert")],
        [problem === "NotReady" ? copy(model.language).notReady : copy(model.language).offline],
      ),
    onData: (catalogue) =>
      Array.match(catalogue.active, {
        onEmpty: () => h.p([h.Class("py-6 opacity-70")], [copy(model.language).empty]),
        onNonEmpty: (skills) =>
          h.ul(
            [h.Class("grid gap-3")],
            Array.map(skills, (skill) => skillRow(model, skill, h)),
          ),
      }),
  });

const detailContent = (model: Model, h: HtmlBuilder<Message>) =>
  AsyncData.matchDataSplitEmpty(model.detail, {
    onIdle: () => h.p([], [copy(model.language).choose]),
    onLoading: () => h.p([], [copy(model.language).reading]),
    onFailure: () => h.empty,
    onData: (detail) =>
      detail === null
        ? h.p([], [copy(model.language).missing])
        : h.div(
            [h.Class("grid gap-4")],
            [
              h.h3([h.Class("break-words text-lg font-semibold")], [detail.name]),
              h.p([h.Class("text-sm opacity-65")], [copy(model.language)[detail.status]]),
              h.pre(
                [
                  h.Class(
                    "max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-current/10 p-4 font-sans leading-relaxed",
                  ),
                ],
                [detail.body],
              ),
              h.div(
                [h.Class("flex flex-wrap gap-3")],
                [
                  detail.status === "proposed"
                    ? button(
                        copy(model.language).accept,
                        Message.ClickedAccept(),
                        !canStartOperation(model) || Option.isNone(confirmedDetail(model)),
                        h,
                      )
                    : h.empty,
                  button(
                    copy(model.language).remove,
                    Message.ClickedRemove(),
                    detail.status === "removed" ||
                      !canStartOperation(model) ||
                      Option.isNone(confirmedDetail(model)),
                    h,
                  ),
                ],
              ),
            ],
          ),
  });

const detailView = (model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class("grid gap-4")],
    [
      AsyncData.hasError(model.detail)
        ? h.p([h.Role("alert")], [copy(model.language).detailError])
        : h.empty,
      detailContent(model, h),
    ],
  );

export const view = (model: Model, h: HtmlBuilder<Message>) =>
  h.section(
    [h.Lang(model.language), h.Class("mx-auto grid w-full max-w-6xl gap-7 p-4 sm:p-8")],
    [
      h.header(
        [h.Class("grid gap-4 border-b border-current/15 pb-6")],
        [
          h.h1(
            [h.Class("text-3xl font-semibold tracking-tight sm:text-4xl")],
            [copy(model.language).title],
          ),
          h.p(
            [h.Class("max-w-2xl leading-relaxed opacity-70")],
            [copy(model.language).description],
          ),
          status(model, h),
          connectionControls(model, h),
        ],
      ),
      h.div(
        [h.Class("grid items-start gap-7 lg:grid-cols-2")],
        [
          h.div(
            [h.Class("grid gap-7")],
            [
              h.section(
                [h.Class("grid gap-4"), h.AriaLabel(copy(model.language).skills)],
                [
                  h.h2([h.Class("text-xl font-semibold")], [copy(model.language).skills]),
                  catalogueView(model, h),
                ],
              ),
              proposalForm(model, h),
            ],
          ),
          h.section(
            [
              h.Class("grid gap-5 rounded-2xl border border-current/15 p-5 sm:p-7"),
              h.AriaLabel(copy(model.language).detail),
            ],
            [
              h.h2([h.Class("text-xl font-semibold")], [copy(model.language).detail]),
              detailView(model, h),
            ],
          ),
        ],
      ),
    ],
  );
