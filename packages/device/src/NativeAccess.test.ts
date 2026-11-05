import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";
import { NativeAccessAuthentication, NativeAccessError } from "./NativeAccessAuthentication.ts";
import {
  NativeAccessPort,
  NativeHttpPort,
  layerNativeAccess,
  type NativeHttpOptions,
} from "./NativeAccess.native.ts";

const origin = "https://app.example";
const configuration = { applicationUrl: origin, issuer: "https://access.example" };
const id = "A".repeat(43);
const token = "oauth:synthetic-secret";

const fixture = (
  options: {
    readonly configuration?: Schema.Json;
    readonly finish?: NativeAccessPort["Service"]["finish"];
    readonly send?: NativeHttpPort["Service"]["send"];
  } = {},
) => {
  const calls: Array<{ readonly url: string; readonly options: NativeHttpOptions }> = [];
  const cancelled: Array<string> = [];
  let begins = 0;

  const layer = layerNativeAccess.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(NativeAccessPort, {
          configuration: Effect.succeed(options.configuration ?? configuration),
          begin: Effect.sync(() => {
            begins += 1;

            return { attemptId: id };
          }),
          finish: options.finish ?? (() => Effect.succeed({ accessToken: token, expiresIn: 60 })),
          cancel: (attemptId) =>
            Effect.sync(() => {
              cancelled.push(attemptId);
            }),
        }),
        Layer.succeed(NativeHttpPort, {
          send: (url, init) => {
            calls.push({ url, options: init });

            return options.send?.(url, init) ?? Promise.resolve(Response.json({ ready: true }));
          },
        }),
      ),
    ),
  );

  return { layer, calls, cancelled, begins: () => begins };
};

it.effect(
  "native configuration refuses noncanonical origins without opening authentication or HTTP",
  () =>
    Effect.gen(function* () {
      for (const applicationUrl of [
        "http://app.example",
        "https://*.example",
        "https://app.example/",
        "https://user:secret@app.example",
        "https://app.example/path",
        "https://app.example?token=x",
        "https://app.example#x",
      ]) {
        const f = fixture({ configuration: { ...configuration, applicationUrl } });
        expect(yield* Effect.flip(Effect.void.pipe(Effect.provide(f.layer)))).toEqual(
          new NativeAccessError({ reason: "Configuration" }),
        );
        expect(f.begins()).toBe(0);
        expect(f.calls).toEqual([]);
      }
    }),
);

