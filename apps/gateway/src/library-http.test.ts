import * as InMemory from "@alchemy.run/domain/InMemory";
import { Platform } from "@alchemy.run/domain/Platform";
import { it } from "@effect/vitest";
import { LibraryModel } from "@kitties/domain/Library.model";
import { LibraryImportApi } from "@kitties/domain/LibraryImport.api";
import { LibraryApi } from "@kitties/domain/LibraryApi.api";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import { AccessAssertionRejected, AccessJwtVerifier } from "./access-jwt.ts";
import { LibraryHttp, libraryHttpLayer } from "./library-http.ts";
import {
  LIBRARY_OWNER,
  LibraryEpochSource,
  LibraryAdmission,
  LibraryAdmissionDenied,
  LibraryAdmissionUnavailable,
  LibraryImportGrant,
  LibraryImportSessionLive,
  LibraryRequestScope,
  libraryAuthenticationLayer,
} from "./library-session.ts";

const publicUrl = "https://kitties.example";

const config = {
  rpcPath: "/v1/library/rpc",
  sessionPath: "/v1/library/session",
  authorityTimeoutMs: 500,
};

const json = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const watch =
  '{"_tag":"Request","id":"watch","tag":"Library.watch","payload":{"key":"owner"},"headers":[]}\n';

const propose =
  '{"_tag":"Request","id":"propose","tag":"ProposeSkill","payload":{"target":"owner","input":{"name":"Original","body":"Keep"},"commandId":"library:7:session:0"},"headers":[]}\n';

const get =
  '{"_tag":"Request","id":"get","tag":"Library.get","payload":{"key":"owner"},"headers":[]}\n';

