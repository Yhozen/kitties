import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Ref, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vite-plus/test";
import {
  DevicePreferences,
  DevicePreferencesError,
  Preferences,
  preferencesOrDefaults,
} from "./DevicePreferences.ts";
import { BrowserPreferencesStorage, layerBrowserFromStorage } from "./DevicePreferences.browser.ts";
import { NativePreferencesPort, layerNativeFromPort } from "./DevicePreferences.native.ts";
import { layerMemory } from "./DevicePreferences.test-layer.ts";

const malformedReads: ReadonlyArray<Schema.Json> = [
  null,
  { status: "found", preferences: { version: 1, language: "de", theme: "dark" } },
  { status: "absent", preferences: { version: 1, language: "pt", theme: "light" } },
  { status: "saved" },
];

const malformedWrites: ReadonlyArray<Schema.Json> = [
  null,
  { status: "saved", extra: true },
  { status: "found", preferences: { version: 1, language: "pt", theme: "light" } },
];

const portugueseLight: Preferences = { version: 1, language: "pt", theme: "light" };
const spanishSystem: Preferences = { version: 1, language: "es", theme: "system" };

const browserFixture = (initial: string | null) => {
  let text = initial;
  const writes: Array<string> = [];

  const storage = Layer.succeed(BrowserPreferencesStorage, {
    readPreferences: () => text,
    writePreferences: (next) => {
      writes.push(next);
      text = next;
    },
  });

  return {
    layer: layerBrowserFromStorage.pipe(Layer.provide(storage)),
    writes,
    persisted: () => text,
  };
};

it.effect("memory starts absent, saves a validated record, and isolates Layer instances", () =>
  Effect.gen(function* () {
    const first = yield* Effect.gen(function* () {
      const device = yield* DevicePreferences;
      expect(yield* device.load).toEqual(Option.none());
      yield* device.save(portugueseLight);

      return yield* device.load;
    }).pipe(Effect.provide(layerMemory()));

    const second = yield* Effect.gen(function* () {
      const device = yield* DevicePreferences;

      return yield* device.load;
    }).pipe(Effect.provide(layerMemory()));

    expect(first).toEqual(Option.some({ version: 1, language: "pt", theme: "light" }));
    expect(second).toEqual(Option.none());
  }),
);

it.effect(
  "browser absence performs no write and defaults remain a separate consumer choice",
  () => {
    const fixture = browserFixture(null);

    return Effect.gen(function* () {
      const device = yield* DevicePreferences;
      const value = yield* device.load;
      expect(value).toEqual(Option.none());
      expect(fixture.writes).toEqual([]);
      expect(preferencesOrDefaults(value, { version: 1, language: "en", theme: "dark" })).toEqual({
        version: 1,
        language: "en",
        theme: "dark",
      });
      expect(fixture.persisted()).toBeNull();
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect(
  "browser saves canonical JSON before returning, then a fresh Layer reads the saved record",
  () => {
    const fixture = browserFixture(null);

    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const device = yield* DevicePreferences;
        yield* device.save(portugueseLight);
        expect(fixture.persisted()).toBe('{"version":1,"language":"pt","theme":"light"}');
      }).pipe(Effect.provide(fixture.layer));
      const fresh = browserFixture(fixture.persisted());

      const loaded = yield* Effect.gen(function* () {
        const device = yield* DevicePreferences;

        return yield* device.load;
      }).pipe(Effect.provide(fresh.layer));

      expect(loaded).toEqual(Option.some({ version: 1, language: "pt", theme: "light" }));
      expect(fixture.writes).toHaveLength(1);
    });
  },
);

