import { Option } from "effect";
import { Scene } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { expect, test } from "vite-plus/test";
import { LibraryClient } from "./client.ts";
import { ReadSkillDetail, ReauthenticateLibrary } from "./command.ts";
import {
  FixtureFailure,
  catalogue,
  commandId,
  first,
  key,
  owner,
  proposed,
  ready,
  receipt,
} from "./fixtures.ts";
import { Message } from "./message.ts";
import { Catalogue, Detail } from "./model.ts";
import { update } from "./update.ts";
import { view } from "./view.ts";

test("a failed detail watch announces its error even when the last detail was null, then reconnect retains its source barrier", () => {
  const missing = modifyFields(ready, {
    catalogue: () => Catalogue.Success({ data: catalogue }),
    maybeSelected: () => Option.some(first),
    detail: () => Detail.Success({ data: null }),
    detailGeneration: () => 1,
    maybeDetailBarrier: () => Option.some(receipt),
  });

  Scene.scene(
    { update, view },
    Scene.given(missing),
    Scene.Subscription.emit(
      Message.FailedDetailWatch({ key, generation: 1, problem: "Unavailable" }),
    ),
    Scene.expect(Scene.role("alert")).toContainText("Instructions could not be confirmed"),
    Scene.expect(Scene.role("button", { name: "Accept" })).toBeAbsent(),
    Scene.expect(Scene.role("button", { name: "Remove" })).toBeAbsent(),
    Scene.tap(({ html }) =>
      expect(Scene.textContent(html)).toContain("This skill is no longer available."),
    ),
    Scene.click(Scene.role("button", { name: "Reconnect" })),
    Scene.Command.expectExact(
      ReadSkillDetail({ key, generation: 2, maybeAtLeast: Option.some(receipt) }),
    ),
    Scene.Command.resolve(
      ReadSkillDetail,
      Message.SucceededReadSkillDetail({ key, generation: 2, state: proposed }),
    ),
    Scene.Subscription.emit(Message.UpdatedCatalogue({ generation: 1, state: catalogue })),
    Scene.expect(Scene.role("alert")).toBeAbsent(),
    Scene.expect(Scene.role("button", { name: "Accept" })).toBeEnabled(),
  );
});

test("an accessible proposal form preserves its draft on unknown outcome and confirms only after the retained request succeeds", () =>
  Scene.scene(
    { update, view },
    Scene.given(ready),
    Scene.type(Scene.label("Name"), "Welcome"),
    Scene.type(Scene.label("Instructions"), "Say hello"),
    Scene.click(Scene.role("button", { name: "Propose skill" })),
    Scene.expect(Scene.role("status")).toContainText("Sending request"),
    Scene.expect(Scene.role("button", { name: "Propose skill" })).toBeDisabled(),
    Scene.Command.resolve(
      LibraryClient.ProposeSkill,
      LibraryClient.Message.FailedProposeSkill({ commandId, failure: FixtureFailure.Unknown() }),
    ),
    Scene.expect(Scene.label("Name")).toHaveValue("Welcome"),
    Scene.expect(Scene.role("status")).toContainText("result is unknown"),
    Scene.click(Scene.role("button", { name: "Retry same request" })),
    Scene.Command.expectExact(
      LibraryClient.ProposeSkill({
        target: owner,
        input: { name: "Welcome", body: "Say hello" },
        commandId,
      }),
    ),
    Scene.Command.resolve(
      LibraryClient.ProposeSkill,
      LibraryClient.Message.SucceededProposeSkill({
        commandId,
        receipt,
        reply: { skillId: first, proposalRevision: 2 },
      }),
    ),
    Scene.Command.expectExact(
      ReadSkillDetail({ key, generation: 1, maybeAtLeast: Option.some(receipt) }),
    ),
    Scene.Command.resolve(
      ReadSkillDetail,
      Message.SucceededReadSkillDetail({ key, generation: 1, state: proposed }),
    ),
    Scene.Subscription.emit(Message.UpdatedCatalogue({ generation: 0, state: catalogue })),
    Scene.expect(Scene.role("button", { name: "Accept" })).toBeEnabled(),
    Scene.tap(({ html }) => expect(Scene.textContent(html)).toContain("Say hello")),
  ));

