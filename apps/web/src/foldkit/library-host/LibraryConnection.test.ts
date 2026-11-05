import * as InMemory from "@alchemy.run/domain/InMemory";
import { it } from "@effect/vitest";
import { NativeAccessAuthentication } from "@kitties/device/NativeAccessAuthentication";
import {
  NativeAccessPort,
  NativeHttpPort,
  layerNativeAccess,
} from "@kitties/device/NativeAccess.native";
import { FinalizeLibraryImport } from "@kitties/domain/Library/FinalizeLibraryImport.command";
import { Library } from "@kitties/domain/Library/Library.aggregate";
import { LibraryId } from "@kitties/domain/Library/Library.id";
import { LibraryModel } from "@kitties/domain/Library.model";
import { LibraryActor } from "@kitties/domain/LibraryActor.context";
import { LibraryApi } from "@kitties/domain/LibraryApi.api";
import { LibrarySession, LibraryUnauthorized } from "@kitties/domain/LibrarySession.middleware";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Ref, Schema, Stream } from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import { LibraryClientAuthentication } from "../library/LibraryClientAuthentication.ts";
import { LibraryClient } from "../library/client.ts";
import {
  LibraryConnection,
  LibraryConnectionError,
  LibraryConnectionTransport,
  LibraryHandshake,
} from "./LibraryConnection.ts";

const owner = LibraryId.make("owner");

const random = Layer.succeed(
  SecureRandom.SecureRandom,
  SecureRandom.make((size) => new Uint8Array(size).fill(7)),
);

const fixture = Effect.gen(function* () {
  const next = yield* Ref.make(
    LibraryHandshake.make({ libraryId: owner, epoch: 7, expiresAt: 10000 }),
  );

  const closed = yield* Ref.make(0);
  const headers = yield* Ref.make<ReadonlyArray<string>>([]);
  const memory = InMemory.make({ manual: true, now: () => 0 });
  const hosted = LibraryModel.layer(Layer.empty).pipe(Layer.provide(memory.layer));
  const domain = yield* Layer.buildWithScope(hosted, yield* Effect.scope);
  const libraries = Context.get(domain, Library);
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
        libraryId: owner,
        authority: "import",
        importFinalized: false,
      }),
    );

  const session = Layer.succeed(LibrarySession, (effect, request) =>
    Effect.gen(function* () {
      const epoch = request.headers["x-kitties-library-epoch"];
      yield* Ref.update(headers, (values) => [...values, `${request.rpc._tag}:${epoch}`]);

      if (epoch !== "7") return yield* new LibraryUnauthorized();

      return yield* effect.pipe(
        Effect.provideService(LibraryActor, {
          libraryId: owner,
          authority: "owner",
          importFinalized: true,
        }),
      );
    }),
  );

  const transport = Layer.succeed(LibraryConnectionTransport, {
    open: () =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Ref.update(closed, (value) => value + 1));
        const handshake = yield* Ref.get(next);

        const client = yield* LibraryApi.clientInProcess.pipe(
          Effect.provide(session),
          Effect.provide(domain),
        );

        return { client, handshake };
      }),
  });

  const layer = LibraryConnection.layer.pipe(Layer.provide(Layer.mergeAll(transport, random)));
  const context = yield* Layer.buildWithScope(layer, yield* Effect.scope);
  const middleware = yield* Layer.buildWithScope(session, yield* Effect.scope);

  return {
    connection: Context.get(context, LibraryConnection),
    authentication: Context.get(context, LibraryClientAuthentication),
    client: Context.get(context, LibraryApi.Client),
    server: Context.merge(domain, middleware),
    next,
    closed,
    headers,
  };
});

const WireProposal = Schema.Struct({
  tag: Schema.Literal("ProposeSkill"),
  payload: Schema.Struct({
    target: LibraryId,
    input: Schema.Struct({ name: Schema.String, body: Schema.String }),
    commandId: Schema.String,
  }),
});

