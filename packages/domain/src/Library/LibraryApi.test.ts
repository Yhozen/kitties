import * as Domain from "@alchemy.run/domain";
import * as InMemory from "@alchemy.run/domain/InMemory";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Headers from "effect/http/Headers";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcMessage from "effect/rpc/RpcMessage";
import { expect, test } from "vite-plus/test";
import { LibraryModel } from "../Library.model.ts";
import { LibraryActor, LibraryActorValue } from "../LibraryActor.context.ts";
import { LibraryApi } from "../LibraryApi.api.ts";
import { LibraryImportApi } from "../LibraryImport.api.ts";
import {
  LibraryImportSession,
  LibraryRequestPayload,
  LibrarySession,
  LibraryUnauthorized,
  ownsLibraryPayload,
} from "../LibrarySession.middleware.ts";
import { Library } from "./Library.aggregate.ts";
import { LibraryId } from "./Library.id.ts";
import { FinalizedImport } from "./Library.state.ts";
import { SkillDetail } from "./SkillDetail.view.ts";
import { initialLibrary } from "./Library.state.ts";
import { ProposeSkill } from "./ProposeSkill.command.ts";
import { SkillId, skillDetailKey } from "./Skill.id.ts";

const owner = LibraryId.make("owner");
const other = LibraryId.make("other");
const ownerHeaders = { authorization: "fixture-owner" };
const otherHeaders = { authorization: "fixture-other" };
const importHeaders = { authorization: "fixture-importer" };

// A controlled verifier fixture: it tests the real middleware execution boundary,
// not Cloudflare JWT verification. Readiness comes from the internal authority.
const ownerSession = Layer.effect(
  LibrarySession,
  Effect.gen(function* () {
    const libraries = yield* Library;

    return LibrarySession.of((effect, { headers, payload, rpc }) =>
      Effect.gen(function* () {
        const libraryId = Match.value(headers.authorization).pipe(
          Match.when("fixture-owner", () => owner),
          Match.when("fixture-other", () => other),
          Match.orElse(() => undefined),
        );

        const decoded = Schema.decodeUnknownOption(LibraryRequestPayload)(payload);

        if (libraryId === undefined || Option.isNone(decoded)) {
          return yield* new LibraryUnauthorized();
        }

        const actor = LibraryActorValue.make({
          libraryId,
          authority: "owner",
          importFinalized: false,
        });

        if (!ownsLibraryPayload(actor, rpc._tag, decoded.value)) {
          return yield* new LibraryUnauthorized();
        }

        const state = yield* libraries.state(libraryId);

        return yield* Effect.provideService(effect, LibraryActor, {
          ...actor,
          importFinalized: Schema.is(FinalizedImport)(state.importProgress),
        });
      }),
    );
  }),
);

const importSession = Layer.succeed(
  LibraryImportSession,
  LibraryImportSession.of((effect, { headers, payload, rpc }) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(LibraryRequestPayload)(payload);

      const actor = LibraryActorValue.make({
        libraryId: owner,
        authority: "import",
        importFinalized: false,
      });

      if (
        headers.authorization !== "fixture-importer" ||
        Option.isNone(decoded) ||
        !ownsLibraryPayload(actor, rpc._tag, decoded.value)
      ) {
        return yield* new LibraryUnauthorized();
      }

      return yield* Effect.provideService(effect, LibraryActor, actor);
    }),
  ),
);

const makeWorld = () => {
  const memory = InMemory.make({ manual: true, now: () => 0 });
  const host = LibraryModel.layer(Layer.empty).pipe(Layer.provide(memory.layer));

  return {
    world: Layer.mergeAll(ownerSession, importSession).pipe(Layer.provideMerge(host)),
    drain: memory.control.drain,
  };
};