test("review, accept and remove render server-confirmed lifecycle states with disabled controls between receipts and detail", () => {
  const loaded = modifyFields(ready, { catalogue: () => Catalogue.Success({ data: catalogue }) });
  const accepted = { ...proposed, status: "accepted", detailRevision: 3 } as const;

  Scene.scene(
    { update, view },
    Scene.given(loaded),
    Scene.click(Scene.role("button", { name: "Review · Welcome" })),
    Scene.Command.resolve(
      ReadSkillDetail,
      Message.SucceededReadSkillDetail({ key, generation: 1, state: proposed }),
    ),
    Scene.click(Scene.role("button", { name: "Accept" })),
    Scene.expect(Scene.role("button", { name: "Accept" })).toBeDisabled(),
    Scene.Command.resolve(
      LibraryClient.AcceptSkill,
      LibraryClient.Message.SucceededAcceptSkill({
        commandId,
        receipt: { stream: "Library/owner", version: 3 },
        reply: undefined,
      }),
    ),
    Scene.Command.resolve(
      ReadSkillDetail,
      Message.SucceededReadSkillDetail({ key, generation: 2, state: accepted }),
    ),
    Scene.Subscription.emit(
      Message.UpdatedCatalogue({
        generation: 0,
        state: {
          ...catalogue,
          catalogueRevision: 3,
          active: [{ ...catalogue.active[0], status: "accepted", detailRevision: 3 }],
        },
      }),
    ),
    Scene.expect(Scene.role("button", { name: "Accept" })).toBeAbsent(),
    Scene.expect(Scene.role("button", { name: "Remove" })).toBeEnabled(),
    Scene.click(Scene.role("button", { name: "Remove" })),
    Scene.Command.resolve(
      LibraryClient.RemoveSkill,
      LibraryClient.Message.FailedRemoveSkill({
        commandId: "library:7:fixture:1",
        failure: FixtureFailure.Unknown(),
      }),
    ),
    Scene.expect(Scene.role("status")).toContainText("result is unknown"),
    Scene.tap(({ html }) => {
      expect(Scene.textContent(html)).toContain("Accepted");
      expect(Scene.textContent(html)).not.toContain("Removed");
    }),
  );
});

test("expiry and changed authority announce the failure and prevent further edits from being submitted", () =>
  Scene.scene(
    { update, view },
    Scene.given(ready),
    Scene.type(Scene.label("Name"), "Keep my work"),
    Scene.Subscription.emit(
      Message.FailedCatalogueWatch({ generation: 0, problem: "Authentication" }),
    ),
    Scene.expect(Scene.role("button", { name: "Propose skill" })).toBeDisabled(),
    Scene.Command.resolve(
      ReauthenticateLibrary,
      Message.FailedReauthenticateLibrary({ attempt: 1, reason: "ChangedAuthority" }),
    ),
    Scene.expect(Scene.role("button", { name: "Sign in again" })).toBeDisabled(),
    Scene.expect(Scene.label("Name")).toHaveValue("Keep my work"),
    Scene.tap(({ html }) => expect(Scene.textContent(html)).toContain("will not be replayed")),
  ));

test.each([
  ["es", "Nombre", "Instrucciones", "Proponer habilidad"],
  ["pt", "Nome", "Instruções", "Propor habilidade"],
] as const)(
  "%s keeps translated accessible labels and proposal validation",
  (language, name, instructions, submit) =>
    Scene.scene(
      { update, view },
      Scene.given(modifyFields(ready, { language: () => language })),
      Scene.type(Scene.label(name), "   "),
      Scene.type(Scene.label(instructions), "Keep"),
      Scene.click(Scene.role("button", { name: submit })),
      Scene.Command.expectNone(),
      Scene.expect(Scene.label(name)).toHaveAttr("aria-invalid", "true"),
      Scene.tap(({ html }) => {
        expect(Scene.getAllByRole("heading", { level: 1 })(html)).toHaveLength(1);
        expect(Scene.textContent(html)).not.toContain("Saved to your library.");
      }),
    ),
);

test("watch failure keeps visible data and draft while controls recover after an explicit reconnect", () =>
  Scene.scene(
    { update, view },
    Scene.given(modifyFields(ready, { catalogue: () => Catalogue.Success({ data: catalogue }) })),
    Scene.type(Scene.label("Name"), "Draft"),
    Scene.Subscription.emit(
      Message.FailedCatalogueWatch({ generation: 0, problem: "Unavailable" }),
    ),
    Scene.expect(Scene.role("button", { name: "Propose skill" })).toBeDisabled(),
    Scene.expect(Scene.role("status")).toContainText("Connection interrupted"),
    Scene.click(Scene.role("button", { name: "Reconnect" })),
    Scene.Subscription.emit(Message.UpdatedCatalogue({ generation: 1, state: catalogue })),
    Scene.expect(Scene.role("button", { name: "Propose skill" })).toBeEnabled(),
    Scene.tap(({ html }) => {
      expect(Option.isSome(Scene.label("Name")(html))).toBe(true);
      expect(Option.isSome(Scene.role("button", { name: "Review · Welcome" })(html))).toBe(true);
    }),
    Scene.expect(Scene.label("Name")).toHaveValue("Draft"),
  ));
