import { SkillInput } from "@kitties/domain/entities";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { TurnKittyRecord } from "./actor-records.ts";
import { LibraryLegacyStore } from "./library-legacy-store.ts";
import type { LibraryLegacyDatabase } from "./library-legacy-store.ts";
import { LibrarySnapshot } from "./library-snapshot.ts";
import { freshMemory } from "./memory.ts";
import { KittyRecord, NameRecord, stored } from "./stored-records.ts";

export class TurnConfigurationUnavailable extends Schema.TaggedError<
  TurnConfigurationUnavailable,
  { readonly brand: unique symbol }
>()("TurnConfigurationUnavailable", {
  reason: Schema.Literals(["storage", "kitty", "library"]),
}) {}

const Body = Schema.Struct({ body: Schema.String });
const NamedBody = Schema.Struct({ id: Schema.String, body: Schema.String });
const json = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

/** Home owns the first saved turn configuration; Domain owns new library captures. */
export class TurnConfiguration extends Context.Service<
  TurnConfiguration,
  {
    readonly prepare: (
      id: string,
      kittyId: string,
      health: string,
    ) => Effect.Effect<number, TurnConfigurationUnavailable>;
  }
>()("@kitties/gateway/TurnConfiguration") {
  static readonly layer = (database: LibraryLegacyDatabase) =>
    Layer.effect(
      TurnConfiguration,
      Effect.gen(function* () {
        const legacy = yield* LibraryLegacyStore;
        const snapshots = yield* LibrarySnapshot;
        const query = database.query;

        const read = (kind: string, id: string) => {
          const row = query("SELECT body FROM records WHERE kind=? AND id=?", kind, id)[0];

          return row === undefined ? undefined : Schema.decodeUnknownSync(Body)(row).body;
        };

        const attempt = <A>(body: () => A) =>
          Effect.try({
            try: body,
            catch: (cause) =>
              Schema.is(TurnConfigurationUnavailable)(cause)
                ? cause
                : new TurnConfigurationUnavailable({ reason: "storage" }),
          });

        const prepare = Effect.fnUntraced(function* (id: string, kittyId: string, health: string) {
          const existing = yield* attempt(() => read("turn-config", id));

          const captured = yield* Effect.gen(function* () {
            if (existing !== undefined) return null;

            const status = yield* legacy.status.pipe(
              Effect.mapError(() => new TurnConfigurationUnavailable({ reason: "library" })),
            );

            if (status.authority?.phase === "ready")
              return yield* snapshots
                .capture()
                .pipe(
                  Effect.mapError(() => new TurnConfigurationUnavailable({ reason: "library" })),
                );

            if (status.authority !== null || status.frozen)
              return yield* new TurnConfigurationUnavailable({ reason: "library" });

            return null;
          });

          const now = yield* Clock.currentTimeMillis;

          return yield* attempt(() =>
            database.transaction(() => {
              // A competing initializer may have saved a coherent capture while this
              // call waited for Domain. That first body wins, including on retries.
              let body = read("turn-config", id);

              if (body === undefined) {
                if (
                  captured === null &&
                  query("SELECT id FROM library_legacy_marker WHERE id=1").length !== 0
                )
                  throw new TurnConfigurationUnavailable({ reason: "library" });
                const kittyBody = read("kitty", kittyId);

                if (kittyBody === undefined)
                  throw new TurnConfigurationUnavailable({ reason: "kitty" });
                const kitty = stored(KittyRecord, kittyBody);
                const provider = kitty.providerId ? read("provider", kitty.providerId) : undefined;
                const memory = read("memory", kittyId);

                body = JSON.stringify({
                  kitty,
                  team: query("SELECT id,body FROM records WHERE kind='kitty' ORDER BY id").map(
                    (row) => {
                      const value = Schema.decodeUnknownSync(NamedBody)(row);

                      return { id: value.id, name: stored(NameRecord, value.body).name };
                    },
                  ),
                  desktop: read("desktop-enabled", kittyId) === "true",
                  provider: provider === undefined ? null : json(provider),
                  connections: query(
                    "SELECT body FROM records WHERE kind='connection' ORDER BY id LIMIT 64",
                  ).map((row) => json(Schema.decodeUnknownSync(Body)(row).body)),
                  memory: memory === undefined ? freshMemory() : json(memory),
                  skills:
                    captured?.skills ??
                    query("SELECT body FROM records WHERE kind='skill' ORDER BY id")
                      .map((row) => stored(SkillInput, Schema.decodeUnknownSync(Body)(row).body))
                      .filter((skill) => skill.status === "accepted")
                      .slice(0, 8),
                  library:
                    captured === null
                      ? undefined
                      : { epoch: captured.epoch, catalogueRevision: captured.catalogueRevision },
                });
                query("INSERT INTO records VALUES ('turn-config',?,?,?)", id, body, now);
              }

              query(
                "INSERT INTO records VALUES ('run-health',?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at",
                id,
                health,
                now,
              );

              return stored(TurnKittyRecord, body).kitty.limits?.max_rounds ?? 12;
            }),
          );
        });

        return { prepare };
      }),
    );
}