// Official client/server and actual Domain receipts, with only delivery held.
const heldHttpFixture = Effect.gen(function* () {
  const world = yield* fixture;
  const committed = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const cleanupStarted = yield* Deferred.make<void>();
  const cleanupRelease = yield* Deferred.make<void>();
  const holdNext = yield* Ref.make(true);
  const payloads = yield* Ref.make<ReadonlyArray<typeof WireProposal.Type>>([]);

  const http = HttpClient.make((request, _url, signal) =>
    Effect.gen(function* () {
      if (request.url.endsWith("/session"))
        return HttpClientResponse.fromWeb(request, Response.json(yield* Ref.get(world.next)));

      const web = yield* HttpClientRequest.toWeb(request, { signal }).pipe(Effect.orDie);
      const text = yield* Effect.promise(() => web.clone().text());

      const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WireProposal))(
        text,
      ).pipe(Effect.orDie);

      yield* Ref.update(payloads, (values) => [...values, payload]);

      const body = yield* Effect.scoped(
        Effect.gen(function* () {
          const api = yield* LibraryApi;

          const response = yield* api.fetch.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(web),
            ),
          );

          const outgoing = HttpServerResponse.toWeb(response, { context: yield* Effect.context() });

          return yield* Effect.promise(() => outgoing.text());
        }).pipe(Effect.provide(world.server)),
      );

      if (yield* Ref.getAndSet(holdNext, false)) {
        yield* Deferred.succeed(committed, undefined);
        yield* Deferred.await(release).pipe(
          Effect.onInterrupt(() =>
            Deferred.succeed(cleanupStarted, undefined).pipe(
              Effect.andThen(Deferred.await(cleanupRelease)),
            ),
          ),
        );
      }

      return HttpClientResponse.fromWeb(
        request,
        new Response(body, {
          headers: { "content-type": "application/x-ndjson" },
        }),
      );
    }).pipe(Effect.orDie),
  );

  const transport = LibraryConnectionTransport.layerHttp(
    { origin: "https://library.example", allowLoopback: false },
    Effect.void,
  ).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)));

  const context = yield* Layer.buildWithScope(
    LibraryConnection.layer.pipe(Layer.provide(Layer.mergeAll(transport, random))),
    yield* Effect.scope,
  );

  return {
    context,
    connection: Context.get(context, LibraryConnection),
    authentication: Context.get(context, LibraryClientAuthentication),
    libraries: Context.get(world.server, Library),
    committed,
    release,
    cleanupStarted,
    cleanupRelease,
    payloads,
  };
});

const nativeOrigin = "https://library.example";
const nativeToken = "synthetic-private-native-token";
const providerDetail = "synthetic-private-provider-detail";

const nativeFixture = Effect.fnUntraced(function* (send: NativeHttpPort["Service"]["send"]) {
  const nativeLayer = layerNativeAccess.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(NativeAccessPort, {
          configuration: Effect.succeed({
            applicationUrl: nativeOrigin,
            issuer: "https://access.example",
          }),
          begin: Effect.succeed({ attemptId: "A".repeat(43) }),
          finish: () => Effect.succeed({ accessToken: nativeToken, expiresIn: 60 }),
          cancel: () => Effect.void,
        }),
        Layer.succeed(NativeHttpPort, { send }),
      ),
    ),
  );

  const native = yield* Layer.buildWithScope(nativeLayer, yield* Effect.scope);
  const authentication = Context.get(native, NativeAccessAuthentication);

  const transport = LibraryConnectionTransport.layerHttp(
    { origin: nativeOrigin, allowLoopback: false },
    authentication.authenticate.pipe(
      Effect.mapError(
        (error) =>
          new LibraryConnectionError({
            reason: error.reason === "Denied" ? "Denied" : "Unavailable",
          }),
      ),
    ),
  ).pipe(Layer.provide(Layer.succeedContext(native)));

  const context = yield* Layer.buildWithScope(
    LibraryConnection.layer.pipe(Layer.provide(Layer.mergeAll(transport, random))),
    yield* Effect.scope,
  );

  return { context, authentication, connection: Context.get(context, LibraryConnection) };
});