it.effect(
  "private native authentication injects a bearer only into three exact application routes",
  () => {
    const f = fixture();

    return Effect.gen(function* () {
      const auth = yield* NativeAccessAuthentication;
      const client = yield* HttpClient.HttpClient;
      expect(auth.configuration).toEqual(configuration);
      yield* auth.authenticate;
      expect(f.cancelled).toEqual([id]);
      expect((yield* client.get(`${origin}/v1/library/session`)).status).toBe(200);
      expect((yield* client.post(`${origin}/v1/library/rpc`)).status).toBe(200);
      expect((yield* client.post(`${origin}/v1/library/rpc/`)).status).toBe(200);
      expect(f.calls.map(({ url }) => url)).toEqual([
        `${origin}/v1/library/session`,
        `${origin}/v1/library/rpc`,
        `${origin}/v1/library/rpc/`,
      ]);

      for (const call of f.calls) {
        expect(new Headers(call.options.headers).get("authorization")).toBe(`Bearer ${token}`);
        expect(call.options).toMatchObject({
          credentials: "omit",
          redirect: "manual",
          maxRedirections: 0,
          connectTimeout: 10000,
        });
      }
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "missing native credentials fail closed without sending a request or retaining a secret in errors",
  () => {
    const f = fixture();

    return Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const failure = yield* Effect.flip(client.get(`${origin}/v1/library/session`));
      expect(failure.reason).toMatchObject({ cause: new NativeAccessError({ reason: "Denied" }) });
      expect(JSON.stringify(failure)).not.toContain(token);
      expect(f.calls).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "endpoint, path, query, method and caller credential substitution never reach the native plugin",
  () => {
    const f = fixture();

    return Effect.gen(function* () {
      yield* (yield* NativeAccessAuthentication).authenticate;
      const client = yield* HttpClient.HttpClient;

      const forbidden = [
        HttpClientRequest.post("https://other.example/v1/library/rpc"),
        HttpClientRequest.post("http://app.example/v1/library/rpc"),
        HttpClientRequest.post("https://user:secret@app.example/v1/library/rpc"),
        HttpClientRequest.post(`${origin}/v1/library/rpc/descendant`),
        HttpClientRequest.post(`${origin}/v1/library/rpc//`),
        HttpClientRequest.post(`${origin}/v1/library/rpc?token=forbidden`),
        HttpClientRequest.post(`${origin}/v1/library/rpc#forbidden`),
        HttpClientRequest.get(`${origin}/v1/library/rpc`),
        HttpClientRequest.post(`${origin}/v1/library/session`),
        ...[
          "authorization",
          "cookie",
          "cf-access-token",
          "cf-access-jwt-assertion",
          "cf-access-client-secret",
          "cf-access-client-id",
        ].map((name) =>
          HttpClientRequest.post(`${origin}/v1/library/rpc`).pipe(
            HttpClientRequest.setHeader(name, "injected"),
          ),
        ),
      ];

      for (const request of forbidden) {
        const failure = yield* Effect.flip(client.execute(request));
        expect(failure.reason).toMatchObject({
          cause: new NativeAccessError({ reason: "Configuration" }),
        });
      }

      expect(f.calls).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "authenticated redirects and substituted final endpoints are refused and release their response bodies",
  () =>
    Effect.gen(function* () {
      for (const status of [302, 307, 200]) {
        let dropped = false;

        const f = fixture({
          send: () => {
            const response = new Response(
              new ReadableStream({
                cancel: () => {
                  dropped = true;
                },
              }),
              { status },
            );

            if (status === 200)
              Object.defineProperty(response, "url", { value: "https://other.example/stolen" });

            return Promise.resolve(response);
          },
        });

        yield* Effect.gen(function* () {
          yield* (yield* NativeAccessAuthentication).authenticate;
          const client = yield* HttpClient.HttpClient;
          const failure = yield* Effect.flip(client.post(`${origin}/v1/library/rpc`));
          expect(failure.reason).toMatchObject({
            cause: new NativeAccessError({ reason: "Configuration" }),
          });
          expect(dropped).toBe(true);
          expect(f.calls).toHaveLength(1);
        }).pipe(Effect.provide(f.layer));
      }
    }),
);

it.effect(
  "denied native requests clear credentials and abort sibling streams without disclosing provider errors",
  () => {
    const f = fixture({
      send: () => Promise.resolve(new Response("private provider error", { status: 403 })),
    });

    return Effect.gen(function* () {
      yield* (yield* NativeAccessAuthentication).authenticate;
      const client = yield* HttpClient.HttpClient;
      const failure = yield* Effect.flip(client.get(`${origin}/v1/library/session`));
      expect(failure.reason).toMatchObject({ cause: new NativeAccessError({ reason: "Denied" }) });
      expect(f.calls[0]?.options.signal?.aborted).toBe(true);
      expect(JSON.stringify(failure)).not.toContain("private provider error");
      expect(JSON.stringify(failure)).not.toContain(token);
      yield* Effect.flip(client.get(`${origin}/v1/library/session`));
      expect(f.calls).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("malformed credential IPC fails explicitly and always releases its native attempt", () =>
  Effect.gen(function* () {
    const malformed: ReadonlyArray<Schema.Json> = [
      null,
      {},
      { accessToken: "secret\r\ninjected", expiresIn: 60 },
      { accessToken: token, expiresIn: 0 },
      { accessToken: token, expiresIn: 86401 },
      { accessToken: token, expiresIn: 60, refreshToken: "do-not-accept" },
    ];

    for (const reply of malformed) {
      const f = fixture({ finish: () => Effect.succeed(reply) });
      yield* Effect.gen(function* () {
        const auth = yield* NativeAccessAuthentication;
        expect(yield* Effect.flip(auth.authenticate)).toEqual(
          new NativeAccessError({ reason: "Unavailable" }),
        );
        const client = yield* HttpClient.HttpClient;
        yield* Effect.flip(client.get(`${origin}/v1/library/session`));
        expect(f.calls).toEqual([]);
        expect(f.cancelled).toEqual([id]);
      }).pipe(Effect.provide(f.layer));
    }
  }),
);

it.effect("provider denial preserves its safe reason and cannot reuse previous credentials", () => {
  let calls = 0;

  const f = fixture({
    finish: () =>
      Effect.suspend(() => {
        calls += 1;

        return calls === 1
          ? Effect.succeed({ accessToken: token, expiresIn: 60 })
          : Effect.fail(new NativeAccessError({ reason: "Denied" }));
      }),
  });

  return Effect.gen(function* () {
    const auth = yield* NativeAccessAuthentication;
    yield* auth.authenticate;
    expect(yield* Effect.flip(auth.authenticate)).toEqual(
      new NativeAccessError({ reason: "Denied" }),
    );
    const client = yield* HttpClient.HttpClient;
    expect((yield* Effect.flip(client.get(`${origin}/v1/library/session`))).reason).toMatchObject({
      cause: new NativeAccessError({ reason: "Denied" }),
    });
    expect(f.calls).toEqual([]);
    expect(f.cancelled).toEqual([id, id]);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "interrupting authentication cancels its listener and releases the slot for another sign-in",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      let first = true;

      const f = fixture({
        finish: () =>
          Effect.suspend(() => {
            if (!first) return Effect.succeed({ accessToken: token, expiresIn: 60 });
            first = false;

            return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
          }),
      });

      yield* Effect.gen(function* () {
        const auth = yield* NativeAccessAuthentication;
        const pending = yield* Effect.forkChild(auth.authenticate);
        yield* Deferred.await(entered);
        expect(yield* Effect.flip(auth.authenticate)).toEqual(
          new NativeAccessError({ reason: "Unavailable" }),
        );
        yield* Fiber.interrupt(pending);
        expect(f.cancelled).toEqual([id]);
        yield* auth.authenticate;
        expect(
          (yield* (yield* HttpClient.HttpClient).get(`${origin}/v1/library/session`)).status,
        ).toBe(200);
        expect(f.cancelled).toEqual([id, id]);
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect(
  "clear cancels pending authorization and fences even a late successful credential reply",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const reply = yield* Deferred.make<void>();

      const f = fixture({
        finish: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(reply)),
            Effect.as({ accessToken: token, expiresIn: 60 }),
          ),
      });

      yield* Effect.gen(function* () {
        const auth = yield* NativeAccessAuthentication;
        const pending = yield* Effect.forkChild(Effect.flip(auth.authenticate));
        yield* Deferred.await(entered);
        yield* auth.clear;
        expect(f.cancelled).toEqual([id]);
        yield* Deferred.succeed(reply, undefined);
        expect(yield* Fiber.join(pending)).toEqual(new NativeAccessError({ reason: "Cancelled" }));
        yield* Effect.flip((yield* HttpClient.HttpClient).get(`${origin}/v1/library/session`));
        expect(f.calls).toEqual([]);
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect("expiry aborts idle native streams and fresh authentication re-enables requests", () => {
  const f = fixture();

  return Effect.gen(function* () {
    const auth = yield* NativeAccessAuthentication;
    const client = yield* HttpClient.HttpClient;
    yield* auth.authenticate;
    yield* client.post(`${origin}/v1/library/rpc/`);
    const active = f.calls[0]?.options.signal;
    expect(active?.aborted).toBe(false);
    yield* TestClock.adjust("60 seconds");
    expect(active?.aborted).toBe(true);
    expect((yield* Effect.flip(client.get(`${origin}/v1/library/session`))).reason).toMatchObject({
      cause: new NativeAccessError({ reason: "Denied" }),
    });
    yield* auth.authenticate;
    expect((yield* client.get(`${origin}/v1/library/session`)).status).toBe(200);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]?.options.signal?.aborted).toBe(false);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "closing the native service scope aborts outstanding request signals and discards credentials",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* Effect.gen(function* () {
        yield* (yield* NativeAccessAuthentication).authenticate;
        yield* (yield* HttpClient.HttpClient).post(`${origin}/v1/library/rpc/`);
        expect(f.calls[0]?.options.signal?.aborted).toBe(false);
      }).pipe(Effect.provide(f.layer));
      expect(f.calls[0]?.options.signal?.aborted).toBe(true);
    }),
);

it.effect("clear rejects a late native HTTP response and cancels its unread body", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let completeReply: ((response: Response) => void) | undefined;

    const reply = new Promise<Response>((resolve) => {
      completeReply = resolve;
    });

    let dropped = false;

    const f = fixture({
      send: () => {
        Deferred.doneUnsafe(entered, Effect.void);

        return reply;
      },
    });

    yield* Effect.gen(function* () {
      const auth = yield* NativeAccessAuthentication;
      yield* auth.authenticate;
      const client = yield* HttpClient.HttpClient;

      const pending = yield* Effect.forkChild(
        Effect.flip(client.get(`${origin}/v1/library/session`)),
      );

      yield* Deferred.await(entered);
      yield* auth.clear;

      if (completeReply === undefined)
        return yield* Effect.die("Native port did not expose its reply gate");
      completeReply(
        new Response(
          new ReadableStream({
            cancel: () => {
              dropped = true;
            },
          }),
        ),
      );
      expect((yield* Fiber.join(pending)).reason).toMatchObject({
        cause: new NativeAccessError({ reason: "Cancelled" }),
      });
      expect(dropped).toBe(true);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect("interrupting an HTTP request propagates abort to its native transport", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();

    const f = fixture({
      send: (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new Error("synthetic private transport details")),
            { once: true },
          );
          Deferred.doneUnsafe(entered, Effect.void);
        }),
    });

    yield* Effect.gen(function* () {
      yield* (yield* NativeAccessAuthentication).authenticate;
      const client = yield* HttpClient.HttpClient;
      const pending = yield* Effect.forkChild(client.post(`${origin}/v1/library/rpc/`));
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(pending);
      expect(f.calls[0]?.options.signal?.aborted).toBe(true);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect("an old credential expiry cannot terminate the replacement session", () => {
  const f = fixture();

  return Effect.gen(function* () {
    const auth = yield* NativeAccessAuthentication;
    const client = yield* HttpClient.HttpClient;
    yield* auth.authenticate;
    yield* client.post(`${origin}/v1/library/rpc/`);
    yield* TestClock.adjust("30 seconds");
    yield* auth.authenticate;
    expect(f.calls[0]?.options.signal?.aborted).toBe(true);
    yield* client.post(`${origin}/v1/library/rpc/`);
    yield* TestClock.adjust("30 seconds");
    expect(f.calls[1]?.options.signal?.aborted).toBe(false);
    expect((yield* client.get(`${origin}/v1/library/session`)).status).toBe(200);
  }).pipe(Effect.provide(f.layer));
});