it.effect(
  "authorizes before cached command receipts and before every aggregate/detail read path",
  () => {
    const { world, drain } = makeWorld();

    return Effect.gen(function* () {
      const api = yield* LibraryApi.clientInProcess;
      const imports = yield* LibraryImportApi.clientInProcess;

      yield* imports.FinalizeLibraryImport(
        owner,
        { inventoryId: "empty-v1", expectedImportedCount: 0, expectedHighWater: 0 },
        { headers: importHeaders },
      );

      const receipt = yield* api.ProposeSkill(
        owner,
        { name: "Original", body: "Immutable original body" },
        { headers: ownerHeaders, commandId: "stable" },
      );

      const duplicate = yield* api.ProposeSkill(
        owner,
        { name: "Altered", body: "Altered body" },
        { headers: ownerHeaders, commandId: "stable" },
      );

      expect(duplicate).toEqual(receipt);
      expect(receipt.reply).toEqual({
        skillId: "kitties-skill-0000000000000001",
        proposalRevision: 2,
      });

      const deniedDuplicate = yield* api
        .ProposeSkill(
          owner,
          { name: "Attacker", body: "" },
          { headers: otherHeaders, commandId: "stable" },
        )
        .pipe(Effect.flip);

      const missingSession = yield* api
        .ProposeSkill(owner, { name: "No session", body: "" }, { commandId: "stable" })
        .pipe(Effect.flip);

      const foreignCatalogue = yield* api.Library.get(owner, { headers: otherHeaders }).pipe(
        Effect.flip,
      );

      const key = skillDetailKey(owner, receipt.reply.skillId);

      const foreignDetail = yield* api.SkillDetail.get(key, {
        headers: otherHeaders,
        atLeast: receipt,
      }).pipe(Effect.flip);

      const foreignSnapshot = yield* api.SkillDetail.snapshot(key, { headers: otherHeaders }).pipe(
        Effect.flip,
      );

      const foreignList = yield* api.SkillDetail.list(key, { headers: otherHeaders }).pipe(
        Effect.flip,
      );

      const foreignCatalogueWatch = yield* api.Library.watch(owner, { headers: otherHeaders }).pipe(
        Stream.runHead,
        Effect.flip,
      );

      const foreignCatalogueEvents = yield* api.Library.events(owner, {
        headers: otherHeaders,
      }).pipe(Stream.runHead, Effect.flip);

      const foreignDetailWatch = yield* api.SkillDetail.watch(key, { headers: otherHeaders }).pipe(
        Stream.runHead,
        Effect.flip,
      );

      const foreignDetailEvents = yield* api.SkillDetail.events(key, {
        headers: otherHeaders,
      }).pipe(Stream.runHead, Effect.flip);

      expect(
        [
          deniedDuplicate,
          missingSession,
          foreignCatalogue,
          foreignDetail,
          foreignSnapshot,
          foreignList,
          foreignCatalogueWatch,
          foreignCatalogueEvents,
          foreignDetailWatch,
          foreignDetailEvents,
        ].map((error) => error._tag),
      ).toEqual(Array(10).fill("LibraryUnauthorized"));

      yield* drain;

      const catalogue = yield* api.Library.get(owner, { headers: ownerHeaders });

      const detail = yield* api.SkillDetail.snapshot(key, {
        headers: ownerHeaders,
        atLeast: receipt,
      });

      expect(catalogue.active).toHaveLength(1);
      expect(catalogue.highWater).toBe(1);
      expect(detail.state).toMatchObject({
        name: "Original",
        body: "Immutable original body",
        proposalRevision: 2,
      });
      // Cursor counts this key's routed events; source revision 2 is the consistency barrier.
      expect(detail.cursor).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(world));
  },
);

it.effect("denies all public catalogue/detail reads until authoritative finalization", () => {
  const { world, drain } = makeWorld();

  return Effect.gen(function* () {
    const api = yield* LibraryApi.clientInProcess;
    const imports = yield* LibraryImportApi.clientInProcess;
    const id = SkillId.make("legacy");
    const key = skillDetailKey(owner, id);

    const beforeCatalogue = yield* api.Library.get(owner, { headers: ownerHeaders }).pipe(
      Effect.flip,
    );

    const beforeMissing = yield* api.SkillDetail.get(key, { headers: ownerHeaders }).pipe(
      Effect.flip,
    );

    yield* imports.ImportSkill(
      owner,
      {
        inventoryId: "frozen-v1",
        skill: { id, name: "Legacy", body: "Keep", status: "accepted", updatedAt: 42 },
      },
      { headers: importHeaders },
    );

    const beforeExisting = yield* api.SkillDetail.get(key, { headers: ownerHeaders }).pipe(
      Effect.flip,
    );

    const beforeWatch = yield* api.Library.watch(owner, { headers: ownerHeaders }).pipe(
      Stream.runHead,
      Effect.flip,
    );

    const beforeDetailWatch = yield* api.SkillDetail.watch(key, { headers: ownerHeaders }).pipe(
      Stream.runHead,
      Effect.flip,
    );

    expect(
      [beforeCatalogue, beforeMissing, beforeExisting, beforeWatch, beforeDetailWatch].map(
        (error) => error._tag,
      ),
    ).toEqual(Array(5).fill("LibraryImportRequired"));

    yield* imports.FinalizeLibraryImport(
      owner,
      { inventoryId: "frozen-v1", expectedImportedCount: 1, expectedHighWater: 0 },
      { headers: importHeaders },
    );

    yield* drain;

    const catalogue = yield* api.Library.get(owner, { headers: ownerHeaders });
    const detail = yield* api.SkillDetail.get(key, { headers: ownerHeaders });

    expect(catalogue.active.map((skill) => skill.id)).toEqual([id]);
    expect(detail).toMatchObject({ id, body: "Keep", status: "accepted", updatedAt: 42 });
  }).pipe(Effect.scoped, Effect.provide(world));
});

it.effect(
  "raw middleware rejects ambiguous selectors and unknown RPCs without invoking their handler",
  () => {
    const { world } = makeWorld();

    return Effect.gen(function* () {
      const session = yield* LibrarySession;
      const handler = Effect.die("Unauthorized handler was invoked");

      const options = {
        client: new Rpc.ServerClient(0),
        requestId: RpcMessage.RequestId("raw-1"),
        headers: Headers.fromInput(ownerHeaders),
      };

      const ambiguousCommand = yield* session(handler, {
        ...options,
        rpc: ProposeSkill.rpc,
        payload: {
          target: owner,
          key: `${other}/skill`,
          input: { name: "Own-looking target", body: "" },
        },
      }).pipe(Effect.flip);

      const ambiguousRead = yield* session(handler, {
        ...options,
        rpc: Rpc.make("SkillDetail.get"),
        payload: { target: owner, key: `${other}/skill` },
      }).pipe(Effect.flip);

      const unknownRpc = yield* session(handler, {
        ...options,
        rpc: Rpc.make("FuturePrivate.get"),
        payload: { key: owner },
      }).pipe(Effect.flip);

      expect(
        [ambiguousCommand, ambiguousRead, unknownRpc].map(Schema.is(LibraryUnauthorized)),
      ).toEqual([true, true, true]);
    }).pipe(Effect.scoped, Effect.provide(world));
  },
);

test("public API explicitly exposes only the lifecycle and owner catalogue/detail reads", () => {
  expect(Domain.verify(LibraryModel)).toEqual([]);
  expect(LibraryApi.commands.map((command) => command.tag)).toEqual([
    "ProposeSkill",
    "AcceptSkill",
    "RemoveSkill",
  ]);
  expect(LibraryApi.serves.map((entry) => entry.kind)).toEqual([
    "Command",
    "Command",
    "Command",
    "View",
    "Aggregate",
  ]);
  expect(LibraryImportApi.commands.map((command) => command.tag)).toEqual([
    "ImportSkill",
    "FinalizeLibraryImport",
  ]);
  expect(LibraryImportApi.serves.map((entry) => entry.kind)).toEqual(["Command", "Command"]);
});

it.effect(
  "read validation independently rejects wrong owners and unfinalized authority facts",
  () =>
    Effect.gen(function* () {
      const actor = LibraryActorValue.make({
        libraryId: owner,
        authority: "owner",
        importFinalized: false,
      });

      const key = skillDetailKey(owner, SkillId.make("legacy"));

      const detail = {
        libraryId: owner,
        id: SkillId.make("legacy"),
        name: "Legacy",
        body: "Keep",
        status: "accepted",
        updatedAt: 42,
        proposalRevision: 1,
        detailRevision: 1,
      } as const;

      const validateDetail = SkillDetail.definition.validate;

      if (validateDetail === undefined) {
        return yield* Effect.die("SkillDetail must declare read validation");
      }

      const pendingDetail = yield* validateDetail({ mode: "get", key }, detail).pipe(
        Effect.provideService(LibraryActor, actor),
        Effect.flip,
      );

      const foreignDetail = yield* validateDetail(
        { mode: "get", key: skillDetailKey(other, detail.id) },
        detail,
      ).pipe(Effect.provideService(LibraryActor, { ...actor, importFinalized: true }), Effect.flip);

      const validateCatalogue = Library.definition.read.validate;

      if (validateCatalogue === undefined) {
        return yield* Effect.die("Library must declare aggregate read validation");
      }

      const foreignCatalogue = yield* validateCatalogue(
        { mode: "get", key: { id: other } },
        initialLibrary,
      ).pipe(Effect.provideService(LibraryActor, actor), Effect.flip);

      // A readiness fact cannot override the aggregate's own durable state.
      const pendingCatalogue = yield* validateCatalogue(
        { mode: "get", key: { id: owner } },
        initialLibrary,
      ).pipe(Effect.provideService(LibraryActor, { ...actor, importFinalized: true }), Effect.flip);

      expect(pendingDetail._tag).toBe("LibraryImportRequired");
      expect(foreignDetail._tag).toBe("LibraryNotOwner");
      expect(foreignCatalogue._tag).toBe("LibraryNotOwner");
      expect(pendingCatalogue._tag).toBe("LibraryImportRequired");
    }),
);

const History = Schema.Array(
  Schema.Struct({ accept: Schema.Boolean, remove: Schema.Boolean }),
).check(Schema.isMinLength(1), Schema.isMaxLength(12));

it.effect.prop(
  "generated lifecycles preserve allocation, immutable detail and original retry receipts",
  [History],
  ([actions]) => {
    const { world, drain } = makeWorld();

    return Effect.gen(function* () {
      const api = yield* LibraryApi.clientInProcess;
      const imports = yield* LibraryImportApi.clientInProcess;

      const expected: Array<{
        id: string;
        status: string;
        proposalRevision: number;
        detailRevision: number;
      }> = [];

      let revision = 1;

      yield* imports.FinalizeLibraryImport(
        owner,
        { inventoryId: "empty-v1", expectedImportedCount: 0, expectedHighWater: 0 },
        { headers: importHeaders },
      );

      for (const [index, action] of actions.entries()) {
        const ordinal = index + 1;
        const id = SkillId.make(`kitties-skill-${String(ordinal).padStart(16, "0")}`);
        const key = skillDetailKey(owner, id);
        const options = { headers: ownerHeaders, commandId: `proposal-${ordinal}` };

        const receipt = yield* api.ProposeSkill(
          owner,
          { name: `Name ${ordinal}`, body: `Body ${ordinal}` },
          options,
        );

        const proposalRevision = ++revision;

        expect(receipt.reply).toEqual({ skillId: id, proposalRevision });

        if (action.accept) {
          yield* api.AcceptSkill(
            owner,
            { skillId: id, expectedProposalRevision: proposalRevision },
            { headers: ownerHeaders },
          );
          revision++;
        }

        if (action.remove) {
          yield* api.RemoveSkill(
            owner,
            { skillId: id, expectedProposalRevision: proposalRevision },
            { headers: ownerHeaders },
          );
          revision++;
        } else {
          expected.push({
            id,
            status: action.accept ? "accepted" : "proposed",
            proposalRevision,
            detailRevision: revision,
          });
        }

        const retry = yield* api.ProposeSkill(
          owner,
          { name: "Altered retry", body: "Must not replace" },
          options,
        );

        yield* drain;

        const catalogue = yield* api.Library.get(owner, { headers: ownerHeaders });

        const detail = yield* api.SkillDetail.get(key, {
          headers: ownerHeaders,
          atLeast: { stream: receipt.stream, version: revision },
        });

        expect(retry).toEqual(receipt);
        expect(catalogue.highWater).toBe(ordinal);
        expect(catalogue.catalogueRevision).toBe(revision);
        expect(
          catalogue.active.map(({ id, status, proposalRevision, detailRevision }) => ({
            id,
            status,
            proposalRevision,
            detailRevision,
          })),
        ).toEqual(expected);
        expect(detail).toMatchObject({
          id,
          name: `Name ${ordinal}`,
          body: `Body ${ordinal}`,
          status: action.remove ? "removed" : action.accept ? "accepted" : "proposed",
          proposalRevision,
          detailRevision: revision,
        });
      }
    }).pipe(Effect.scoped, Effect.provide(world));
  },
  { arbitrary: { runs: 30, seed: 24085 } },
);