const nativeCases = [
  { reply: "Unauthorized", status: 401, handshake: "Denied", command: "Denied" },
  { reply: "Forbidden", status: 403, handshake: "Denied", command: "Denied" },
  { reply: "Unavailable", status: 0, handshake: "Unavailable", command: "Unknown" },
  { reply: "Redirect", status: 302, handshake: "Unavailable", command: "Unknown" },
  { reply: "ServiceUnavailable", status: 503, handshake: "Unavailable", command: "Unknown" },
];

const nativeReply = (status: number) =>
  status === 0
    ? Promise.reject(new Error(providerDetail))
    : Promise.resolve(new Response(providerDetail, { status }));

it.effect(
  "pins command and watch epochs and retains original receipt across client replacement",
  () =>
    Effect.gen(function* () {
      const world = yield* fixture;
      const scope = yield* world.connection.connect(false);
      const options = { commandId: `library:7:${scope.sessionId}:0` };

      const first = yield* world.client.ProposeSkill(
        owner,
        { name: "Original", body: "Remember me" },
        options,
      );

      yield* world.authentication.reauthenticate(scope);

      const replay = yield* world.client.ProposeSkill(
        owner,
        { name: "Changed retry", body: "Ignored" },
        options,
      );

      const watched = yield* world.client.Library.watch(owner).pipe(Stream.runHead);

      expect(replay).toEqual(first);
      expect(first.reply.skillId).toBe("kitties-skill-0000000000000001");
      expect(watched).toMatchObject({
        value: { state: { highWater: 1, active: [{ name: "Original" }] } },
      });
      expect(yield* Ref.get(world.closed)).toBe(1);
      expect(yield* Ref.get(world.headers)).toEqual([
        "ProposeSkill:7",
        "ProposeSkill:7",
        "Library.watch:7",
      ]);
      expect(yield* world.connection.connect(false)).toEqual(scope);
    }).pipe(Effect.scoped),
);

it.effect(
  "changed authority closes both clients and stays fenced on subsequent connect attempts",
  () =>
    Effect.gen(function* () {
      const world = yield* fixture;
      const scope = yield* world.connection.connect(false);
      yield* Ref.set(world.next, { libraryId: owner, epoch: 8, expiresAt: 10000 });
      const failure = yield* world.authentication.reauthenticate(scope).pipe(Effect.flip);

      expect(failure.reason).toBe("ChangedAuthority");
      expect(yield* Ref.get(world.closed)).toBe(2);
      expect((yield* world.client.Library.get(owner).pipe(Effect.flip))._tag).toBe(
        "LibraryUnauthorized",
      );
      expect((yield* world.connection.connect(true).pipe(Effect.flip)).reason).toBe(
        "ChangedAuthority",
      );
      expect(yield* Ref.get(world.headers)).toEqual([]);
    }).pipe(Effect.scoped),
);

it.effect(
  "absolute client expiry closes an idle watch and refuses new commands before sending",
  () =>
    Effect.gen(function* () {
      const world = yield* fixture;
      const scope = yield* world.connection.connect(false);
      const started = yield* Deferred.make<void>();
      const stopped = yield* Ref.make(false);

      const watcher = yield* world.client.Library.watch(owner).pipe(
        Stream.tap(() => Deferred.succeed(started, undefined)),
        Stream.runDrain,
        Effect.ensuring(Ref.set(stopped, true)),
        Effect.flip,
        Effect.forkChild,
      );

      yield* Deferred.await(started);
      yield* TestClock.adjust(10000);

      expect((yield* Fiber.join(watcher))._tag).toBe("LibraryUnauthorized");
      expect(yield* Ref.get(stopped)).toBe(true);

      const command = yield* LibraryClient.ProposeSkill({
        target: owner,
        input: { name: "Too late", body: "" },
        commandId: `library:7:${scope.sessionId}:0`,
      }).effect.pipe(Effect.provideService(LibraryApi.Client, world.client));

      expect(command._tag).toBe("FailedProposeSkill");
      expect(command).toHaveProperty("failure._tag", "Denied");
      expect(yield* Ref.get(world.headers)).toEqual(["Library.watch:7"]);
    }).pipe(Effect.scoped),
);

