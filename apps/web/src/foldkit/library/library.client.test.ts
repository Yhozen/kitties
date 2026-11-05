import * as InMemory from "@alchemy.run/domain/InMemory";
import { it } from "@effect/vitest";
import { FinalizeLibraryImport } from "@kitties/domain/Library/FinalizeLibraryImport.command";
import { Library } from "@kitties/domain/Library/Library.aggregate";
import { LibraryModel } from "@kitties/domain/Library.model";
import { LibraryActor } from "@kitties/domain/LibraryActor.context";
import { LibraryApi } from "@kitties/domain/LibraryApi.api";
import {
  LibraryRequestPayload,
  LibrarySession,
  LibraryUnauthorized,
  ownsLibraryPayload,
} from "@kitties/domain/LibrarySession.middleware";
import { Deferred, Effect, Fiber, Layer, Option, Predicate, Ref, Schema, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { modifyFields } from "foldkit/struct";
import { expect } from "vite-plus/test";
import { LibraryClient } from "./client.ts";
import { ReadSkillDetail, ReauthenticateLibrary } from "./command.ts";
import { commandId, flags, key, owner, receipt } from "./fixtures.ts";
import {
  LibraryClientAuthentication,
  LibraryReauthenticationFailed,
} from "./LibraryClientAuthentication.ts";
import { Message } from "./message.ts";
import { Catalogue, init } from "./model.ts";
import { subscriptions } from "./subscription.ts";
import { update } from "./update.ts";

const actor = { libraryId: owner, authority: "owner", importFinalized: true } as const;

// Local authority fixture; provider verification belongs to the runtime host.
const session = (isAllowed: boolean) =>
  Layer.succeed(
    LibrarySession,
    LibrarySession.of((effect, { payload, rpc }) =>
      Effect.gen(function* () {
        const request = Schema.decodeUnknownOption(LibraryRequestPayload)(payload);

        if (
          !isAllowed ||
          Option.isNone(request) ||
          !ownsLibraryPayload(actor, rpc._tag, request.value)
        ) {
          return yield* new LibraryUnauthorized();
        }

        return yield* effect.pipe(Effect.provideService(LibraryActor, actor));
      }),
    ),
  );

const makeWorld = (isAllowed: boolean) => {
  const memory = InMemory.make({ manual: true, now: () => 0 });
  const host = LibraryModel.layer(Layer.empty).pipe(Layer.provide(memory.layer));

  return { world: session(isAllowed).pipe(Layer.provideMerge(host)), drain: memory.control.drain };
};

it.effect(
  "review waits for the selected catalogue revision through the actual API while detail delivery is pending",
  () => {
    const { world, drain } = makeWorld(true);

    return Effect.gen(function* () {
      const libraries = yield* Library;

      yield* libraries
        .send(
          owner,
          new FinalizeLibraryImport({
            inventoryId: "empty",
            expectedImportedCount: 0,
            expectedHighWater: 0,
          }),
        )
        .pipe(
          Effect.provideService(LibraryActor, {
            ...actor,
            authority: "import",
            importFinalized: false,
          }),
        );

      const api = yield* LibraryApi.clientInProcess;

      const proposal = yield* LibraryClient.ProposeSkill({
        target: owner,
        input: { name: "Welcome", body: "Wait for these instructions" },
        commandId,
      }).effect.pipe(Effect.provideService(LibraryApi.Client, api));

      if (!Predicate.isTagged(proposal, "SucceededProposeSkill")) {
        return yield* Effect.die("fixture proposal must succeed");
      }

      yield* LibraryClient.ProposeSkill({
        target: owner,
        input: { name: "Other", body: "Unrelated later event" },
        commandId: "library:7:fixture:1",
      }).effect.pipe(Effect.provideService(LibraryApi.Client, api));

      const catalogue = yield* api.Library.get(owner);

      if (catalogue === null) {
        return yield* Effect.die("fixture catalogue must exist");
      }

      const loaded = modifyFields(init(flags).model, {
        catalogue: () => Catalogue.Success({ data: catalogue }),
        catalogueWatch: () => "Live",
      });

      const review = update(loaded, Message.ClickedReview({ skillId: proposal.reply.skillId }));

      const requested =
        yield* Deferred.make<
          Option.Option<{ readonly stream: string; readonly version: number }>
        >();

      const completed = yield* Deferred.make<void>();

      const observedClient = modifyFields(api, {
        SkillDetail: (detail) =>
          modifyFields(detail, {
            get: (get) => (key, options) =>
              Deferred.succeed(requested, Option.fromNullishOr(options?.atLeast)).pipe(
                Effect.andThen(get(key, options)),
              ),
          }),
      });

      expect(catalogue.catalogueRevision).toBe(3);
      expect(yield* api.SkillDetail.get(key)).toBeNull();

      const reading = yield* Effect.forEach(
        review.commands ?? [],
        (command) => command.effect,
      ).pipe(
        Effect.tap(() => Deferred.succeed(completed, undefined)),
        Effect.provideService(LibraryApi.Client, observedClient),
        Effect.provideService(LibraryClientAuthentication, {
          reauthenticate: () =>
            Effect.fail(new LibraryReauthenticationFailed({ reason: "Unavailable" })),
        }),
        Effect.forkChild,
      );

      expect(yield* Deferred.await(requested)).toEqual(
        Option.some({ stream: "Library/owner", version: 2 }),
      );

      yield* TestClock.adjust(0);

      expect(yield* Deferred.poll(completed)).toEqual(Option.none());

      yield* drain;
      yield* TestClock.adjust("25 millis");

      const messages = yield* Fiber.join(reading);

      expect(messages).toHaveLength(1);
      expect(messages[0]._tag).toBe("SucceededReadSkillDetail");
      expect(messages[0]).toMatchObject({
        key,
        generation: 1,
        state: { name: "Welcome", body: "Wait for these instructions", detailRevision: 2 },
      });
    }).pipe(Effect.scoped, Effect.provide(world));
  },
);

it.effect(
  "official commands and keyed watches use the actual in-process API and pass the accepted source barrier to detail",
  () => {
    const { world, drain } = makeWorld(true);

    return Effect.gen(function* () {
      const libraries = yield* Library;

      yield* libraries
        .send(
          owner,
          new FinalizeLibraryImport({
            inventoryId: "empty",
            expectedImportedCount: 0,
            expectedHighWater: 0,
          }),
        )
        .pipe(
          Effect.provideService(LibraryActor, {
            ...actor,
            authority: "import",
            importFinalized: false,
          }),
        );

      const api = yield* LibraryApi.clientInProcess;

      const proposed = yield* LibraryClient.ProposeSkill({
        target: owner,
        input: { name: "Welcome", body: "Say hello" },
        commandId,
      }).effect.pipe(Effect.provideService(LibraryApi.Client, api));

      expect(proposed).toMatchObject({ commandId, receipt });
      expect(proposed._tag).toBe("SucceededProposeSkill");

      yield* drain;

      const captured = yield* Ref.make<
        Option.Option<{ readonly stream: string; readonly version: number }>
      >(Option.none());

      const observedClient = modifyFields(api, {
        SkillDetail: (detail) =>
          modifyFields(detail, {
            get: (get) => (key, options) =>
              Effect.gen(function* () {
                yield* Ref.set(captured, Option.fromNullishOr(options?.atLeast));

                return yield* get(key, options);
              }),
          }),
      });

      const detail = yield* ReadSkillDetail({
        key,
        generation: 1,
        maybeAtLeast: Option.some(receipt),
      }).effect.pipe(Effect.provideService(LibraryApi.Client, observedClient));

      const watched = yield* subscriptions.catalogue
        .dependenciesToStream({ owner, generation: 0, isEnabled: true })
        .pipe(Stream.runHead, Effect.provideService(LibraryApi.Client, api));

      const detailWatch = yield* subscriptions.detail
        .dependenciesToStream({ maybeKey: Option.some(key), generation: 1, isEnabled: true })
        .pipe(Stream.runHead, Effect.provideService(LibraryApi.Client, api));

      expect(yield* Ref.get(captured)).toEqual(Option.some(receipt));
      expect(detail).toMatchObject({
        key,
        generation: 1,
        state: { body: "Say hello", detailRevision: 2 },
      });
      expect(detail._tag).toBe("SucceededReadSkillDetail");
      expect(Option.getOrUndefined(watched)).toMatchObject({
        generation: 0,
        state: { catalogueRevision: 2, highWater: 1 },
      });
      expect(Option.getOrUndefined(detailWatch)).toMatchObject({
        key,
        generation: 1,
        state: { body: "Say hello" },
      });
    }).pipe(Effect.scoped, Effect.provide(world));
  },
);

it.effect(
  "official denied command/watch outcomes remain explicit and disabled subscriptions produce no messages",
  () => {
    const { world } = makeWorld(false);

    return Effect.gen(function* () {
      const api = yield* LibraryApi.clientInProcess;

      const command = yield* LibraryClient.ProposeSkill({
        target: owner,
        input: { name: "Denied", body: "" },
        commandId,
      }).effect.pipe(Effect.provideService(LibraryApi.Client, api));

      const watch = yield* subscriptions.catalogue
        .dependenciesToStream({ owner, generation: 4, isEnabled: true })
        .pipe(Stream.runHead, Effect.provideService(LibraryApi.Client, api));

      const disabled = yield* subscriptions.catalogue
        .dependenciesToStream({ owner, generation: 4, isEnabled: false })
        .pipe(Stream.runCollect, Effect.provideService(LibraryApi.Client, api));

      const detail = yield* ReadSkillDetail({
        key,
        generation: 1,
        maybeAtLeast: Option.none(),
      }).effect.pipe(Effect.provideService(LibraryApi.Client, api));

      expect(command).toMatchObject({ commandId, failure: { error: new LibraryUnauthorized() } });
      expect(command._tag).toBe("FailedProposeSkill");
      expect(Option.getOrUndefined(watch)).toMatchObject({
        problem: "Authentication",
        generation: 4,
      });
      expect(disabled).toHaveLength(0);
      expect(detail).toMatchObject({ problem: "Authentication", key, generation: 1 });
      expect(detail._tag).toBe("FailedReadSkillDetail");
    }).pipe(Effect.scoped, Effect.provide(world));
  },
);

it.effect(
  "the named reauthentication command passes only safe scope and preserves a changed-authority failure",
  () =>
    Effect.gen(function* () {
      const requested = yield* Ref.make(Option.none<typeof flags.scope>());

      const authentication = Layer.succeed(
        LibraryClientAuthentication,
        LibraryClientAuthentication.of({
          reauthenticate: (scope) =>
            Ref.set(requested, Option.some(scope)).pipe(
              Effect.andThen(new LibraryReauthenticationFailed({ reason: "ChangedAuthority" })),
            ),
        }),
      );

      const result = yield* ReauthenticateLibrary({ scope: flags.scope, attempt: 2 }).effect.pipe(
        Effect.provide(authentication),
      );

      expect(yield* Ref.get(requested)).toEqual(
        Option.some({ owner, epoch: 7, sessionId: "fixture" }),
      );
      expect(result).toMatchObject({ attempt: 2, reason: "ChangedAuthority" });
      expect(result._tag).toBe("FailedReauthenticateLibrary");
    }),
);
