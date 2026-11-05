import { LibraryUnauthorized } from "@kitties/domain/LibrarySession.middleware";
import { SkillAlreadyAccepted } from "@kitties/domain/Library/Library.rejection";
import { skillDetailKey } from "@kitties/domain/Library/Skill.id";
import { Option } from "effect";
import { Story } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { expect, test } from "vite-plus/test";
import { LibraryClient } from "./client.ts";
import { ReadSkillDetail, ReauthenticateLibrary } from "./command.ts";
import {
  FixtureFailure,
  catalogue,
  commandId,
  first,
  flags,
  key,
  owner,
  proposed,
  ready,
  receipt,
  second,
} from "./fixtures.ts";
import { Message } from "./message.ts";
import { Catalogue, Detail } from "./model.ts";
import { subscriptions } from "./subscription.ts";
import { update } from "./update.ts";

const propose = LibraryClient.ProposeSkill({
  target: owner,
  input: { name: "Welcome", body: "Say hello" },
  commandId,
});

const read = ReadSkillDetail({ key, generation: 1, maybeAtLeast: Option.some(receipt) });

test("unknown proposal retries retain the complete epoch ID and original input without optimistic confirmation", () =>
  Story.story(
    update,
    Story.given(ready),
    Story.message(Message.UpdatedName({ value: "Welcome" })),
    Story.message(Message.UpdatedBody({ value: "Say hello" })),
    Story.message(Message.SubmittedProposal()),
    Story.Command.expectExact(propose),
    Story.model((model) => {
      expect(model.catalogue).toMatchObject({ data: { active: [] } });
      expect(model.maybeNotice).toEqual(Option.none());
      expect(model.name.value).toBe("Welcome");
      expect(model.commandIds.sent).toBe(1);
    }),
    Story.Command.resolve(
      LibraryClient.ProposeSkill,
      LibraryClient.Message.FailedProposeSkill({ commandId, failure: FixtureFailure.Unknown() }),
    ),
    Story.message(Message.UpdatedName({ value: "A later draft" })),
    Story.message(Message.ClickedRetry()),
    Story.Command.expectExact(propose),
    Story.Command.resolve(
      LibraryClient.ProposeSkill,
      LibraryClient.Message.SucceededProposeSkill({
        commandId,
        receipt,
        reply: { skillId: first, proposalRevision: 2 },
      }),
    ),
    Story.Command.expectExact(read),
    Story.model((model) => {
      expect(model.submission._tag).toBe("Confirming");
      expect(model.submission).toMatchObject({ receipt });
      expect(model.name.value).toBe("A later draft");
      expect(model.body.value).toBe("Say hello");
      expect(model.commandIds.sent).toBe(1);
    }),
    Story.Command.resolve(
      read,
      Message.SucceededReadSkillDetail({ key, generation: 1, state: proposed }),
    ),
    Story.message(Message.UpdatedCatalogue({ generation: 0, state: catalogue })),
    Story.model((model) => {
      expect(model.submission._tag).toBe("Idle");
      expect(model.detail).toMatchObject({ data: { body: "Say hello", detailRevision: 2 } });
      expect(model.maybeDetailBarrier).toEqual(Option.some(receipt));
    }),
  ));

test("catalogue arriving before the receipt cannot leave an accepted request stuck confirming", () => {
  const named = update(ready, Message.UpdatedName({ value: "Welcome" }));
  const drafted = update(named.model, Message.UpdatedBody({ value: "Say hello" }));
  const sent = update(drafted.model, Message.SubmittedProposal());
  const watched = update(sent.model, Message.UpdatedCatalogue({ generation: 0, state: catalogue }));

  const confirmed = update(
    watched.model,
    Message.GotLibraryMessage({
      message: LibraryClient.Message.SucceededProposeSkill({
        commandId,
        receipt,
        reply: { skillId: first, proposalRevision: 2 },
      }),
    }),
  );

  expect(confirmed.model.submission._tag).toBe("Idle");
  expect([confirmed.model.name.value, confirmed.model.body.value]).toEqual(["", ""]);
  expect(confirmed.commands?.map((command) => command.args)).toEqual([
    { key, generation: 1, maybeAtLeast: Option.some(receipt) },
  ]);
});

test("authentication expiry disables watches then re-enables a fresh generation while retaining the pending ID", () =>
  Story.story(
    update,
    Story.given(ready),
    Story.message(Message.UpdatedName({ value: "Welcome" })),
    Story.message(Message.UpdatedBody({ value: "Say hello" })),
    Story.message(Message.SubmittedProposal()),
    Story.Command.resolve(
      propose,
      LibraryClient.Message.FailedProposeSkill({
        commandId,
        failure: FixtureFailure.Denied({ error: new LibraryUnauthorized() }),
      }),
    ),
    Story.Command.expectExact(ReauthenticateLibrary({ scope: flags.scope, attempt: 1 })),
    Story.model((model) => {
      expect(subscriptions.catalogue.modelToDependencies(model).isEnabled).toBe(false);
      expect(model.submission._tag).toBe("Denied");
      expect(model.submission).toMatchObject({ request: { commandId } });
      expect(model.name.value).toBe("Welcome");
    }),
    Story.Command.resolve(
      ReauthenticateLibrary,
      Message.SucceededReauthenticateLibrary({ attempt: 1 }),
    ),
    Story.model((model) => {
      expect(subscriptions.catalogue.modelToDependencies(model)).toEqual({
        owner,
        generation: 1,
        isEnabled: true,
      });
      expect(model.scope).toEqual(flags.scope);
      expect(model.submission._tag).toBe("Unknown");
      expect(model.submission).toMatchObject({ request: { commandId } });
    }),
    Story.message(Message.UpdatedCatalogue({ generation: 0, state: catalogue })),
    Story.model((model) => expect(model.catalogueWatch).toBe("Starting")),
    Story.message(Message.UpdatedCatalogue({ generation: 1, state: catalogue })),
    Story.message(Message.ClickedRetry()),
    Story.Command.expectExact(propose),
    Story.Command.resolve(
      propose,
      LibraryClient.Message.FailedProposeSkill({ commandId, failure: FixtureFailure.Unknown() }),
    ),
    Story.model((model) => expect(model.commandIds.sent).toBe(1)),
  ));