it.effect(
  "official HTTP 403 becomes a declared denial while 503 remains an unknown command outcome",
  () =>
    Effect.gen(function* () {
      const status = yield* Ref.make(403);

      const http = HttpClient.make((request) =>
        Ref.get(status).pipe(
          Effect.map((code) =>
            HttpClientResponse.fromWeb(
              request,
              request.url.endsWith("/session")
                ? Response.json({ libraryId: "owner", epoch: 7, expiresAt: 10000 })
                : new Response("", { status: code }),
            ),
          ),
        ),
      );

      const transport = LibraryConnectionTransport.layerHttp(
        { origin: "https://library.example", allowLoopback: false },
        Effect.void,
      ).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)));

      const context = yield* Layer.buildWithScope(
        LibraryConnection.layer.pipe(Layer.provide(Layer.mergeAll(transport, random))),
        yield* Effect.scope,
      );

      const connection = Context.get(context, LibraryConnection);
      const scope = yield* connection.connect(false);

      const command = LibraryClient.ProposeSkill({
        target: owner,
        input: { name: "Pending", body: "" },
        commandId: `library:7:${scope.sessionId}:0`,
      }).effect.pipe(Effect.provide(context));

      const denied = yield* command;
      expect(denied._tag).toBe("FailedProposeSkill");
      expect(denied).toHaveProperty("failure._tag", "Denied");
      yield* Ref.set(status, 503);
      const unknown = yield* command;
      expect(unknown._tag).toBe("FailedProposeSkill");
      expect(unknown).toHaveProperty("failure._tag", "Unknown");
    }).pipe(Effect.scoped),
);

it.effect(
  "HTTP reauthentication reports an interrupted pending command as unknown and replays its original receipt",
  () =>
    Effect.gen(function* () {
      const world = yield* heldHttpFixture;
      const scope = yield* world.connection.connect(false);

      const request = {
        target: owner,
        input: { name: "Original", body: "Keep this intent" },
        commandId: `library:7:${scope.sessionId}:0`,
      };

      const command = LibraryClient.ProposeSkill(request).effect.pipe(
        Effect.provide(world.context),
      );

      const pending = yield* command.pipe(Effect.forkChild);
      yield* Deferred.await(world.committed);

      const replacement = yield* world.authentication.reauthenticate(scope).pipe(Effect.forkChild);
      yield* Deferred.await(world.cleanupStarted);
      yield* Deferred.succeed(world.cleanupRelease, undefined);
      yield* Fiber.join(replacement);
      const interrupted = yield* Fiber.join(pending);

      expect(interrupted._tag).toBe("FailedProposeSkill");
      expect(interrupted).toHaveProperty("failure._tag", "Unknown");
      expect(interrupted.commandId).toBe(request.commandId);

      const replay = yield* command;
      expect(replay._tag).toBe("SucceededProposeSkill");
      expect(replay).toMatchObject({
        commandId: request.commandId,
        reply: { skillId: "kitties-skill-0000000000000001", proposalRevision: 2 },
        receipt: { stream: "Library/owner", version: 2 },
      });
      expect(yield* Ref.get(world.payloads)).toEqual([
        { tag: "ProposeSkill", payload: request },
        { tag: "ProposeSkill", payload: request },
      ]);
      expect((yield* world.libraries.state(owner)).highWater).toBe(1);
    }).pipe(Effect.scoped),
);