it.effect("browser rejects corrupt records and the exact byte limit without rewriting data", () =>
  Effect.gen(function* () {
    const record = '{"version":1,"language":"en","theme":"dark"}';

    const malformed = [
      "{",
      "null",
      "{}",
      '{"version":2,"language":"en","theme":"dark"}',
      '{"version":1,"language":"fr","theme":"dark"}',
      '{"version":1,"language":"en","theme":"night"}',
      '{"version":1,"language":"en","theme":"dark","token":"forbidden"}',
      " ".repeat(513 - record.length) + record,
    ];

    for (const raw of malformed) {
      const fixture = browserFixture(raw);
      yield* Effect.gen(function* () {
        const device = yield* DevicePreferences;
        expect(yield* Effect.result(device.load)).toEqual(
          Result.fail(new DevicePreferencesError({ operation: "load", reason: "invalid-data" })),
        );
        expect(fixture.persisted()).toBe(raw);
        expect(fixture.writes).toEqual([]);
      }).pipe(Effect.provide(fixture.layer));
    }

    const boundary = browserFixture(" ".repeat(512 - record.length) + record);
    yield* Effect.gen(function* () {
      const device = yield* DevicePreferences;
      expect(yield* device.load).toEqual(
        Option.some({ version: 1, language: "en", theme: "dark" }),
      );
    }).pipe(Effect.provide(boundary.layer));
  }),
);

it.effect("browser storage denial and quota failure remain typed load/save errors", () => {
  const storage = Layer.succeed(BrowserPreferencesStorage, {
    readPreferences: () => {
      throw new Error("blocked");
    },
    writePreferences: () => {
      throw new Error("quota");
    },
  });

  return Effect.gen(function* () {
    const device = yield* DevicePreferences;
    expect(yield* Effect.flip(device.load)).toMatchObject({
      operation: "load",
      reason: "unavailable",
    });
    expect(yield* Effect.flip(device.save(portugueseLight))).toMatchObject({
      operation: "save",
      reason: "unavailable",
    });
  }).pipe(Effect.provide(layerBrowserFromStorage.pipe(Layer.provide(storage))));
});

