import { Button, Input, Textarea } from "@foldkit/ui";
import { FieldValidation } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { copy } from "./copy.ts";
import { Message } from "./message.ts";
import { Model } from "./model.ts";
import { canStartOperation } from "./selection.ts";

export const button = (
  label: string,
  message: Message,
  isDisabled: boolean,
  h: HtmlBuilder<Message>,
) =>
  Button.view(
    {
      onClick: message,
      isDisabled,
      toView: (attributes) =>
        h.button(
          [
            ...attributes.button,
            h.Class(
              "rounded-xl border border-current/20 px-4 py-2 text-sm font-medium transition hover:bg-current/10 focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-45",
            ),
          ],
          [label],
        ),
    },
    h,
  );

const nameField = (model: Model, h: HtmlBuilder<Message>) => {
  const text = copy(model.language);

  return Input.view(
    {
      id: `library-${model.scope.sessionId}-name`,
      value: model.name.value,
      onInput: (value) => Message.UpdatedName({ value }),
      isInvalid: FieldValidation.isInvalid(model.name),
      hasDescription: true,
      toView: (attributes) =>
        h.div(
          [h.Class("grid gap-2")],
          [
            h.label(attributes.label, [text.name]),
            h.input([
              ...attributes.input,
              h.Maxlength(80),
              h.Required(true),
              h.Class(
                "w-full rounded-xl border border-current/20 bg-transparent px-4 py-3 focus-visible:outline-2 focus-visible:outline-offset-2",
              ),
            ]),
            h.p([...attributes.description, h.Class("text-sm opacity-70")], [text.nameHelp]),
          ],
        ),
    },
    h,
  );
};

const bodyField = (model: Model, h: HtmlBuilder<Message>) => {
  const text = copy(model.language);

  return Textarea.view(
    {
      id: `library-${model.scope.sessionId}-body`,
      value: model.body.value,
      rows: 8,
      onInput: (value) => Message.UpdatedBody({ value }),
      isInvalid: FieldValidation.isInvalid(model.body),
      hasDescription: true,
      toView: (attributes) =>
        h.div(
          [h.Class("grid gap-2")],
          [
            h.label(attributes.label, [text.instructions]),
            h.textarea([
              ...attributes.textarea,
              h.Maxlength(64000),
              h.Class(
                "w-full resize-y rounded-xl border border-current/20 bg-transparent px-4 py-3 leading-relaxed focus-visible:outline-2 focus-visible:outline-offset-2",
              ),
            ]),
            h.p([...attributes.description, h.Class("text-sm opacity-70")], [text.bodyHelp]),
          ],
        ),
    },
    h,
  );
};

export const proposalForm = (model: Model, h: HtmlBuilder<Message>) =>
  h.form(
    [
      h.OnSubmit(Message.SubmittedProposal()),
      h.Class("grid gap-5 rounded-2xl border border-current/15 p-5 sm:p-7"),
      h.AriaLabel(copy(model.language).propose),
    ],
    [
      h.h2([h.Class("text-xl font-semibold")], [copy(model.language).propose]),
      nameField(model, h),
      bodyField(model, h),
      Button.view(
        {
          type: "submit",
          isDisabled: !canStartOperation(model),
          toView: (attributes) =>
            h.button(
              [
                ...attributes.button,
                h.Class(
                  "justify-self-start rounded-xl bg-violet-600 px-5 py-3 font-semibold text-white hover:bg-violet-500 focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-45",
                ),
              ],
              [copy(model.language).propose],
            ),
        },
        h,
      ),
    ],
  );