it.effect("ordinary HTTP caller cancellation stays interrupted without reauthentication", () =>
  Effect.gen(function* () {
    const world = yield* heldHttpFixture;
    const scope = yield* world.connection.connect(false);

    const pending = yield* LibraryClient.ProposeSkill({
      target: owner,
      input: { name: "Pending", body: "" },
      commandId: `library:7:${scope.sessionId}:0`,
    }).effect.pipe(Effect.provide(world.context), Effect.forkChild);

    yield* Deferred.await(world.committed);

    const cancellation = yield* Fiber.interrupt(pending).pipe(Effect.forkChild);
    yield* Deferred.await(world.cleanupStarted);
    yield* Deferred.succeed(world.cleanupRelease, undefined);
    yield* Fiber.join(cancellation);
    const exit = yield* Fiber.await(pending);

    expect(Exit.isFailure(exit)).toBe(true);
    expect(Exit.match(exit, { onSuccess: () => false, onFailure: Cause.hasInterruptsOnly })).toBe(
      true,
    );
    expect(
      Exit.match(exit, {
        onSuccess: () => [],
        onFailure: (cause) => Array.from(Cause.interruptors(cause)),
      }),
    ).toContain(cancellation.id);
    expect((yield* Ref.get(world.payloads)).length).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("caller cancellation during HTTP replacement cleanup stays interrupted", () =>
  Effect.gen(function* () {
    const world = yield* heldHttpFixture;
    const scope = yield* world.connection.connect(false);

    const pending = yield* LibraryClient.ProposeSkill({
      target: owner,
      input: { name: "Pending", body: "" },
      commandId: `library:7:${scope.sessionId}:0`,
    }).effect.pipe(Effect.provide(world.context), Effect.forkChild);

    yield* Deferred.await(world.committed);

    const replacement = yield* world.authentication.reauthenticate(scope).pipe(Effect.forkChild);
    yield* Deferred.await(world.cleanupStarted);

    // Start interruption before releasing cleanup; no scheduling delay is used.
    const cancellation = yield* Fiber.interrupt(pending).pipe(
      Effect.forkChild({ startImmediately: true }),
    );

    yield* Deferred.succeed(world.cleanupRelease, undefined);
    yield* Fiber.join(cancellation);
    yield* Fiber.join(replacement);
    const exit = yield* Fiber.await(pending);

    expect(Exit.isFailure(exit)).toBe(true);
    expect(Exit.match(exit, { onSuccess: () => false, onFailure: Cause.hasInterruptsOnly })).toBe(
      true,
    );
    expect(
      Exit.match(exit, {
        onSuccess: () => [],
        onFailure: (cause) => Array.from(Cause.interruptors(cause)),
      }),
    ).toContain(cancellation.id);
    expect((yield* Ref.get(world.payloads)).length).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("an HTTP 503 received at session expiry remains an unknown command outcome", () =>
  Effect.gen(function* () {
    const sent = yield* Deferred.make<void>();
    const reply = yield* Deferred.make<void>();

    const http = HttpClient.make((request) =>
      request.url.endsWith("/session")
        ? Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                libraryId: "owner",
                epoch: 7,
                expiresAt: 5000,
              }),
            ),
          )
        : Deferred.succeed(sent, undefined).pipe(
            Effect.andThen(Deferred.await(reply)),
            Effect.as(HttpClientResponse.fromWeb(request, new Response("", { status: 503 }))),
          ),
    );

    const transport = LibraryConnectionTransport.layerHttp(
      { origin: "https://library.example", allowLoopback: false },
      Effect.void,
    ).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)));

    const context = yield* Layer.buildWithScope(
      LibraryConnection.layer.pipe(Layer.provide(Layer.mergeAll(transport, random))),
      yield* Effect.scope,
    );

    const scope = yield* Context.get(context, LibraryConnection).connect(false);

    const pending = yield* LibraryClient.ProposeSkill({
      target: owner,
      input: { name: "Pending", body: "" },
      commandId: `library:7:${scope.sessionId}:0`,
    }).effect.pipe(Effect.provide(context), Effect.forkChild);

    yield* Deferred.await(sent);
    yield* TestClock.adjust(5000);
    yield* Deferred.succeed(reply, undefined);
    const outcome = yield* Fiber.join(pending);

    expect(outcome._tag).toBe("FailedProposeSkill");
    expect(outcome).toHaveProperty("failure._tag", "Unknown");
  }).pipe(Effect.scoped),
);

