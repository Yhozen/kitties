import * as Domain from "@alchemy.run/domain";
import * as InMemory from "@alchemy.run/domain/InMemory";
import { it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import * as Headers from "effect/http/Headers";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcMessage from "effect/rpc/RpcMessage";
import { expect, test } from "vite-plus/test";
import { LibraryModel } from "../Library.model.ts";
import { LibraryActor } from "../LibraryActor.context.ts";
import { LibraryApi } from "../LibraryApi.api.ts";
import { LibraryImportApi } from "../LibraryImport.api.ts";
import {
  LibraryRecoverySession,
  LibraryRequestPayload,
  LibraryUnauthorized,
  ownsLibraryPayload,
  ownsLibraryRecoveryPayload,
} from "../LibrarySession.middleware.ts";
import { AdvanceLibraryAllocatorFloor } from "./AdvanceLibraryAllocatorFloor.command.ts";
import { FinalizeLibraryImport } from "./FinalizeLibraryImport.command.ts";
import { Library } from "./Library.aggregate.ts";
import { LibraryId } from "./Library.id.ts";
import { LibraryRecoveryActor } from "./LibraryRecoveryActor.context.ts";
import { ProposeSkill } from "./ProposeSkill.command.ts";

const owner = LibraryId.make("owner");
const other = LibraryId.make("other");
const actor = { libraryId: owner, authority: "owner", importFinalized: true } as const;
const recoveryHeaders = { authorization: "fixture-recovery" };

// Test-only API; production callers use the trusted Library service directly.
class RecoveryFixtureApi extends Domain.Api("RecoveryFixtureApi", {
  model: LibraryModel,
  commands: ["AdvanceLibraryAllocatorFloor"],
  aggregates: [],
  views: [],
  streams: [],
  parseOptions: { onExcessProperty: "error" },
}) {}

// Controlled verifier fixture, not a production recovery credential verifier.
const recoverySession = Layer.succeed(
  LibraryRecoverySession,
  LibraryRecoverySession.of((effect, { headers, payload, rpc }) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(LibraryRequestPayload)(payload);

      if (
        headers.authorization !== "fixture-recovery" ||
        Option.isNone(decoded) ||
        !ownsLibraryRecoveryPayload({ libraryId: owner }, rpc._tag, decoded.value)
      ) {
        return yield* new LibraryUnauthorized();
      }

      return yield* effect.pipe(Effect.provideService(LibraryRecoveryActor, { libraryId: owner }));
    }),
  ),
);

const makeWorld = () => {
  const memory = InMemory.make({ manual: true, now: () => 0 });
  const host = LibraryModel.layer(Layer.empty).pipe(Layer.provide(memory.layer));

  return recoverySession.pipe(Layer.provideMerge(host));
};

