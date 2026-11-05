import * as InMemory from "@alchemy.run/domain/InMemory";
import * as Foldkit from "@alchemy.run/domain/Foldkit";
import { Library } from "@kitties/domain/Library/Library.aggregate";
import { LibraryId } from "@kitties/domain/Library/Library.id";
import { FinalizeLibraryImport } from "@kitties/domain/Library/FinalizeLibraryImport.command";
import { ProposeSkill } from "@kitties/domain/Library/ProposeSkill.command";
import { LibraryActor } from "@kitties/domain/LibraryActor.context";
import { LibraryModel } from "@kitties/domain/Library.model";
import { LibraryApi } from "@kitties/domain/LibraryApi.api";
import { LibraryImportApi } from "@kitties/domain/LibraryImport.api";
import {
  LibraryImportSession,
  LibrarySession,
  LibraryUnauthorized,
} from "@kitties/domain/LibrarySession.middleware";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Match from "effect/Match";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Stream from "effect/Stream";
import { SkillDetailKey } from "@kitties/domain/Library/Skill.id";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Headers from "effect/http/Headers";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcMessage from "effect/rpc/RpcMessage";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import { AccessAssertionRejected, AccessJwtVerifier } from "./access-jwt.ts";
import {
  LIBRARY_OWNER,
  LibraryAdmission,
  LibraryAdmissionDenied,
  LibraryAdmissionUnavailable,
  LibraryAuthentication,
  LibraryImportGrant,
  LibraryImportSessionLive,
  LibraryRequestScope,
  LibrarySessionLive,
  LibraryTransportSession,
  awaitLibrarySessionExpiry,
  libraryAuthenticationLayer,
  libraryCommandId,
  localLibraryAuthenticationLayer,
  withinLibrarySession,
} from "./library-session.ts";

const publicUrl = "https://kitties.example";

const config = {
  publicUrl,
  issuer: "https://fixture.cloudflareaccess.com",
  audience: "fixture-audience",
  ownerEmail: "owner@example.test",
  nativeOrigins: ["tauri://localhost"],
} as const;

const session = { libraryId: LIBRARY_OWNER, expiresAt: 10000 };
const epochHeaders = { "x-kitties-library-epoch": "7" };

const verifier = Layer.succeed(AccessJwtVerifier, {
  verify: Effect.fnUntraced(function* (request) {
    if (request.headers.get("Cf-Access-Jwt-Assertion") !== "fixture-signed")
      return yield* new AccessAssertionRejected();

    return { email: "owner@example.test", expiresAt: 10000 };
  }),
});

const authentication = libraryAuthenticationLayer({
  ...config,
  nativeOrigins: ["tauri://localhost"],
}).pipe(Layer.provide(verifier));

const allowedTransportExamples: ReadonlyArray<{ name: string; headers: Record<string, string> }> = [
  {
    name: "same-origin browser",
    headers: {
      origin: publicUrl,
      "sec-fetch-site": "same-origin",
      cookie: "CF_Authorization=fixture",
    },
  },
  { name: "native without Origin", headers: { authorization: "Bearer opaque" } },
  {
    name: "explicit Tauri Origin",
    headers: { origin: "tauri://localhost", authorization: "Bearer opaque" },
  },
];

for (const { name, headers } of allowedTransportExamples) {
  it.effect(`authenticates ${name} only using its signed assertion`, () =>
    Effect.gen(function* () {
      const auth = yield* LibraryAuthentication;

      const result = yield* auth.verify(
        new Request(`${publicUrl}/v1/library/rpc`, {
          method: "POST",
          headers: { ...headers, "Cf-Access-Jwt-Assertion": "fixture-signed" },
        }),
      );

      expect(result).toEqual({ libraryId: "owner", expiresAt: 10000 });
      expect(Object.isFrozen(result)).toBe(true);
    }).pipe(Effect.provide(authentication)),
  );
}