for (const testCase of nativeCases) {
  it.effect(
    `composed native handshake classifies ${testCase.reply} without retaining credentials`,
    () =>
      Effect.gen(function* () {
        const world = yield* nativeFixture(() => nativeReply(testCase.status));
        const failure = yield* world.connection.connect(true).pipe(Effect.flip);

        expect(failure.reason).toBe(testCase.handshake);
        expect(JSON.stringify(failure)).not.toContain(nativeToken);
        expect(JSON.stringify(failure)).not.toContain(providerDetail);
      }).pipe(Effect.scoped),
  );

  it.effect(
    `composed native RPC classifies ${testCase.reply} through the official HTTP client`,
    () =>
      Effect.gen(function* () {
        const world = yield* nativeFixture((url) =>
          url.endsWith("/session")
            ? Promise.resolve(Response.json({ libraryId: "owner", epoch: 7, expiresAt: 10000 }))
            : nativeReply(testCase.status),
        );

        const scope = yield* world.connection.connect(true);
        const commandId = `library:7:${scope.sessionId}:0`;

        const outcome = yield* LibraryClient.ProposeSkill({
          target: owner,
          input: { name: "Pending", body: "" },
          commandId,
        }).effect.pipe(Effect.provide(world.context));

        expect(outcome._tag).toBe("FailedProposeSkill");
        expect(outcome).toHaveProperty("failure._tag", testCase.command);
        expect(outcome.commandId).toBe(commandId);
        expect(JSON.stringify(outcome)).not.toContain(nativeToken);
        expect(JSON.stringify(outcome)).not.toContain(providerDetail);
      }).pipe(Effect.scoped),
  );
}

it.effect("native credential cancellation remains unavailable at the handshake boundary", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const reply = yield* Deferred.make<Response>();

    const world = yield* nativeFixture(() =>
      Effect.runPromise(
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(reply))),
      ),
    );

    const pending = yield* world.connection.connect(true).pipe(Effect.flip, Effect.forkChild);

    yield* Deferred.await(started);
    yield* world.authentication.clear;
    yield* Deferred.succeed(reply, new Response(providerDetail));
    const failure = yield* Fiber.join(pending);

    expect(failure.reason).toBe("Unavailable");
    expect(JSON.stringify(failure)).not.toContain(nativeToken);
    expect(JSON.stringify(failure)).not.toContain(providerDetail);
  }).pipe(Effect.scoped),
);

it.effect("native credential cancellation remains an unknown RPC outcome", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const reply = yield* Deferred.make<Response>();

    const world = yield* nativeFixture((url) =>
      url.endsWith("/session")
        ? Promise.resolve(Response.json({ libraryId: "owner", epoch: 7, expiresAt: 10000 }))
        : Effect.runPromise(
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(reply))),
          ),
    );

    const scope = yield* world.connection.connect(true);
    const commandId = `library:7:${scope.sessionId}:0`;

    const pending = yield* LibraryClient.ProposeSkill({
      target: owner,
      input: { name: "Pending", body: "" },
      commandId,
    }).effect.pipe(Effect.provide(world.context), Effect.forkChild);

    yield* Deferred.await(started);
    yield* world.authentication.clear;
    yield* Deferred.succeed(reply, new Response(providerDetail));
    const outcome = yield* Fiber.join(pending);

    expect(outcome._tag).toBe("FailedProposeSkill");
    expect(outcome).toHaveProperty("failure._tag", "Unknown");
    expect(outcome.commandId).toBe(commandId);
    expect(JSON.stringify(outcome)).not.toContain(nativeToken);
    expect(JSON.stringify(outcome)).not.toContain(providerDetail);
  }).pipe(Effect.scoped),
);