it.effect(
  "private recovery authorization precedes duplicate receipts and preserves the original floor reply",
  () =>
    Effect.gen(function* () {
      const libraries = yield* Library;
      const api = yield* RecoveryFixtureApi.clientInProcess;

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

      const receipt = yield* api.AdvanceLibraryAllocatorFloor(
        owner,
        { floor: 12 },
        { headers: recoveryHeaders, commandId: "floor" },
      );

      const duplicate = yield* api.AdvanceLibraryAllocatorFloor(
        owner,
        { floor: 99 },
        { headers: recoveryHeaders, commandId: "floor" },
      );

      expect(duplicate).toEqual(receipt);
      expect(receipt.version).toBe(2);

      const denied = [];

      for (const authorization of [
        undefined,
        "fixture-owner",
        "fixture-importer",
        "fixture-other",
      ]) {
        const failure = yield* api
          .AdvanceLibraryAllocatorFloor(
            owner,
            { floor: 99 },
            {
              commandId: "floor",
              headers: authorization === undefined ? {} : { authorization },
            },
          )
          .pipe(Effect.flip);

        denied.push(failure._tag);
      }

      const wrongTarget = yield* api
        .AdvanceLibraryAllocatorFloor(
          other,
          { floor: 99 },
          { headers: recoveryHeaders, commandId: "floor" },
        )
        .pipe(Effect.flip);

      expect(denied).toEqual(Array(4).fill("LibraryUnauthorized"));
      expect(wrongTarget._tag).toBe("LibraryUnauthorized");
      expect((yield* libraries.state(owner)).highWater).toBe(12);

      const covered = yield* libraries
        .send(owner, new AdvanceLibraryAllocatorFloor({ floor: 3 }), { commandId: "covered" })
        .pipe(Effect.provideService(LibraryRecoveryActor, { libraryId: owner }));

      const coveredRetry = yield* libraries
        .send(owner, new AdvanceLibraryAllocatorFloor({ floor: 90 }), { commandId: "covered" })
        .pipe(Effect.provideService(LibraryRecoveryActor, { libraryId: owner }));

      expect(coveredRetry).toEqual(covered);
      expect(covered.version).toBe(2);
      expect((yield* libraries.state(owner)).highWater).toBe(12);

      const proposal = yield* libraries
        .send(owner, new ProposeSkill({ name: "Next", body: "" }))
        .pipe(Effect.provideService(LibraryActor, actor));

      expect(proposal.reply).toEqual({
        skillId: "kitties-skill-0000000000000013",
        proposalRevision: 3,
      });
    }).pipe(Effect.scoped, Effect.provide(makeWorld())),
);

it.effect(
  "private middleware rejects ambiguous selectors, malformed payloads and unknown RPCs before the handler",
  () =>
    Effect.gen(function* () {
      const session = yield* LibraryRecoverySession;
      const handler = Effect.die("Unauthorized recovery handler was invoked");

      const options = {
        client: new Rpc.ServerClient(0),
        requestId: RpcMessage.RequestId("recovery-raw"),
        headers: Headers.fromInput(recoveryHeaders),
      };

      const ambiguous = yield* session(handler, {
        ...options,
        rpc: AdvanceLibraryAllocatorFloor.rpc,
        payload: { target: owner, key: `${other}/skill`, input: { floor: 12 } },
      }).pipe(Effect.flip);

      const malformed = yield* session(handler, {
        ...options,
        rpc: AdvanceLibraryAllocatorFloor.rpc,
        payload: { target: 42 },
      }).pipe(Effect.flip);

      const unknown = yield* session(handler, {
        ...options,
        rpc: Rpc.make("FuturePrivateCommand"),
        payload: { target: owner },
      }).pipe(Effect.flip);

      const ownerCommand = yield* session(handler, {
        ...options,
        rpc: ProposeSkill.rpc,
        payload: { target: owner },
      }).pipe(Effect.flip);

      expect(
        [ambiguous, malformed, unknown, ownerCommand].map(Schema.is(LibraryUnauthorized)),
      ).toEqual([true, true, true, true]);
    }).pipe(Effect.scoped, Effect.provide(makeWorld())),
);

test("recovery is a separate private capability, excluded from owner and import APIs", () => {
  expect(LibraryApi.commands.map((command) => command.tag)).toEqual([
    "ProposeSkill",
    "AcceptSkill",
    "RemoveSkill",
  ]);
  expect(LibraryImportApi.commands.map((command) => command.tag)).toEqual([
    "ImportSkill",
    "FinalizeLibraryImport",
  ]);
  expect(ownsLibraryPayload(actor, "AdvanceLibraryAllocatorFloor", { target: owner })).toBe(false);
  expect(
    ownsLibraryPayload({ ...actor, authority: "import" }, "AdvanceLibraryAllocatorFloor", {
      target: owner,
    }),
  ).toBe(false);
  expect(
    ownsLibraryRecoveryPayload({ libraryId: owner }, "AdvanceLibraryAllocatorFloor", {
      target: owner,
      key: owner,
    }),
  ).toBe(false);
  expect(
    ownsLibraryRecoveryPayload({ libraryId: owner }, "FuturePrivateCommand", { target: owner }),
  ).toBe(false);
});