const deniedTransportExamples: ReadonlyArray<{ name: string; headers: Record<string, string> }> = [
  {
    name: "foreign Origin plus fabricated bearer and victim cookie",
    headers: {
      origin: "https://evil.example",
      authorization: "Bearer fabricated",
      cookie: "CF_Authorization=victim",
    },
  },
  {
    name: "absent Origin with browser cookies plus bearer",
    headers: { authorization: "Bearer fabricated", cookie: "CF_Authorization=victim" },
  },
  {
    name: "cross-site browser plus bearer",
    headers: { authorization: "Bearer fabricated", "sec-fetch-site": "cross-site" },
  },
  {
    name: "Tauri Origin with browser cookies",
    headers: {
      origin: "tauri://localhost",
      authorization: "Bearer fabricated",
      cookie: "CF_Authorization=victim",
    },
  },
  {
    name: "unconfigured native Origin",
    headers: { origin: "https://tauri.localhost", authorization: "Bearer opaque" },
  },
  { name: "browser write without Origin", headers: {} },
  { name: "recognized Origin without native bearer", headers: { origin: "tauri://localhost" } },
  {
    name: "same-origin claim with conflicting fetch metadata",
    headers: { origin: publicUrl, "sec-fetch-site": "cross-site" },
  },
];

for (const { name, headers } of deniedTransportExamples) {
  it.effect(`rejects ${name} after assertion verification`, () =>
    Effect.gen(function* () {
      const auth = yield* LibraryAuthentication;

      const denied = yield* auth
        .verify(
          new Request(`${publicUrl}/v1/library/rpc`, {
            method: "POST",
            headers: { ...headers, "Cf-Access-Jwt-Assertion": "fixture-signed" },
          }),
        )
        .pipe(Effect.flip);

      expect(denied.reason).toBe("origin");
    }).pipe(Effect.provide(authentication)),
  );
}

it.effect(
  "neither a recognized Origin nor a bearer authenticates without the signed assertion",
  () =>
    Effect.gen(function* () {
      const auth = yield* LibraryAuthentication;

      const denied = yield* auth
        .verify(
          new Request(`${publicUrl}/v1/library/rpc`, {
            method: "POST",
            headers: { origin: "tauri://localhost", authorization: "Bearer fabricated" },
          }),
        )
        .pipe(Effect.flip);

      expect(denied.reason).toBe("assertion");
    }).pipe(Effect.provide(authentication)),
);

it.effect("rejects a verified different owner and endpoint substitution", () =>
  Effect.gen(function* () {
    const auth = yield* LibraryAuthentication;

    const ownerDenied = yield* auth
      .verify(
        new Request(`${publicUrl}/v1/library/rpc`, {
          method: "POST",
          headers: { origin: publicUrl },
        }),
      )
      .pipe(Effect.flip);

    const endpointDenied = yield* auth
      .verify(new Request("https://evil.example/v1/library/rpc"))
      .pipe(Effect.flip);

    expect([ownerDenied.reason, endpointDenied.reason]).toEqual(["owner", "endpoint"]);
  }).pipe(
    Effect.provide(
      libraryAuthenticationLayer({ ...config, nativeOrigins: [] }).pipe(
        Layer.provide(
          Layer.succeed(AccessJwtVerifier, {
            verify: () => Effect.succeed({ email: "other@example.test", expiresAt: 10000 }),
          }),
        ),
      ),
    ),
  ),
);

it.effect("normal expired verification denies at the exact expiry instant", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust(10000);
    const auth = yield* LibraryAuthentication;

    const denied = yield* auth
      .verify(
        new Request(`${publicUrl}/v1/library/rpc`, {
          method: "POST",
          headers: { origin: publicUrl, "Cf-Access-Jwt-Assertion": "fixture-signed" },
        }),
      )
      .pipe(Effect.flip);

    expect(denied.reason).toBe("expired");
  }).pipe(Effect.provide(authentication)),
);

it.effect("only explicit local composition supplies local identity and still expires", () =>
  Effect.gen(function* () {
    const auth = yield* LibraryAuthentication;

    const localRequest = new Request("http://localhost:1337/v1/library/rpc", {
      method: "POST",
      headers: { origin: "http://localhost:1337" },
    });

    const initial = yield* auth.verify(localRequest);
    yield* TestClock.adjust(1000);
    const expired = yield* auth.verify(localRequest).pipe(Effect.flip);
    expect(initial).toEqual({ libraryId: "owner", expiresAt: 1000 });
    expect(expired.reason).toBe("expired");
  }).pipe(Effect.provide(localLibraryAuthenticationLayer("http://localhost:1337", 1000))),
);

it.effect("local composition refuses a remote endpoint", () =>
  Effect.gen(function* () {
    const denied = yield* Effect.service(LibraryAuthentication).pipe(
      Effect.provide(localLibraryAuthenticationLayer("https://kitties.example", 1000)),
      Effect.flip,
    );

    expect(denied.reason).toBe("configuration");
  }),
);