const request = (body: string, headers: Record<string, string> = {}) =>
  new Request(`${publicUrl}${config.rpcPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-ndjson",
      "Cf-Access-Jwt-Assertion": "signed-owner",
      origin: publicUrl,
      "x-kitties-library-epoch": "7",
      ...headers,
    },
    body,
  });

const handshake = () =>
  new Request(`${publicUrl}${config.sessionPath}`, {
    headers: { "Cf-Access-Jwt-Assertion": "signed-owner" },
  });

const makeWorld = () => {
  const memory = InMemory.make({ manual: true, now: () => 0 });
  const checks: Array<{ libraryId: string; epoch: number }> = [];

  const scopes: Array<{ closed: boolean }> = [];
  const reads: Array<unknown> = [];
  const observed = { live: 0, closed: 0, scopes, reads };

  const control = { epoch: 7, expiresAt: 10000, unavailable: false, fenced: false, blocked: false };

  const platform = Layer.effect(
    Platform,
    Effect.gen(function* () {
      const base = yield* Platform;
      const marked = new WeakSet<Scope.Scope>();

      return Platform.of({
        model: (model) =>
          base.model(model).pipe(
            Effect.map((host) => ({
              ...host,
              aggregate: (aggregate, kit) =>
                host.aggregate(aggregate, kit).pipe(
                  Effect.map((store) => ({
                    ...store,
                    state: Effect.fnUntraced(function* (id) {
                      const scope = yield* Effect.serviceOption(Scope.Scope);
                      const requestScope = yield* Effect.serviceOption(LibraryRequestScope);
                      observed.reads.push(Option.getOrUndefined(requestScope));

                      if (Option.isSome(scope) && !marked.has(scope.value)) {
                        marked.add(scope.value);
                        const entry = { closed: false };
                        observed.scopes.push(entry);
                        yield* Scope.addFinalizer(
                          scope.value,
                          Effect.sync(() => {
                            entry.closed = true;
                          }),
                        );
                      }

                      return yield* store.state(id);
                    }),
                    changes: (id) =>
                      store.changes(id).pipe(
                        Stream.onStart(
                          Effect.sync(() => {
                            observed.live++;
                          }),
                        ),
                        Stream.onExit(() =>
                          Effect.sync(() => {
                            observed.live--;
                            observed.closed++;
                          }),
                        ),
                      ),
                  })),
                ),
            })),
          ),
      });
    }),
  ).pipe(Layer.provideMerge(memory.layer));

  const host = LibraryModel.layer(Layer.empty).pipe(Layer.provide(platform));

  const verifier = Layer.succeed(AccessJwtVerifier, {
    verify: Effect.fnUntraced(function* (outer) {
      if (outer.headers.get("Cf-Access-Jwt-Assertion") !== "signed-owner")
        return yield* new AccessAssertionRejected();

      return { email: "owner@example.test", expiresAt: control.expiresAt };
    }),
  });

  const auth = libraryAuthenticationLayer({
    publicUrl,
    issuer: "https://fixture.cloudflareaccess.com",
    audience: "fixture",
    ownerEmail: "owner@example.test",
    nativeOrigins: ["tauri://localhost"],
  }).pipe(Layer.provide(verifier));

  const dependencies = Layer.mergeAll(
    auth,
    Layer.succeed(LibraryEpochSource, {
      current: Effect.fnUntraced(function* () {
        if (control.blocked) return yield* Effect.never;

        if (control.unavailable) return yield* new LibraryAdmissionUnavailable();

        return control.epoch;
      }),
    }),
    Layer.succeed(LibraryAdmission, {
      check: Effect.fnUntraced(function* (scope) {
        checks.push({ ...scope });

        if (control.unavailable) return yield* new LibraryAdmissionUnavailable();

        if (control.fenced || scope.epoch !== control.epoch)
          return yield* new LibraryAdmissionDenied();
      }),
    }),
    Layer.succeed(LibraryImportGrant, { libraryId: LIBRARY_OWNER, epoch: 7 }),
  );

  const world = Layer.mergeAll(libraryHttpLayer(config), LibraryImportSessionLive).pipe(
    Layer.provideMerge(host),
    Layer.provide(dependencies),
  );

  const finalize = Effect.gen(function* () {
    const imports = yield* LibraryImportApi.clientInProcess;
    yield* imports.FinalizeLibraryImport(
      LIBRARY_OWNER,
      { inventoryId: "empty-v1", expectedImportedCount: 0, expectedHighWater: 0 },
      { commandId: "library:7:finalize" },
    );
    checks.length = 0;
    observed.reads.length = 0;
    observed.scopes.length = 0;
  });

  return { world, checks, observed, control, finalize, commits: memory.control.commits };
};

const route = (outer: Request) =>
  Effect.gen(function* () {
    const app = yield* LibraryHttp;
    const response = yield* app.route(outer);

    if (response === undefined) return yield* Effect.die("Expected owned Library route");

    return response;
  });

const bytes = (response: HttpServerResponse.HttpServerResponse) =>
  Match.value(response.body).pipe(
    Match.tag("Stream", (body) => body.stream.pipe(Stream.orDie)),
    Match.tag("Uint8Array", (body) => Stream.succeed(body.body)),
    Match.orElse(() => Stream.die("Expected NDJSON or JSON byte body")),
  );

const text = (response: HttpServerResponse.HttpServerResponse) =>
  bytes(response).pipe(
    Stream.runCollect,
    Effect.map((chunks) => Buffer.concat(chunks).toString("utf8")),
  );

const frames = (response: HttpServerResponse.HttpServerResponse) =>
  text(response).pipe(
    Effect.map((value) =>
      value
        .trim()
        .split("\n")
        .map((line) => json(line)),
    ),
  );

it.effect(
  "handshake exposes only verified owner, authoritative epoch and exact expiry after finalization",
  () => {
    const { world, checks, observed, finalize } = makeWorld();

    return Effect.gen(function* () {
      const pending = yield* route(handshake());
      expect(pending.status).toBe(409);
      expect(json(yield* text(pending))).toEqual({ code: "LIBRARY_IMPORT_REQUIRED" });
      yield* finalize;
      const response = yield* route(handshake());
      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(json(yield* text(response))).toEqual({
        libraryId: "owner",
        epoch: 7,
        expiresAt: 10000,
      });
      expect(checks).toEqual([{ libraryId: "owner", epoch: 7 }]);
      expect(observed.reads).toEqual([{ libraryId: "owner", epoch: 7 }]);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(world));
  },
);

for (const [mode, status, code] of [
  ["fenced", 409, "LIBRARY_RECOVERY_FENCED"],
  ["unavailable", 503, "LIBRARY_RECOVERY_UNAVAILABLE"],
] as const) {
  it.effect(`handshake fails closed when recovery is ${mode}`, () => {
    const { world, control, observed } = makeWorld();
    control[mode] = true;

    return Effect.gen(function* () {
      const response = yield* route(handshake());
      expect(response.status).toBe(status);
      expect(json(yield* text(response))).toEqual({ code });
      expect(observed.reads).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(world));
  });
}

it.effect("blocked handshake authority has a finite deadline", () => {
  const { world, control } = makeWorld();
  control.blocked = true;

  return Effect.gen(function* () {
    const fiber = yield* route(handshake()).pipe(Effect.forkChild);
    yield* TestClock.adjust(500);
    const response = yield* Fiber.join(fiber);
    expect(response.status).toBe(503);
    expect(json(yield* text(response))).toEqual({ code: "LIBRARY_RECOVERY_UNAVAILABLE" });
  }).pipe(Effect.scoped, Effect.provide(world));
});

it.effect(
  "actual strict RPC rejects an ambiguous raw payload before middleware or receipt lookup",
  () => {
    const { world, finalize, checks, commits } = makeWorld();

    return Effect.gen(function* () {
      yield* finalize;

      const response = yield* route(
        request(propose.replace('"target":"owner"', '"target":"owner","key":"other/skill"')),
      );

      const messages = JSON.stringify(yield* frames(response));
      expect(messages).toContain("Expected no excess property");
      expect(messages).toContain("key");
      expect(checks).toEqual([]);
      expect(commits).toEqual([{ aggregate: "Library", id: "owner", index: 0 }]);
    }).pipe(Effect.scoped, Effect.provide(world));
  },
);

it.effect("official NDJSON keeps original command receipts and reads the actual catalogue", () => {
  const { world, finalize } = makeWorld();

  return Effect.gen(function* () {
    yield* finalize;
    const original = yield* route(request(propose)).pipe(Effect.flatMap(frames));

    const retry = yield* route(request(propose.replace("Original", "Changed"))).pipe(
      Effect.flatMap(frames),
    );

    const expected = json(
      '{"_tag":"Exit","requestId":"propose","exit":{"_tag":"Success","value":{"reply":{"skillId":"kitties-skill-0000000000000001","proposalRevision":2},"stream":"Library/owner","version":2}}}',
    );

    expect(original).toEqual([expected]);
    expect(retry).toEqual([expected]);
    const read = yield* route(request(get)).pipe(Effect.flatMap(frames));
    expect(read).toEqual([
      json(
        '{"_tag":"Exit","requestId":"get","exit":{"_tag":"Success","value":{"active":[{"id":"kitties-skill-0000000000000001","name":"Original","status":"proposed","createdAt":0,"updatedAt":0,"proposalRevision":2,"detailRevision":2}],"highWater":1,"catalogueRevision":2,"importProgress":{"_tag":"Finalized","inventoryId":"empty-v1","importedCount":0}}}}',
      ),
    ]);
  }).pipe(Effect.scoped, Effect.provide(world));
});

it.effect("official clientHttp default URL reaches the single trailing-slash RPC alias", () => {
  const { world, finalize } = makeWorld();

  return Effect.gen(function* () {
    yield* finalize;
    const app = yield* LibraryHttp;
    const scope = yield* Effect.scope;
    const paths: Array<string> = [];

    const transport = HttpClient.make((outgoing, _url, signal) =>
      Effect.gen(function* () {
        const outer = yield* HttpClientRequest.toWeb(
          HttpClientRequest.setHeaders(outgoing, {
            "Cf-Access-Jwt-Assertion": "signed-owner",
            origin: publicUrl,
            "x-kitties-library-epoch": "7",
          }),
          { signal },
        );

        paths.push(new URL(outer.url).pathname);
        const response = yield* app.route(outer);

        if (response === undefined) return yield* Effect.die("Official client URL was not routed");

        return HttpClientResponse.fromWeb(
          outgoing,
          HttpServerResponse.toWeb(response, { context: yield* Effect.context() }),
        );
      }).pipe(Scope.provide(scope), Effect.orDie),
    );

    const client = yield* LibraryApi.clientHttp(`${publicUrl}${config.rpcPath}`).pipe(
      Effect.provideService(HttpClient.HttpClient, transport),
    );

    const receipt = yield* client.ProposeSkill(
      LIBRARY_OWNER,
      { name: "Official", body: "Native" },
      { commandId: "library:7:official:0" },
    );

    expect(receipt).toEqual({
      reply: { skillId: "kitties-skill-0000000000000001", proposalRevision: 2 },
      stream: "Library/owner",
      version: 2,
    });
    expect(paths).toEqual(["/v1/library/rpc/"]);
  }).pipe(Effect.scoped, Effect.provide(world));
});

it.effect("the RPC slash alias retains authentication, query, method and upgrade checks", () => {
  const { world, finalize } = makeWorld();

  return Effect.gen(function* () {
    yield* finalize;
    const alias = `${publicUrl}${config.rpcPath}/`;
    const normal = request(propose);

    for (const [outer, status] of [
      [new Request(alias, { method: "OPTIONS" }), 405],
      [new Request(alias, { headers: { upgrade: "websocket" } }), 426],
      [new Request(`${alias}?x=1`, normal), 400],
      [
        new Request(alias, {
          method: "POST",
          headers: { "content-type": "application/x-ndjson" },
          body: propose,
        }),
        403,
      ],
      [new Request(alias, request(propose, { origin: "https://attacker.example" })), 403],
    ] as const) {
      expect((yield* route(outer)).status).toBe(status);
    }

    const app = yield* LibraryHttp;
    expect(yield* app.route(new Request(`${alias}/`, normal))).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(world));
});

for (const [name, headers] of [
  ["missing outer assertion despite inner forged assertion", { "Cf-Access-Jwt-Assertion": "" }],
  [
    "foreign browser origin with invented bearer",
    {
      origin: "https://evil.example",
      authorization: "Bearer fabricated",
      cookie: "CF_Authorization=victim",
    },
  ],
] as const) {
  it.effect(`route denies ${name} before any Library access`, () => {
    const { world, checks, observed } = makeWorld();

    return Effect.gen(function* () {
      const forged = get.replace(
        '"headers":[]',
        '"headers":[["Cf-Access-Jwt-Assertion","signed-owner"]]',
      );

      const response = yield* route(request(forged, headers));
      expect(response.status).toBe(403);
      expect(json(yield* text(response))).toEqual({ code: "LIBRARY_ACCESS_DENIED" });
      expect(checks).toEqual([]);
      expect(observed.reads).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(world));
  });
}

it.effect("native request still authenticates its signed assertion", () => {
  const { world, finalize } = makeWorld();

  return Effect.gen(function* () {
    yield* finalize;
    const outer = request(get, { authorization: "Bearer opaque", origin: "tauri://localhost" });
    const response = yield* route(outer);
    expect(response.status).toBe(200);
    expect(JSON.stringify(yield* frames(response))).toContain('"_tag":"Success"');
  }).pipe(Effect.scoped, Effect.provide(world));
});

it.effect("expired verified identity cannot start HTTP RPC or handshake", () => {
  const { world, control, checks } = makeWorld();

  return Effect.gen(function* () {
    yield* TestClock.adjust(10000);
    control.expiresAt = 10000;

    const statuses = yield* Effect.forEach([request(get), handshake()], (outer) =>
      route(outer).pipe(Effect.map((response) => response.status)),
    );

    expect(statuses).toEqual([403, 403]);
    expect(checks).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(world));
});

for (const [name, path, method, headers, status] of [
  ["WebSocket", config.rpcPath, "GET", { upgrade: "websocket" }, 426],
  ["OPTIONS", config.rpcPath, "OPTIONS", {}, 405],
  ["handshake POST", config.sessionPath, "POST", {}, 405],
  ["RPC GET", config.rpcPath, "GET", {}, 405],
  ["query", `${config.rpcPath}?epoch=7`, "POST", {}, 400],
  ["SSE adapter media", config.rpcPath, "POST", { "content-type": "text/event-stream" }, 415],
] as const) {
  it.effect(`rejects ${name} without CORS or model access`, () => {
    const { world, checks, observed } = makeWorld();

    return Effect.gen(function* () {
      const response = yield* route(
        new Request(`${publicUrl}${path}`, {
          method,
          headers: { "Cf-Access-Jwt-Assertion": "signed-owner", origin: publicUrl, ...headers },
        }),
      );

      expect(response.status).toBe(status);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(checks).toEqual([]);
      expect(observed.reads).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(world));
  });
}

it.effect("unowned paths fall through to the root application", () => {
  const { world, checks } = makeWorld();

  return Effect.gen(function* () {
    const app = yield* LibraryHttp;
    expect(yield* app.route(new Request(`${publicUrl}/api/turns`))).toBeUndefined();
    expect(checks).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(world));
});

it.effect(
  "idle NDJSON body expires and closes its RPC scope while the request scope stays owned by the server",
  () => {
    const { world, finalize, observed } = makeWorld();

    return Effect.gen(function* () {
      yield* finalize;
      const parent = yield* Scope.fork(yield* Effect.scope);
      const response = yield* route(request(watch)).pipe(Scope.provide(parent));
      const initial = yield* Deferred.make<void>();
      const parentClosed = yield* Deferred.make<void>();
      yield* Scope.addFinalizer(parent, Deferred.succeed(parentClosed, undefined));
      const chunks: Array<Uint8Array> = [];

      const reader = yield* bytes(response).pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            chunks.push(chunk);
            yield* Deferred.succeed(initial, undefined);
          }),
        ),
        Effect.exit,
        Effect.forkChild,
      );

      yield* Deferred.await(initial);
      expect(observed.live).toBe(1);
      expect(observed.scopes.every((scope) => !scope.closed)).toBe(true);
      yield* TestClock.adjust(10000);
      yield* Fiber.join(reader);
      expect(observed.live).toBe(0);
      expect(observed.closed).toBe(1);
      expect(observed.scopes.every((scope) => scope.closed)).toBe(true);
      expect(yield* Deferred.isDone(parentClosed)).toBe(false);
      expect(Buffer.concat(chunks).toString()).toContain('"_tag":"Chunk"');
      yield* Scope.close(parent, Exit.void);
      expect(yield* Deferred.isDone(parentClosed)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(world));
  },
);

it.effect("an unread response still releases its RPC server at the absolute deadline", () => {
  const { world, finalize, observed } = makeWorld();

  return Effect.gen(function* () {
    yield* finalize;
    yield* route(request(watch));
    expect(observed.live).toBe(1);
    yield* TestClock.adjust(10000);
    expect(observed.live).toBe(0);
    expect(observed.scopes.length).toBeGreaterThan(0);
    expect(observed.scopes.every((scope) => scope.closed)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(world));
});

it.effect("body cancellation closes the RPC child promptly and causes no later cleanup", () => {
  const { world, finalize, observed } = makeWorld();

  return Effect.gen(function* () {
    yield* finalize;
    const response = yield* route(request(watch));
    yield* bytes(response).pipe(Stream.take(1), Stream.runDrain, Effect.scoped);
    expect(observed.live).toBe(0);
    expect(observed.closed).toBe(1);
    expect(observed.scopes.every((scope) => scope.closed)).toBe(true);
    yield* TestClock.adjust(10000);
    expect(observed.closed).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(world));
});

it.effect(
  "official HTTP server transfers the request scope until its NDJSON body completes",
  () => {
    const { world, finalize, observed } = makeWorld();

    return Effect.gen(function* () {
      yield* finalize;
      const app = yield* LibraryHttp;
      const outer = request(watch);
      const requestClosed = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<HttpServerResponse.HttpServerResponse>();
      yield* HttpEffect.toHandled(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Deferred.succeed(requestClosed, undefined));
          const response = yield* app.route(outer);

          if (response === undefined) return yield* Effect.die("Expected Library route");

          return response;
        }),
        (_request, response) =>
          Deferred.succeed(delivered, HttpEffect.scopeTransferToStream(response)),
      ).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(outer),
        ),
      );
      const transferred = yield* Deferred.await(delivered);
      expect(yield* Deferred.isDone(requestClosed)).toBe(false);
      yield* bytes(transferred).pipe(Stream.take(1), Stream.runDrain, Effect.scoped);
      expect(yield* Deferred.isDone(requestClosed)).toBe(true);
      expect(observed.live).toBe(0);
      expect(observed.scopes.every((scope) => scope.closed)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(world));
  },
);

it.effect("a fresh authenticated transport cannot adopt a command from an old epoch", () => {
  const { world, finalize, control, checks, commits } = makeWorld();

  return Effect.gen(function* () {
    yield* finalize;
    control.epoch = 8;
    const response = yield* route(request(propose, { "x-kitties-library-epoch": "8" }));
    expect(yield* frames(response)).toEqual([
      json(
        '{"_tag":"Exit","requestId":"propose","exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"LibraryUnauthorized"}}]}}',
      ),
    ]);
    expect(checks).toEqual([]);
    expect(commits).toEqual([{ aggregate: "Library", id: "owner", index: 0 }]);
  }).pipe(Effect.scoped, Effect.provide(world));
});

it.effect("an authenticated owner cannot read another owner through HTTP selectors", () => {
  const { world, finalize, checks, observed } = makeWorld();

  return Effect.gen(function* () {
    yield* finalize;
    const response = yield* route(request(get.replace('"key":"owner"', '"key":"other"')));
    expect(yield* frames(response)).toEqual([
      json(
        '{"_tag":"Exit","requestId":"get","exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"LibraryUnauthorized"}}]}}',
      ),
    ]);
    expect(checks).toEqual([]);
    expect(observed.reads).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(world));
});

it.effect("reauthentication creates a fresh scope without extending an older idle watch", () => {
  const { world, finalize, control, observed } = makeWorld();

  return Effect.gen(function* () {
    yield* finalize;
    const old = yield* route(request(watch));
    control.expiresAt = 20000;
    const fresh = yield* route(request(watch));
    expect(observed.live).toBe(2);
    yield* TestClock.adjust(10000);
    expect(observed.live).toBe(1);
    expect(observed.closed).toBe(1);
    yield* bytes(fresh).pipe(Stream.take(1), Stream.runDrain);
    expect(observed.live).toBe(0);
    expect(old.headers["content-type"]).toBe("application/x-ndjson");
  }).pipe(Effect.scoped, Effect.provide(world));
});

it.effect("server request cancellation closes an unread RPC child", () => {
  const { world, finalize, observed } = makeWorld();

  return Effect.gen(function* () {
    yield* finalize;
    const requestScope = yield* Scope.fork(yield* Effect.scope);
    yield* route(request(watch)).pipe(Scope.provide(requestScope));
    expect(observed.live).toBe(1);
    yield* Scope.close(requestScope, Exit.void);
    expect(observed.live).toBe(0);
    expect(observed.closed).toBe(1);
    expect(observed.scopes.length).toBeGreaterThan(0);
    expect(observed.scopes.every((scope) => scope.closed)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(world));
});
