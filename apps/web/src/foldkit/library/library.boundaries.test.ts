import { skillDetailKey } from "@kitties/domain/Library/Skill.id";
import { Option, Schema } from "effect";
import { Story } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { expect, test } from "vite-plus/test";
import { ReadSkillDetail, ReauthenticateLibrary } from "./command.ts";
import {
  catalogue,
  commandId,
  first,
  key,
  owner,
  proposed,
  ready,
  receipt,
  second,
} from "./fixtures.ts";
import { LibraryClient } from "./client.ts";
import { LibraryClientScope } from "./LibraryClientAuthentication.ts";
import { Message } from "./message.ts";
import { Catalogue, Detail } from "./model.ts";
import { canStartOperation, confirmedDetail } from "./selection.ts";
import { subscriptions } from "./subscription.ts";
import { update } from "./update.ts";

test.each([
  ["visible name at limit", "a".repeat(80), "", true],
  ["whitespace-only name", " \t ", "Keep", false],
  ["long name", "a".repeat(81), "Keep", false],
  ["body at limit", "Boundary", "界".repeat(64000), true],
  ["long body", "Boundary", "界".repeat(64001), false],
] as const)(
  "%s follows the shared domain bounds without sending an invalid draft",
  (_description, name, body, isValid) => {
    const named = update(ready, Message.UpdatedName({ value: name }));
    const drafted = update(named.model, Message.UpdatedBody({ value: body }));
    const submitted = update(drafted.model, Message.SubmittedProposal());

    expect(submitted.commands?.length ?? 0).toBe(isValid ? 1 : 0);
    expect([submitted.model.name.value, submitted.model.body.value]).toEqual([name, body]);
    expect(submitted.model.commandIds.sent).toBe(isValid ? 1 : 0);
  },
);

test("safe numeric epochs and bounded session IDs cannot inject another command-ID scope", () => {
  expect(Schema.is(LibraryClientScope)({ owner, epoch: 0, sessionId: "safe-session" })).toBe(true);
  expect(
    Schema.is(LibraryClientScope)({
      owner,
      epoch: Number.MAX_SAFE_INTEGER,
      sessionId: "safe-session",
    }),
  ).toBe(true);
  expect(
    [-1, 0.5, Number.MAX_SAFE_INTEGER + 1].map((epoch) =>
      Schema.is(LibraryClientScope)({ owner, epoch, sessionId: "safe" }),
    ),
  ).toEqual([false, false, false]);
  expect(
    ["", "foreign:1", "unsafe/path", "x".repeat(81)].map((sessionId) =>
      Schema.is(LibraryClientScope)({ owner, epoch: 1, sessionId }),
    ),
  ).toEqual([false, false, false, false]);
});

test("the exact numeric counter ceiling fails closed instead of reusing or rounding a command ID", () => {
  const exhausted = modifyFields(ready, {
    commandIds: () => ({ session: "fixture", sent: Number.MAX_SAFE_INTEGER }),
  });

  const named = update(exhausted, Message.UpdatedName({ value: "Keep" }));
  const submitted = update(named.model, Message.SubmittedProposal());

  expect(submitted.commands).toBeUndefined();
  expect(submitted.model.maybeNotice).toEqual(Option.some("CounterExhausted"));
  expect(submitted.model.name.value).toBe("Keep");
});

test.each(["Denied", "Unavailable"] as const)(
  "reauthentication %s preserves draft and requires an explicit subsequent attempt",
  (reason) =>
    Story.story(
      update,
      Story.given(ready),
      Story.message(Message.UpdatedName({ value: "Keep" })),
      Story.message(Message.FailedCatalogueWatch({ generation: 0, problem: "Authentication" })),
      Story.Command.resolve(
        ReauthenticateLibrary,
        Message.FailedReauthenticateLibrary({ attempt: 1, reason }),
      ),
      Story.model((model) => {
        expect(model.authentication).toMatchObject({ reason });
        expect(canStartOperation(model)).toBe(false);
        expect(model.name.value).toBe("Keep");
        expect(subscriptions.catalogue.modelToDependencies(model).isEnabled).toBe(false);
      }),
      Story.message(Message.ClickedReauthenticate()),
      Story.Command.resolve(
        ReauthenticateLibrary,
        Message.SucceededReauthenticateLibrary({ attempt: 2 }),
      ),
      Story.message(Message.UpdatedCatalogue({ generation: 1, state: catalogue })),
      Story.model((model) => expect(canStartOperation(model)).toBe(true)),
    ),
);

