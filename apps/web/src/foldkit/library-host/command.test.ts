import { it } from "@effect/vitest";
import {
  DevicePreferences,
  DevicePreferencesError,
  type Preferences,
} from "@kitties/device/DevicePreferences";
import { Deferred, Effect, Fiber, Layer, Option, Ref } from "effect";
import { expect } from "vite-plus/test";
import { flags as leafFlags } from "../library/fixtures.ts";
import { ConnectLibrary, SavePreferences } from "./command.ts";
import { LibraryConnection, LibraryConnectionError } from "./LibraryConnection.ts";
import { Message } from "./message.ts";
import { init } from "./model.ts";

it.effect(
  "startup executes only a noninteractive connection; explicit sign-in requests interaction",
  () =>
    Effect.gen(function* () {
      const connections = yield* Ref.make<ReadonlyArray<boolean>>([]);
      const writes = yield* Ref.make(0);

      const connection = Layer.succeed(LibraryConnection, {
        connect: (interactive) =>
          Ref.update(connections, (values) => [...values, interactive]).pipe(
            Effect.as(leafFlags.scope),
          ),
      });

      const device = Layer.succeed(DevicePreferences, {
        load: Effect.succeed(Option.none()),
        save: () => Ref.update(writes, (value) => value + 1),
      });

      const initial = init({
        preferences: { version: 1, language: "en", theme: "system" },
        platform: "native",
        maybeBrowserSignInHref: Option.none(),
        maybePreferencesLoadError: Option.none(),
      });

      const started = yield* Effect.forEach(initial.commands, (command) => command.effect).pipe(
        Effect.provide(Layer.merge(connection, device)),
      );

      const signedIn = yield* ConnectLibrary({ interactive: true, attempt: 2 }).effect.pipe(
        Effect.provide(connection),
      );

      expect(started).toEqual([
        Message.SucceededConnectLibrary({ attempt: 1, scope: leafFlags.scope }),
      ]);
      expect(signedIn).toEqual(
        Message.SucceededConnectLibrary({
          attempt: 2,
          scope: leafFlags.scope,
        }),
      );
      expect(yield* Ref.get(connections)).toEqual([false, true]);
      expect(yield* Ref.get(writes)).toBe(0);
    }),
);

it.effect(
  "connection command reports each typed refusal and turns defects into unavailable without leaking their cause",
  () =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        ["Denied", "Unavailable", "NotReady", "ChangedAuthority"] as const,
        (reason) =>
          Effect.gen(function* () {
            const message = yield* ConnectLibrary({ interactive: false, attempt: 3 }).effect.pipe(
              Effect.provide(
                Layer.succeed(LibraryConnection, {
                  connect: () => Effect.fail(new LibraryConnectionError({ reason })),
                }),
              ),
            );

            expect(message).toEqual(Message.FailedConnectLibrary({ attempt: 3, reason }));
          }),
      );

      const defect = yield* ConnectLibrary({ interactive: false, attempt: 4 }).effect.pipe(
        Effect.provide(
          Layer.succeed(LibraryConnection, {
            connect: () => Effect.die("private provider detail"),
          }),
        ),
      );

      expect(defect).toEqual(Message.FailedConnectLibrary({ attempt: 4, reason: "Unavailable" }));
    }),
);

it.effect(
  "preference command sends exact values and emits success only after device acknowledgement",
  () =>
    Effect.gen(function* () {
      const preferences = { version: 1, language: "pt", theme: "dark" } as const;
      const started = yield* Deferred.make<void>();
      const acknowledged = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      const recorded = yield* Ref.make<ReadonlyArray<Preferences>>([]);

      const device = Layer.succeed(DevicePreferences, {
        load: Effect.succeed(Option.none()),
        save: (value) =>
          Ref.update(recorded, (values) => [...values, value]).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(acknowledged)),
          ),
      });

      const result = yield* SavePreferences({ preferences, attempt: 2 }).effect.pipe(
        Effect.tap(() => Deferred.succeed(completed, undefined)),
        Effect.provide(device),
        Effect.forkChild,
      );

      yield* Deferred.await(started);
      expect(yield* Ref.get(recorded)).toEqual([{ version: 1, language: "pt", theme: "dark" }]);
      expect(yield* Deferred.poll(completed)).toEqual(Option.none());

      yield* Deferred.succeed(acknowledged, undefined);

      expect(yield* Fiber.join(result)).toEqual(Message.SucceededSavePreferences({ attempt: 2 }));
    }),
);

it.effect("failed preference writes preserve the reason and never emit a success ACK", () =>
  Effect.gen(function* () {
    yield* Effect.forEach(["invalid-data", "unavailable", "timeout"] as const, (reason) =>
      Effect.gen(function* () {
        const message = yield* SavePreferences({
          preferences: { version: 1, language: "es", theme: "light" },
          attempt: 7,
        }).effect.pipe(
          Effect.provide(
            Layer.succeed(DevicePreferences, {
              load: Effect.succeed(Option.none()),
              save: () => Effect.fail(new DevicePreferencesError({ operation: "save", reason })),
            }),
          ),
        );

        expect(message).toEqual(Message.FailedSavePreferences({ attempt: 7, reason }));
      }),
    );
  }),
);