test("changed authority fences the unresolved request and preserves the draft without adopting a new epoch", () =>
  Story.story(
    update,
    Story.given(ready),
    Story.message(Message.UpdatedName({ value: "Keep this draft" })),
    Story.message(Message.FailedCatalogueWatch({ generation: 0, problem: "Authentication" })),
    Story.Command.resolve(
      ReauthenticateLibrary,
      Message.FailedReauthenticateLibrary({ attempt: 1, reason: "ChangedAuthority" }),
    ),
    Story.message(Message.ClickedRetry()),
    Story.message(Message.ClickedReconnect()),
    Story.message(Message.ClickedReauthenticate()),
    Story.Command.expectNone(),
    Story.model((model) => {
      expect(model.scope).toEqual(flags.scope);
      expect(model.authentication._tag).toBe("Failed");
      expect(model.authentication).toMatchObject({ reason: "ChangedAuthority" });
      expect(model.name.value).toBe("Keep this draft");
      expect(subscriptions.catalogue.modelToDependencies(model).isEnabled).toBe(false);
    }),
  ));

test("terminated catalogue and detail watches stay disabled until reconnect, and old keyed messages cannot overwrite a new review", () => {
  const loaded = modifyFields(ready, { catalogue: () => Catalogue.Success({ data: catalogue }) });
  const otherKey = skillDetailKey(owner, second);

  Story.story(
    update,
    Story.given(loaded),
    Story.message(Message.ClickedReview({ skillId: first })),
    Story.Command.resolve(
      ReadSkillDetail,
      Message.SucceededReadSkillDetail({ key, generation: 1, state: proposed }),
    ),
    Story.message(Message.FailedDetailWatch({ key, generation: 1, problem: "Unavailable" })),
    Story.model((model) =>
      expect(subscriptions.detail.modelToDependencies(model).isEnabled).toBe(false),
    ),
    Story.message(Message.UpdatedDetail({ key, generation: 1, state: proposed })),
    Story.model((model) => expect(model.detail).toMatchObject({ error: "Unavailable" })),
    Story.message(Message.FailedCatalogueWatch({ generation: 0, problem: "Unavailable" })),
    Story.model((model) =>
      expect(subscriptions.catalogue.modelToDependencies(model).isEnabled).toBe(false),
    ),
    Story.message(Message.ClickedReconnect()),
    Story.Command.resolve(
      ReadSkillDetail,
      Message.SucceededReadSkillDetail({ key, generation: 2, state: proposed }),
    ),
    Story.message(Message.UpdatedCatalogue({ generation: 1, state: catalogue })),
    Story.message(Message.UpdatedDetail({ key: otherKey, generation: 2, state: null })),
    Story.message(Message.UpdatedDetail({ key, generation: 1, state: null })),
    Story.model((model) => {
      expect(subscriptions.detail.modelToDependencies(model).isEnabled).toBe(true);
      expect(model.detail).toMatchObject({
        data: { id: first, body: "Say hello" },
      });
    }),
  );
});

test("accept and remove use the reviewed proposal version and require their confirmed receipt detail", () => {
  const loaded = modifyFields(ready, {
    catalogue: () => Catalogue.Success({ data: catalogue }),
    maybeSelected: () => Option.some(first),
    detail: () => Detail.Success({ data: proposed }),
  });

  const acceptReceipt = { stream: "Library/owner", version: 3 };

  Story.story(
    update,
    Story.given(loaded),
    Story.message(Message.ClickedAccept()),
    Story.Command.expectExact(
      LibraryClient.AcceptSkill({
        target: owner,
        input: { skillId: first, expectedProposalRevision: 2 },
        commandId,
      }),
    ),
    Story.Command.resolve(
      LibraryClient.AcceptSkill,
      LibraryClient.Message.FailedAcceptSkill({
        commandId,
        failure: FixtureFailure.Rejected({
          rejection: new SkillAlreadyAccepted({ skillId: first }),
        }),
      }),
    ),
    Story.model((model) => expect(model.detail).toMatchObject({ data: { status: "proposed" } })),
    Story.message(Message.ClickedRemove()),
    Story.Command.expectExact(
      LibraryClient.RemoveSkill({
        target: owner,
        input: { skillId: first, expectedProposalRevision: 2 },
        commandId: "library:7:fixture:1",
      }),
    ),
    Story.Command.resolve(
      LibraryClient.RemoveSkill,
      LibraryClient.Message.SucceededRemoveSkill({
        commandId: "library:7:fixture:1",
        receipt: acceptReceipt,
        reply: undefined,
      }),
    ),
    Story.Command.resolve(
      ReadSkillDetail,
      Message.SucceededReadSkillDetail({
        key,
        generation: 1,
        state: { ...proposed, status: "removed", detailRevision: 3 },
      }),
    ),
    Story.message(
      Message.UpdatedCatalogue({
        generation: 0,
        state: { ...catalogue, active: [], catalogueRevision: 3 },
      }),
    ),
    Story.model((model) => {
      expect(model.detail).toMatchObject({
        data: { status: "removed", proposalRevision: 2, detailRevision: 3 },
      });
      expect(model.submission._tag).toBe("Idle");
    }),
  );
});