test("mismatched detail identity fails explicitly and stale catalogue versions cannot enable mutations", () => {
  const loaded = modifyFields(ready, { catalogue: () => Catalogue.Success({ data: catalogue }) });

  Story.story(
    update,
    Story.given(loaded),
    Story.message(Message.ClickedReview({ skillId: first })),
    Story.Command.resolve(
      ReadSkillDetail,
      Message.SucceededReadSkillDetail({ key, generation: 1, state: { ...proposed, id: second } }),
    ),
    Story.message(Message.ClickedAccept()),
    Story.Command.expectNone(),
    Story.model((model) => {
      expect(model.detail).toMatchObject({ error: "Unavailable" });
      expect(confirmedDetail(model)).toEqual(Option.none());
    }),
  );

  const newer = modifyFields(loaded, {
    maybeSelected: () => Option.some(first),
    detail: () => Detail.Success({ data: { ...proposed, detailRevision: 3, status: "accepted" } }),
  });

  const remove = update(newer, Message.ClickedRemove());

  expect(remove.commands).toBeUndefined();
  expect(confirmedDetail(newer)).toEqual(Option.none());
});

test("a receipt arriving during reauthentication defers its source-barrier detail read until the new client is ready", () => {
  const loaded = modifyFields(ready, { catalogue: () => Catalogue.Success({ data: catalogue }) });
  const confirmedReceipt = { stream: "Library/owner", version: 3 };

  const drafted = update(loaded, Message.UpdatedName({ value: "Keep" }));
  const sent = update(drafted.model, Message.SubmittedProposal());

  const expired = update(
    sent.model,
    Message.FailedCatalogueWatch({ generation: 0, problem: "Authentication" }),
  );

  const confirmed = update(
    expired.model,
    Message.GotLibraryMessage({
      message: LibraryClient.Message.SucceededProposeSkill({
        commandId,
        receipt: confirmedReceipt,
        reply: { skillId: second, proposalRevision: 3 },
      }),
    }),
  );

  expect(confirmed.commands).toEqual([]);
  expect(confirmed.model.maybeSelected).toEqual(Option.some(second));
  expect(confirmed.model.maybeDetailBarrier).toEqual(Option.some(confirmedReceipt));

  expect(update(confirmed.model, Message.ClickedReview({ skillId: first }))).toEqual({
    model: confirmed.model,
  });

  const refreshed = update(confirmed.model, Message.SucceededReauthenticateLibrary({ attempt: 1 }));

  expect(refreshed.commands?.map((command) => command.args)).toEqual([
    {
      key: skillDetailKey(owner, second),
      generation: 2,
      maybeAtLeast: Option.some(confirmedReceipt),
    },
  ]);
});

test("a late receipt from a fenced authority cannot clear or adopt the old draft", () => {
  const drafted = update(ready, Message.UpdatedName({ value: "Keep" }));
  const sent = update(drafted.model, Message.SubmittedProposal());

  const expired = update(
    sent.model,
    Message.FailedCatalogueWatch({ generation: 0, problem: "Authentication" }),
  );

  const fenced = update(
    expired.model,
    Message.FailedReauthenticateLibrary({ attempt: 1, reason: "ChangedAuthority" }),
  );

  const late = update(
    fenced.model,
    Message.GotLibraryMessage({
      message: LibraryClient.Message.SucceededProposeSkill({
        commandId,
        receipt,
        reply: { skillId: first, proposalRevision: 2 },
      }),
    }),
  );

  expect(late.model).toEqual(fenced.model);
  expect(late.model.name.value).toBe("Keep");
  expect(late.commands).toBeUndefined();
});