it.effect("browser rejects extra fields before writing", () => {
  const extra: Preferences & { credential: string } = {
    ...portugueseLight,
    credential: "not-preferences",
  };

  const fixture = browserFixture(null);

  return Effect.gen(function* () {
    const device = yield* DevicePreferences;
    expect(yield* Effect.flip(device.save(extra))).toMatchObject({
      operation: "save",
      reason: "invalid-data",
    });
    expect(fixture.writes).toEqual([]);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect(
  "native read decodes absence then found data and waits for save persistence acknowledgement",
  () =>
    Effect.gen(function* () {
      const stored = yield* Ref.make<Option.Option<Preferences>>(Option.none());
      const entered = yield* Deferred.make<void>();
      const commit = yield* Deferred.make<void>();
      const completed = yield* Ref.make(false);

      const port = Layer.succeed(NativePreferencesPort, {
        readPreferences: Ref.get(stored).pipe(
          Effect.map(
            Option.match({
              onNone: (): Schema.Json => ({ status: "absent" }),
              onSome: (preferences): Schema.Json => ({ status: "found", preferences }),
            }),
          ),
        ),
        writePreferences: (preferences) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(commit);
            yield* Ref.set(stored, Option.some(preferences));

            return { status: "saved" };
          }),
      });

      yield* Effect.gen(function* () {
        const device = yield* DevicePreferences;
        expect(yield* device.load).toEqual(Option.none());

        const pending = yield* Effect.forkChild(
          device.save(spanishSystem).pipe(Effect.andThen(Ref.set(completed, true))),
        );

        yield* Deferred.await(entered);
        // Settle runnable fibers without advancing time; the uncommitted write must still block success.
        yield* TestClock.adjust(0);
        expect(yield* Ref.get(completed)).toBe(false);
        expect(yield* device.load).toEqual(Option.none());
        yield* Deferred.succeed(commit, undefined);
        yield* Fiber.join(pending);
        expect(yield* Ref.get(completed)).toBe(true);
        expect(yield* device.load).toEqual(
          Option.some({ version: 1, language: "es", theme: "system" }),
        );
      }).pipe(Effect.provide(layerNativeFromPort.pipe(Layer.provide(port))));
    }),
);

it.effect("native rejects malformed IPC read and save replies", () =>
  Effect.gen(function* () {
    for (const reply of malformedReads) {
      const port = Layer.succeed(NativePreferencesPort, {
        readPreferences: Effect.succeed(reply),
        writePreferences: () => Effect.succeed({ status: "saved" }),
      });

      yield* Effect.gen(function* () {
        const device = yield* DevicePreferences;
        expect(yield* Effect.flip(device.load)).toMatchObject({
          operation: "load",
          reason: "invalid-data",
        });
      }).pipe(Effect.provide(layerNativeFromPort.pipe(Layer.provide(port))));
    }

    for (const reply of malformedWrites) {
      const port = Layer.succeed(NativePreferencesPort, {
        readPreferences: Effect.succeed({ status: "absent" }),
        writePreferences: () => Effect.succeed(reply),
      });

      yield* Effect.gen(function* () {
        const device = yield* DevicePreferences;
        expect(yield* Effect.flip(device.save(portugueseLight))).toMatchObject({
          operation: "save",
          reason: "invalid-data",
        });
      }).pipe(Effect.provide(layerNativeFromPort.pipe(Layer.provide(port))));
    }
  }),
);

it.effect("native Store save refusals and invalid inputs fail before reporting saved", () =>
  Effect.gen(function* () {
    const writes = yield* Ref.make(0);

    const port = Layer.succeed(NativePreferencesPort, {
      readPreferences: Effect.succeed({ status: "absent" }),
      writePreferences: () =>
        Ref.update(writes, (count) => count + 1).pipe(
          Effect.as({ status: "failed", reason: "unavailable" }),
        ),
    });

    yield* Effect.gen(function* () {
      const device = yield* DevicePreferences;

      const extra: Preferences & { credential: string } = {
        ...portugueseLight,
        credential: "not-preferences",
      };

      expect(yield* Effect.result(device.save(extra))).toEqual(
        Result.fail(new DevicePreferencesError({ operation: "save", reason: "invalid-data" })),
      );
      expect(yield* Ref.get(writes)).toBe(0);
      expect(yield* Effect.result(device.save(portugueseLight))).toEqual(
        Result.fail(new DevicePreferencesError({ operation: "save", reason: "unavailable" })),
      );
      expect(yield* Ref.get(writes)).toBe(1);
    }).pipe(Effect.provide(layerNativeFromPort.pipe(Layer.provide(port))));
  }),
);

it.effect(
  "native load/save surface explicit Store failure and IPC rejection without sensitive causes",
  () => {
    const port = Layer.succeed(NativePreferencesPort, {
      readPreferences: Effect.succeed({ status: "failed", reason: "invalid-data" }),
      writePreferences: () =>
        Effect.fail(new DevicePreferencesError({ operation: "save", reason: "unavailable" })),
    });

    return Effect.gen(function* () {
      const device = yield* DevicePreferences;
      expect(yield* Effect.flip(device.load)).toMatchObject({
        operation: "load",
        reason: "invalid-data",
      });
      expect(yield* Effect.flip(device.save(portugueseLight))).toMatchObject({
        operation: "save",
        reason: "unavailable",
      });
    }).pipe(Effect.provide(layerNativeFromPort.pipe(Layer.provide(port))));
  },
);

it.effect("a stalled native save times out using Effect time and never reports success", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const succeeded = yield* Ref.make(false);

    const port = Layer.succeed(NativePreferencesPort, {
      readPreferences: Effect.succeed({ status: "absent" }),
      writePreferences: () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    });

    yield* Effect.gen(function* () {
      const device = yield* DevicePreferences;

      const pending = yield* Effect.forkChild(
        device.save(portugueseLight).pipe(Effect.andThen(Ref.set(succeeded, true)), Effect.flip),
      );

      yield* Deferred.await(entered);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(pending)).toMatchObject({ operation: "save", reason: "timeout" });
      expect(yield* Ref.get(succeeded)).toBe(false);
    }).pipe(Effect.provide(layerNativeFromPort.pipe(Layer.provide(port))));
  }),
);

test.each(["en", "es", "pt"])(
  "the record accepts supported language %s with every theme",
  (language) => {
    expect(Schema.is(Preferences)({ version: 1, language, theme: "dark" })).toBe(true);
    expect(Schema.is(Preferences)({ version: 1, language, theme: "light" })).toBe(true);
    expect(Schema.is(Preferences)({ version: 1, language, theme: "system" })).toBe(true);
  },
);