const makeWorld = () => {
  const memory = InMemory.make({ manual: true, now: () => 0 });
  const host = LibraryModel.layer(Layer.empty).pipe(Layer.provide(memory.layer));
  const checks: Array<{ libraryId: string; epoch: number }> = [];
  const control = { epoch: 7, unavailable: false };

  const admission = Layer.succeed(LibraryAdmission, {
    check: Effect.fnUntraced(function* (scope) {
      checks.push({ ...scope });

      if (control.unavailable) return yield* new LibraryAdmissionUnavailable();

      if (scope.epoch !== control.epoch) return yield* new LibraryAdmissionDenied();
    }),
  });

  const world = Layer.mergeAll(LibrarySessionLive, LibraryImportSessionLive).pipe(
    Layer.provideMerge(host),
    Layer.provide(
      Layer.mergeAll(
        admission,
        Layer.succeed(LibraryTransportSession, session),
        Layer.succeed(LibraryImportGrant, { libraryId: LIBRARY_OWNER, epoch: 7 }),
      ),
    ),
  );

  return { world, checks, control, drain: memory.control.drain };
};

const finalize = (imports: typeof LibraryImportApi.Client.Service) =>
  imports.FinalizeLibraryImport(
    LIBRARY_OWNER,
    { inventoryId: "empty-v1", expectedImportedCount: 0, expectedHighWater: 0 },
    { commandId: "library:7:finalize" },
  );

it.effect("checks ownership before returning another owner's cached receipt", () => {
  const { world, checks } = makeWorld();

  return Effect.gen(function* () {
    const libraries = yield* Library;
    const other = LibraryId.make("other");
    yield* libraries
      .send(
        other,
        new FinalizeLibraryImport({
          inventoryId: "other",
          expectedImportedCount: 0,
          expectedHighWater: 0,
        }),
      )
      .pipe(
        Effect.provideService(LibraryActor, {
          libraryId: other,
          authority: "import",
          importFinalized: false,
        }),
      );
    yield* libraries
      .send(other, new ProposeSkill({ name: "Private", body: "Private body" }), {
        commandId: "library:7:cached",
      })
      .pipe(
        Effect.provideService(LibraryActor, {
          libraryId: other,
          authority: "owner",
          importFinalized: true,
        }),
      );
    const api = yield* LibraryApi.clientInProcess;

    const denied = yield* api
      .ProposeSkill(other, { name: "Stolen", body: "" }, { commandId: "library:7:cached" })
      .pipe(Effect.flip);

    expect(denied._tag).toBe("LibraryUnauthorized");
    expect(checks).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(world));
});

it.effect(
  "uses authoritative readiness and preserves the entire encoded receipt identity across recovery",
  () => {
    const { world, checks, control, drain } = makeWorld();

    return Effect.gen(function* () {
      const api = yield* LibraryApi.clientInProcess;
      const imports = yield* LibraryImportApi.clientInProcess;

      const before = yield* api.Library.get(LIBRARY_OWNER, { headers: epochHeaders }).pipe(
        Effect.flip,
      );

      yield* finalize(imports);
      const ids = Foldkit.next(Foldkit.CommandIds.make({ session: "owned-session", sent: 0 }));
      const commandId = libraryCommandId(7, ids.commandId);
      expect(commandId).toBe("library:7:owned-session:0");

      const original = yield* api.ProposeSkill(
        LIBRARY_OWNER,
        { name: "Original", body: "Keep" },
        { commandId },
      );

      const retry = yield* api.ProposeSkill(
        LIBRARY_OWNER,
        { name: "Changed", body: "Never" },
        { commandId },
      );

      yield* drain;
      const catalogue = yield* api.Library.get(LIBRARY_OWNER, { headers: epochHeaders });
      control.epoch = 8;

      const stale = yield* api
        .ProposeSkill(LIBRARY_OWNER, { name: "Original", body: "Keep" }, { commandId })
        .pipe(Effect.flip);

      const reheadered = yield* api
        .ProposeSkill(
          LIBRARY_OWNER,
          { name: "Original", body: "Keep" },
          {
            commandId,
            headers: { "x-kitties-library-epoch": "8" },
          },
        )
        .pipe(Effect.flip);

      const staleRead = yield* api.Library.get(LIBRARY_OWNER, { headers: epochHeaders }).pipe(
        Effect.flip,
      );

      expect(before._tag).toBe("LibraryImportRequired");
      expect(retry).toEqual(original);
      expect(catalogue.active.map((item) => item.name)).toEqual(["Original"]);
      expect([stale._tag, reheadered._tag, staleRead._tag]).toEqual(
        Array(3).fill("LibraryUnauthorized"),
      );
      expect(checks.every((entry) => entry.libraryId === "owner")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(world));
  },
);

it.effect(
  "denies absent, malformed and overflowing epoch metadata without an admission fallback",
  () => {
    const { world, checks } = makeWorld();

    return Effect.gen(function* () {
      const api = yield* LibraryApi.clientInProcess;
      const failures = [];

      for (const commandId of [
        undefined,
        "plain",
        "library:07:op",
        "library:-1:op",
        "library:9007199254740992:op",
        "library:7:",
        `library:7:${"x".repeat(129)}`,
      ]) {
        const denied = yield* api
          .ProposeSkill(LIBRARY_OWNER, { name: "Name", body: "" }, { commandId })
          .pipe(Effect.flip);

        failures.push(denied._tag);
      }

      for (const header of [undefined, "07", "-1", "1e3", "9007199254740992"]) {
        const denied = yield* api.Library.get(LIBRARY_OWNER, {
          headers: header === undefined ? {} : { "x-kitties-library-epoch": header },
        }).pipe(Effect.flip);

        failures.push(denied._tag);
      }

      expect(failures).toEqual(Array(12).fill("LibraryUnauthorized"));
      expect(checks).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(world));
  },
);

it.effect("unavailable recovery authority denies without executing a command", () => {
  const { world, control } = makeWorld();
  control.unavailable = true;

  return Effect.gen(function* () {
    const imports = yield* LibraryImportApi.clientInProcess;
    const denied = yield* finalize(imports).pipe(Effect.flip);
    const libraries = yield* Library;
    const state = yield* libraries.state(LIBRARY_OWNER);
    expect(denied._tag).toBe("LibraryUnauthorized");
    expect(state.importProgress._tag).toBe("Pending");
  }).pipe(Effect.scoped, Effect.provide(world));
});

it.effect(
  "rejects ambiguous payloads, unknown tags and public attempts to import before any admission",
  () => {
    const { world, checks } = makeWorld();

    return Effect.gen(function* () {
      const middleware = yield* LibrarySession;

      const options = {
        client: new Rpc.ServerClient(0),
        requestId: RpcMessage.RequestId("raw"),
        headers: Headers.fromInput(epochHeaders),
      };

      const errors = [];

      for (const value of [
        {
          rpc: ProposeSkill.rpc,
          payload: {
            target: "owner",
            key: "other/skill",
            commandId: "library:7:op",
            input: { name: "Name", body: "" },
          },
        },
        { rpc: Rpc.make("SkillDetail.get"), payload: { target: "owner", key: "owner/skill" } },
        { rpc: Rpc.make("FuturePrivate.get"), payload: { key: "owner" } },
        { rpc: FinalizeLibraryImport.rpc, payload: { target: "owner", commandId: "library:7:op" } },
      ]) {
        const denied = yield* middleware(Effect.die("Unauthorized handler executed"), {
          ...options,
          ...value,
        }).pipe(Effect.flip);

        errors.push(Schema.is(LibraryUnauthorized)(denied));
      }

      expect(errors).toEqual(Array(4).fill(true));
      expect(checks).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(world));
  },
);

it.effect(
  "provides immutable request scope to next and expires idle work even without emissions",
  () => {
    const { world } = makeWorld();

    return Effect.gen(function* () {
      const middleware = yield* LibrarySession;

      const observed = yield* Deferred.make<{
        libraryId: string;
        epoch: number;
        frozen: boolean;
      }>();

      const cleaned = yield* Deferred.make<void>();

      const next = Effect.gen(function* () {
        const scope = Option.getOrThrow(yield* Effect.serviceOption(LibraryRequestScope));
        yield* Deferred.succeed(observed, { ...scope, frozen: Object.isFrozen(scope) });

        return yield* Effect.never;
      }).pipe(Effect.ensuring(Deferred.succeed(cleaned, undefined)));

      const fiber = yield* middleware(next, {
        client: new Rpc.ServerClient(0),
        requestId: RpcMessage.RequestId("idle"),
        rpc: Rpc.make("Library.watch"),
        payload: { key: "owner" },
        headers: Headers.fromInput(epochHeaders),
      }).pipe(Effect.flip, Effect.forkChild);

      const scope = yield* Deferred.await(observed);
      yield* TestClock.adjust(10000);
      expect(yield* Deferred.isDone(cleaned)).toBe(true);

      const expired = yield* Fiber.join(fiber);
      yield* Deferred.await(cleaned);
      expect(scope).toEqual({ libraryId: "owner", epoch: 7, frozen: true });
      expect(Schema.is(LibraryUnauthorized)(expired)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(world));
  },
);

it.effect("a fresh scope is required after expiry", () =>
  Effect.gen(function* () {
    const expired = yield* awaitLibrarySessionExpiry({ ...session, expiresAt: 1 }).pipe(
      Effect.forkChild,
    );

    yield* TestClock.adjust(1);
    const failure = yield* Fiber.join(expired).pipe(Effect.flip);

    const old = yield* withinLibrarySession(
      { ...session, expiresAt: 1 },
      Effect.succeed("old"),
    ).pipe(Effect.flip);

    const fresh = yield* withinLibrarySession(
      { ...session, expiresAt: 1000 },
      Effect.succeed("fresh"),
    );

    expect([failure._tag, old._tag, fresh]).toEqual([
      "LibrarySessionExpired",
      "LibrarySessionExpired",
      "fresh",
    ]);
  }),
);

it.effect(
  "installed JSON codec strips ambiguous selectors by default and strict RPC options reject them",
  () =>
    Effect.gen(function* () {
      const raw = {
        target: "owner",
        key: "other/skill",
        commandId: "library:7:op",
        input: { name: "Name", body: "" },
      };

      const standard = yield* Schema.decodeUnknownEffect(
        Schema.toCodecJson(ProposeSkill.rpc.payloadSchema),
      )(raw);

      const strict = ProposeSkill.rpc.annotate(Rpc.ParseOptions, { onExcessProperty: "error" });

      const rejected = yield* Schema.decodeUnknownEffect(
        Schema.toCodecJson(strict.payloadSchema),
        Context.get(strict.annotations, Rpc.ParseOptions),
      )(raw).pipe(Effect.flip);

      const valid = yield* Schema.decodeUnknownEffect(
        Schema.toCodecJson(strict.payloadSchema),
        Context.get(strict.annotations, Rpc.ParseOptions),
      )({ target: "owner", commandId: "library:7:op", input: { name: "Name", body: "" } });

      expect(standard).toEqual({
        target: "owner",
        commandId: "library:7:op",
        input: { name: "Name", body: "" },
      });
      expect(rejected._tag).toBe("SchemaError");
      expect(valid).toEqual({
        target: "owner",
        commandId: "library:7:op",
        input: { name: "Name", body: "" },
      });
    }),
);

it.effect("checks owner and explicit epoch on every public catalogue and detail read path", () => {
  const { world } = makeWorld();

  return Effect.gen(function* () {
    const api = yield* LibraryApi.clientInProcess;
    const other = LibraryId.make("other");
    const key = SkillDetailKey.make("other/skill");

    const failures = yield* Effect.all([
      api.Library.get(other, { headers: epochHeaders }).pipe(Effect.flip),
      api.Library.watch(other, { headers: epochHeaders }).pipe(Stream.runHead, Effect.flip),
      api.Library.events(other, { headers: epochHeaders }).pipe(Stream.runHead, Effect.flip),
      api.SkillDetail.get(key, { headers: epochHeaders }).pipe(Effect.flip),
      api.SkillDetail.snapshot(key, { headers: epochHeaders }).pipe(Effect.flip),
      api.SkillDetail.list(key, { headers: epochHeaders }).pipe(Effect.flip),
      api.SkillDetail.watch(key, { headers: epochHeaders }).pipe(Stream.runHead, Effect.flip),
      api.SkillDetail.events(key, { headers: epochHeaders }).pipe(Stream.runHead, Effect.flip),
      api.Library.watch(LIBRARY_OWNER).pipe(Stream.runHead, Effect.flip),
      api.SkillDetail.watch(SkillDetailKey.make("owner/skill")).pipe(Stream.runHead, Effect.flip),
    ]);

    expect(failures.map((error) => error._tag)).toEqual(Array(10).fill("LibraryUnauthorized"));
  }).pipe(Effect.scoped, Effect.provide(world));
});

it.effect(
  "the private import session pins its grant, rejects owner commands and provides the exact scope",
  () => {
    const { world, checks } = makeWorld();

    return Effect.gen(function* () {
      const middleware = yield* LibraryImportSession;

      const options = {
        client: new Rpc.ServerClient(0),
        requestId: RpcMessage.RequestId("import"),
        headers: Headers.empty,
      };

      const stale = yield* middleware(Effect.die("Stale import executed"), {
        ...options,
        rpc: FinalizeLibraryImport.rpc,
        payload: { target: "owner", commandId: "library:8:import" },
      }).pipe(Effect.flip);

      const wrongAuthority = yield* middleware(Effect.die("Public command executed as importer"), {
        ...options,
        rpc: ProposeSkill.rpc,
        payload: { target: "owner", commandId: "library:7:import" },
      }).pipe(Effect.flip);

      const observed = yield* Deferred.make<{ libraryId: string; epoch: number }>();

      const next = Effect.gen(function* () {
        const scope = Option.getOrThrow(yield* Effect.serviceOption(LibraryRequestScope));
        yield* Deferred.succeed(observed, scope);

        return yield* Effect.never;
      });

      const fiber = yield* middleware(next, {
        ...options,
        rpc: FinalizeLibraryImport.rpc,
        payload: { target: "owner", commandId: "library:7:import" },
      }).pipe(Effect.forkChild);

      const scope = yield* Deferred.await(observed);
      yield* Fiber.interrupt(fiber);
      expect([
        Schema.is(LibraryUnauthorized)(stale),
        Schema.is(LibraryUnauthorized)(wrongAuthority),
      ]).toEqual([true, true]);
      expect(scope).toEqual({ libraryId: "owner", epoch: 7 });
      expect(checks).toEqual([{ libraryId: "owner", epoch: 7 }]);
    }).pipe(Effect.scoped, Effect.provide(world));
  },
);

it.effect(
  "the proposed body-stream deadline interrupts an idle pull and finalizes its upstream",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finalized = yield* Deferred.make<void>();

      const stream = Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(
        Stream.drain,
        Stream.concat(Stream.never),
        Stream.interruptWhen(awaitLibrarySessionExpiry({ ...session, expiresAt: 1000 })),
        Stream.onExit(() => Deferred.succeed(finalized, undefined)),
      );

      const fiber = yield* Stream.runDrain(stream).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust(1000);
      expect(yield* Deferred.isDone(finalized)).toBe(true);
      const expired = yield* Fiber.join(fiber);
      expect(expired._tag).toBe("LibrarySessionExpired");
    }),
);

it.effect("official Domain NDJSON watch emits a terminal denial at expiry while idle", () => {
  const { world } = makeWorld();

  return Effect.gen(function* () {
    const imports = yield* LibraryImportApi.clientInProcess;
    yield* finalize(imports);
    const api = yield* LibraryApi;

    const request = new Request(`${publicUrl}/v1/library/rpc`, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson", ...epochHeaders },
      body: '{"_tag":"Request","id":"owned-watch","tag":"Library.watch","payload":{"key":"owner"},"headers":[]}\n',
    });

    const response = yield* api.fetch.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request),
      ),
    );

    const body = Match.value(response.body).pipe(
      Match.tag("Stream", (value) => value.stream.pipe(Stream.orDie)),
      Match.orElse(() => Stream.die("Expected official streaming NDJSON body")),
    );

    const started = yield* Deferred.make<void>();
    const finalized = yield* Deferred.make<void>();
    const chunks: Array<Uint8Array> = [];

    const fiber = yield* Stream.runForEach(body, (bytes) =>
      Effect.gen(function* () {
        chunks.push(bytes);
        yield* Deferred.succeed(started, undefined);
      }),
    ).pipe(Effect.ensuring(Deferred.succeed(finalized, undefined)), Effect.forkChild);

    yield* Deferred.await(started);
    yield* TestClock.adjust(10000);
    expect(yield* Deferred.isDone(finalized)).toBe(true);
    yield* Fiber.join(fiber);
    const text = Buffer.concat(chunks).toString("utf8");

    const frames = text
      .trim()
      .split("\n")
      .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(line));

    expect(response.headers["content-type"]).toBe("application/x-ndjson");

    // Literal wire fixtures are independent of the production encoders and reducers.
    const expected = [
      '{"_tag":"Chunk","requestId":"owned-watch","values":[{"cursor":1,"state":{"active":[],"highWater":0,"catalogueRevision":1,"importProgress":{"_tag":"Finalized","inventoryId":"empty-v1","importedCount":0}}}]}',
      '{"_tag":"Exit","requestId":"owned-watch","exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"LibraryUnauthorized"}}]}}',
    ].map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(line));

    expect(frames).toEqual(expected);
  }).pipe(Effect.scoped, Effect.provide(world));
});
