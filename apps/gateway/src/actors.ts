import * as Schema from "effect/Schema";
import { stored, GoalRecord, ApprovalRecord } from "./stored-records.ts";
import {
  MemoryRecord,
  MemoryCommandRecord,
  TurnKittyRecord,
  GoalUpdateRecord,
  NotificationSettingsRecord,
  NotificationFoldRecord,
  NotificationBatchRecord,
  RuleModeRecord,
  TrustRecord,
} from "./actor-records.ts";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import * as Migrator from "@effect/sql-sqlite-do/SqliteMigrator";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import { RecoveryDO } from "./recovery-store.ts";
import { StorageAdmin } from "./storage-admin.ts";
import { freshMemory, updateMemory } from "./memory.ts";
import { OAuthCredentials, type OAuthConfig } from "./oauth-core.ts";
import { ChatgptCredentials, type ChatgptCallback } from "./chatgpt-core.ts";
import { safeChatgptError } from "./chatgpt-errors.ts";
import { authorization } from "./approval-policy.ts";
import { HelpStore, type HelpDecision } from "./help-store.ts";
import { Library } from "@kitties/domain/Library/Library.aggregate";
import { SkillDetail } from "@kitties/domain/Library/SkillDetail.view";
import {
  LibraryLegacyStore,
  LibraryLegacyError,
  LibraryMigrationControl,
  nativeLibraryLegacyDatabase,
} from "./library-legacy-store.ts";
import { LibraryMigration } from "./library-migration.ts";
import { LibrarySnapshot } from "./library-snapshot.ts";
import { TurnConfiguration } from "./turn-configuration.ts";

const makeActor = Effect.gen(function* () {
  const state = yield* Cloudflare.DurableObjectState;
  const roots = yield* RecoveryDO;
  const libraries = yield* Library;
  const details = yield* SkillDetail;
  const snapshots = yield* LibrarySnapshot;
  const migrationControl = yield* LibraryMigrationControl;

  const register = (kind: string, id: string) =>
    kind === "kitty" || kind === "chat"
      ? roots.getByName("control", { locationHint: "weur" }).register(kind, id)
      : Effect.void;

  // SAFETY: Gateway deployment declares these named bindings in worker.ts; Cloudflare injects their declared values into every bound actor.
  const env = (yield* Cloudflare.WorkerEnvironment) as { KITTIES_KEK: string };

  return Effect.gen(function* () {
    const database = yield* Layer.buildWithScope(
      SqliteClient.layer({ storage: state.raw.storage }),
      yield* Effect.scope,
    );

    const sql = Context.get(database, SqlClient.SqlClient);
    yield* Migrator.run({
      loader: Migrator.fromRecord({
        "1_initial": Effect.gen(function* () {
          const db = yield* SqlClient.SqlClient;
          yield* db`CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(kind,id))`;
        }),
      }),
    }).pipe(Effect.provide(database), Effect.orDie);
    state.raw.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS charges (id TEXT PRIMARY KEY,day TEXT NOT NULL,kitty TEXT NOT NULL,tokens INTEGER NOT NULL,actions INTEGER NOT NULL)",
    );
    state.raw.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS connector_effects (id TEXT PRIMARY KEY,digest TEXT NOT NULL,status TEXT NOT NULL,result TEXT,at INTEGER NOT NULL)",
    );
    state.raw.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS capacity_leases (kitty TEXT PRIMARY KEY,generation INTEGER NOT NULL,operation_id TEXT NOT NULL,remote_id TEXT,at INTEGER NOT NULL)",
    );
    state.raw.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS webhook_deliveries (id TEXT PRIMARY KEY,digest TEXT NOT NULL,body TEXT NOT NULL,at INTEGER NOT NULL)",
    );
    const raw = state.raw.storage.sql;
    const help = yield* HelpStore.pipe(Effect.provide(HelpStore.layer));
    const legacyDatabase = nativeLibraryLegacyDatabase(state.raw.storage);

    const homeLibrary = yield* Layer.buildWithScope(
      Layer.mergeAll(TurnConfiguration.layer(legacyDatabase), LibraryMigration.layer).pipe(
        Layer.provideMerge(
          LibraryLegacyStore.layer(legacyDatabase).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                Layer.succeed(Library, libraries),
                Layer.succeed(SkillDetail, details),
                Layer.succeed(LibrarySnapshot, snapshots),
                Layer.succeed(LibraryMigrationControl, migrationControl),
              ),
            ),
          ),
        ),
      ),
      yield* Effect.scope,
    ).pipe(Effect.orDie);

    const legacy = Context.get(homeLibrary, LibraryLegacyStore);
    const migration = Context.get(homeLibrary, LibraryMigration);
    const turns = Context.get(homeLibrary, TurnConfiguration);

    const admin = yield* StorageAdmin.pipe(
      Effect.provide(
        StorageAdmin.layer(
          [
            "records",
            "charges",
            "connector_effects",
            "capacity_leases",
            "webhook_deliveries",
            "library_legacy_marker",
            "library_legacy_inventory",
          ],
          env.KITTIES_KEK,
        ),
      ),
    );

    // Hard cutover: old provider-owned Codex grants and active-attempt pointers
    // cannot remain usable through the generic OAuth callback after redeploy/PITR.
    raw.exec(
      "DELETE FROM records WHERE kind IN ('oauth-credentials','oauth-attempt') AND id GLOB 'chatgpt-*'",
    );

    const oauthGet = (kind: string, id: string) =>
      raw
        .exec<{ body: string }>("SELECT body FROM records WHERE kind=? AND id=?", kind, id)
        .toArray()[0]?.body ?? null;

    const credentialStorage = {
      get: oauthGet,
      put: (kind: string, id: string, body: string) => {
        raw.exec(
          "INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at",
          kind,
          id,
          body,
          Date.now(),
        );
      },
      take: (kind: string, id: string) =>
        state.raw.storage.transactionSync(() => {
          const body = oauthGet(kind, id);
          raw.exec("DELETE FROM records WHERE kind=? AND id=?", kind, id);

          return body;
        }),
      list: (kind: string) =>
        raw
          .exec<{ id: string; body: string }>(
            "SELECT id,body FROM records WHERE kind=? ORDER BY id",
            kind,
          )
          .toArray(),
    };

    const oauth = yield* OAuthCredentials.pipe(
      Effect.provide(OAuthCredentials.layer(credentialStorage, env.KITTIES_KEK)),
    );

    const chatgpt = yield* ChatgptCredentials.pipe(
      Effect.provide(
        ChatgptCredentials.layer(credentialStorage, env.KITTIES_KEK, () =>
          Effect.runPromise(roots.getByName("control", { locationHint: "weur" }).chatgptContext()),
        ),
      ),
    );

    const oauthError = () => "OAUTH_AUTHORIZATION_REQUIRED";

    const prepareTurn = turns.prepare;

    const turnContext = (id: string, day: string) =>
      Effect.sync(() => {
        const raw = state.raw.storage.sql,
          body = raw
            .exec<{ body: string }>(
              "SELECT body FROM records WHERE kind='turn-config' AND id=?",
              id,
            )
            .toArray()[0]?.body;

        if (!body) throw Error("CONFIG_NOT_FOUND");
        const kitty = stored(TurnKittyRecord, body).kitty.id;

        const spent = raw
          .exec<{ tokens: number; actions: number }>(
            "SELECT COALESCE(SUM(tokens),0) AS tokens,COALESCE(SUM(actions),0) AS actions FROM charges WHERE day=? AND kitty=?",
            day,
            kitty,
          )
          .toArray()[0]!;

        return { body, spent };
      });

    return {
      ...admin,
      libraryLegacyStatus: () => legacy.status,
      libraryMigrate: (inventoryId: string) =>
        migration.run(inventoryId).pipe(
          Effect.tapError((error) =>
            Effect.logError("Library migration failed").pipe(
              Effect.annotateLogs({
                stage: error.stage,
                reason: error.reason,
                ordinal: error.ordinal ?? null,
                rejection: error.rejection ?? null,
              }),
            ),
          ),
        ),
      chatgptAccounts: () => Effect.tryPromise({ try: chatgpt.accounts, catch: safeChatgptError }),
      chatgptAccount: (id: string) =>
        Effect.tryPromise({ try: () => chatgpt.account(id), catch: safeChatgptError }),
      chatgptBegin: (input: {
        redirectUri: string;
        accountId?: string;
        retryAttemptId?: string;
        requestConsent?: boolean;
      }) => Effect.tryPromise({ try: () => chatgpt.begin(input), catch: safeChatgptError }),
      chatgptAttempt: (id: string) =>
        Effect.tryPromise({ try: () => chatgpt.attempt(id), catch: safeChatgptError }),
      chatgptAuthorize: (id: string) =>
        Effect.tryPromise({ try: () => chatgpt.authorize(id), catch: safeChatgptError }),
      chatgptFinish: (callback: ChatgptCallback) =>
        Effect.tryPromise({ try: () => chatgpt.finish(callback), catch: safeChatgptError }),
      chatgptCancel: (id: string) =>
        Effect.tryPromise({ try: () => chatgpt.cancel(id), catch: safeChatgptError }),
      chatgptDisconnect: (id: string) =>
        Effect.tryPromise({ try: () => chatgpt.disconnect(id), catch: safeChatgptError }),
      chatgptModels: (id: string) =>
        Effect.tryPromise({ try: () => chatgpt.models(id), catch: safeChatgptError }),
      chatgptProbe: (id: string) =>
        Effect.tryPromise({ try: () => chatgpt.probe(id), catch: safeChatgptError }),
      chatgptInvalidate: () => Effect.sync(chatgpt.invalidate),
      oauthBegin: (id: string, config: OAuthConfig) =>
        Effect.tryPromise({ try: () => oauth.begin(id, config), catch: oauthError }),
      oauthFinish: (state: string, code: string, issuer?: string, expectedId?: string) =>
        Effect.tryPromise({
          try: () => oauth.finish(state, code, issuer, expectedId),
          catch: oauthError,
        }),
      oauthToken: (id: string, url: string) =>
        Effect.tryPromise({ try: () => oauth.token(id, url), catch: oauthError }),
      oauthStatus: (id: string) => Effect.sync(() => oauth.status(id)),
      oauthDisconnect: (id: string) => Effect.sync(() => oauth.disconnect(id)),
      queueNotice: (
        eventId: string,
        kind: string,
        title: string,
        url: string,
        immediate: boolean,
      ) =>
        Effect.sync(() =>
          state.raw.storage.transactionSync(() => {
            const raw = state.raw.storage.sql,
              get = (type: string, id: string) =>
                raw
                  .exec<{ body: string }>(
                    "SELECT body FROM records WHERE kind=? AND id=?",
                    type,
                    id,
                  )
                  .toArray()[0]?.body;

            const prefs = get("settings", "notifications");

            if (!prefs) return;
            const settings = stored(NotificationSettingsRecord, prefs);

            if (!settings.enabled || !settings.events.some((event) => event === kind)) return;

            if (get("notification-event", eventId)) return;

            const at = Date.now(),
              fold = get("notification-fold", kind),
              previous = fold ? stored(NotificationFoldRecord, fold) : null;

            const batchId = !immediate && previous && previous.dueAt > at ? previous.id : eventId;
            const saved = get("notification-batch", batchId);

            const batch = saved
              ? stored(NotificationBatchRecord, saved)
              : {
                  title: title.slice(0, 500),
                  url,
                  dueAt: at + (immediate ? 0 : 600000),
                  count: 0,
                  status: "pending",
                };

            batch.count++;
            raw.exec(
              "INSERT INTO records VALUES ('notification-event',?,?,?)",
              eventId,
              batchId,
              at,
            );
            raw.exec(
              "INSERT INTO records VALUES ('notification-batch',?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at",
              batchId,
              JSON.stringify(batch),
              at,
            );

            if (!immediate)
              raw.exec(
                "INSERT INTO records VALUES ('notification-fold',?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at",
                kind,
                JSON.stringify({ id: batchId, dueAt: batch.dueAt }),
                at,
              );
          }),
        ),
      authorizeTool: (kittyId: string, policyKey: string, always: boolean, free: boolean) =>
        Effect.sync(() => {
          const raw = state.raw.storage.sql,
            get = (kind: string, id: string) =>
              raw
                .exec<{ body: string }>("SELECT body FROM records WHERE kind=? AND id=?", kind, id)
                .toArray()[0]?.body;

          const parts = stored(Schema.Array(Schema.String), policyKey);
          const wildcard = JSON.stringify([parts[0], parts[1], "*"]);

          const rule = get("approval-rule", policyKey) ?? get("approval-rule", wildcard),
            trust = get("approval-trust", policyKey),
            memory = get("memory", kittyId);

          return authorization({
            always,
            free,
            mode: rule ? stored(RuleModeRecord, rule).mode : undefined,
            streak: trust ? stored(TrustRecord, trust).streak : 0,
            demand: memory ? stored(MemoryRecord, memory).profile.demand : 3,
          });
        }),
      claimWebhook: (id: string, digest: string, body: string) =>
        Effect.sync(() =>
          state.raw.storage.transactionSync(() => {
            const raw = state.raw.storage.sql;
            raw.exec(
              "INSERT OR IGNORE INTO webhook_deliveries VALUES (?,?,?,?)",
              id,
              digest,
              body,
              Date.now(),
            );

            const row = raw
              .exec<{ digest: string; body: string }>(
                "SELECT digest,body FROM webhook_deliveries WHERE id=?",
                id,
              )
              .toArray()[0]!;

            return { conflict: row.digest !== digest, body: row.body };
          }),
        ),
      saveGoal: (id: string, body: string) =>
        Effect.sync(() =>
          state.raw.storage.transactionSync(() => {
            const raw = state.raw.storage.sql;

            const old = raw
              .exec<{ body: string }>("SELECT body FROM records WHERE kind='goal' AND id=?", id)
              .toArray()[0];

            const previous = old ? stored(GoalRecord, old.body) : null;

            const goal = {
              ...stored(GoalUpdateRecord, body),
              id,
              revision: (previous?.revision ?? 0) + 1,
              chatId: previous?.chatId ?? `goal-${id}`,
              updatedAt: Date.now(),
            };

            raw.exec(
              "INSERT INTO records VALUES ('goal',?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at",
              id,
              JSON.stringify(goal),
              Date.now(),
            );

            return goal;
          }),
        ),
      advanceGoalSlot: (id: string, revision: number, slot: number, next: number) =>
        Effect.sync(() =>
          state.raw.storage.transactionSync(() => {
            const raw = state.raw.storage.sql,
              row = raw
                .exec<{ body: string }>("SELECT body FROM records WHERE kind='goal' AND id=?", id)
                .toArray()[0];

            if (!row) return;
            const goal = stored(GoalRecord, row.body);

            if (goal.revision !== revision || !goal.enabled || goal.nextSlot > slot) return;
            raw.exec(
              "UPDATE records SET body=?,updated_at=? WHERE kind='goal' AND id=?",
              JSON.stringify({ ...goal, nextSlot: next }),
              Date.now(),
              id,
            );
          }),
        ),
      prepareTurn,
      turnContext,
      beginTurnRound: (id: string, kittyId: string, health: string, day: string) =>
        prepareTurn(id, kittyId, health).pipe(Effect.flatMap(() => turnContext(id, day))),
      reserveCapacity: (
        kitty: string,
        generation: number,
        operationId: string,
        activeIds: readonly string[],
      ) =>
        Effect.sync(() =>
          state.raw.storage.transactionSync(() => {
            const raw = state.raw.storage.sql;

            const existing = raw
              .exec<{ operation_id: string; remote_id: string | null; generation: number }>(
                "SELECT operation_id,remote_id,generation FROM capacity_leases WHERE kitty=?",
                kitty,
              )
              .toArray()[0];

            if (existing?.operation_id === operationId) return true;

            if (
              existing?.remote_id &&
              existing.generation === generation &&
              activeIds.includes(existing.remote_id)
            ) {
              raw.exec(
                "UPDATE capacity_leases SET operation_id=?,at=? WHERE kitty=?",
                operationId,
                Date.now(),
                kitty,
              );

              return true;
            }

            if (existing) throw Error("CAPACITY_LEASE_CONFLICT");

            const reservations = raw
              .exec<{ remote_id: string | null }>("SELECT remote_id FROM capacity_leases")
              .toArray();

            const unobserved = reservations.filter(
              (row) => !row.remote_id || !activeIds.includes(row.remote_id),
            ).length;

            if (new Set(activeIds).size + unobserved >= 5) return false;
            raw.exec(
              "INSERT INTO capacity_leases VALUES (?,?,?,NULL,?)",
              kitty,
              generation,
              operationId,
              Date.now(),
            );

            return true;
          }),
        ),
      bindCapacity: (kitty: string, operationId: string, remoteId: string) =>
        Effect.sync(() => {
          state.raw.storage.sql.exec(
            "UPDATE capacity_leases SET remote_id=?,at=? WHERE kitty=? AND operation_id=?",
            remoteId,
            Date.now(),
            kitty,
            operationId,
          );
        }),
      releaseCapacity: (kitty: string, remoteId: string) =>
        Effect.sync(() => {
          state.raw.storage.sql.exec(
            "DELETE FROM capacity_leases WHERE kitty=? AND remote_id=?",
            kitty,
            remoteId,
          );
        }),
      capacityLeases: () =>
        Effect.sync(() =>
          state.raw.storage.sql
            .exec<{
              kitty: string;
              generation: number;
              operation_id: string;
              remote_id: string | null;
              at: number;
            }>("SELECT * FROM capacity_leases")
            .toArray(),
        ),
      memory: (id: string) =>
        Effect.sync(() => {
          const row = state.raw.storage.sql
            .exec<{ body: string }>("SELECT body FROM records WHERE kind='memory' AND id=?", id)
            .toArray()[0];

          return row ? stored(MemoryRecord, row.body) : freshMemory();
        }),
      applyDistillation: (runId: string, kittyId: string, command: string) =>
        Effect.sync(() =>
          state.raw.storage.transactionSync(() => {
            const raw = state.raw.storage.sql;

            if (
              raw.exec("SELECT id FROM records WHERE kind='distilled' AND id=?", runId).toArray()
                .length
            )
              return;

            const row = raw
              .exec<{ body: string }>(
                "SELECT body FROM records WHERE kind='memory' AND id=?",
                kittyId,
              )
              .toArray()[0];

            const next = updateMemory(
              row ? stored(MemoryRecord, row.body) : freshMemory(),
              stored(MemoryCommandRecord, command),
            );

            raw.exec(
              "INSERT INTO records VALUES ('memory',?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at",
              kittyId,
              JSON.stringify(next),
              Date.now(),
            );
            raw.exec("INSERT INTO records VALUES ('distilled',?,?,?)", runId, kittyId, Date.now());
          }),
        ),
      mutateMemory: (id: string, body: string) =>
        Effect.sync(() =>
          state.raw.storage.transactionSync(() => {
            const raw = state.raw.storage.sql;

            const row = raw
              .exec<{ body: string }>("SELECT body FROM records WHERE kind='memory' AND id=?", id)
              .toArray()[0];

            const next = updateMemory(
              row ? stored(MemoryRecord, row.body) : freshMemory(),
              stored(MemoryCommandRecord, body),
            );

            raw.exec(
              "INSERT INTO records VALUES ('memory',?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at",
              id,
              JSON.stringify(next),
              Date.now(),
            );

            return next;
          }),
        ),
      beginEffect: (id: string, digest: string) =>
        Effect.sync(() => {
          const raw = state.raw.storage.sql;
          raw.exec(
            "INSERT OR IGNORE INTO connector_effects VALUES (?,?,'started',NULL,?)",
            id,
            digest,
            Date.now(),
          );

          const row = raw
            .exec<{ digest: string; status: string; result: string | null }>(
              "SELECT digest,status,result FROM connector_effects WHERE id=?",
              id,
            )
            .toArray()[0]!;

          if (row.digest !== digest) throw Error("INTENT_CONFLICT");

          // created is returned only by the transaction that inserted the intent.
          return row;
        }),
      claimEffect: (id: string, digest: string) =>
        Effect.sync(() => {
          const raw = state.raw.storage.sql;

          return state.raw.storage.transactionSync(() => {
            const row = raw
              .exec<{ digest: string; status: string; result: string | null }>(
                "SELECT digest,status,result FROM connector_effects WHERE id=?",
                id,
              )
              .toArray()[0];

            if (row) {
              if (row.digest !== digest) throw Error("INTENT_CONFLICT");

              return { ...row, claimed: false };
            }

            raw.exec(
              "INSERT INTO connector_effects VALUES (?,?,'started',NULL,?)",
              id,
              digest,
              Date.now(),
            );

            return { digest, status: "started", result: null, claimed: true };
          });
        }),
      completeEffect: (id: string, result: string) =>
        Effect.sync(() => {
          if (result.length > 128000) throw Error("OUTPUT_LIMIT");
          state.raw.storage.sql.exec(
            "UPDATE connector_effects SET status='completed',result=? WHERE id=? AND status='started'",
            result,
            id,
          );
        }),
      decideHelp: (id: string, decision: HelpDecision) =>
        Effect.sync(() => help.decide(id, decision)),
      completeHelp: (id: string) => Effect.sync(() => help.complete(id)),
      decideApproval: (id: string, decision: boolean, digest: string) =>
        Effect.sync(() =>
          state.raw.storage.transactionSync(() => {
            const raw = state.raw.storage.sql;

            const row = raw
              .exec<{ body: string }>("SELECT body FROM records WHERE kind='approval' AND id=?", id)
              .toArray()[0];

            if (!row) return null;
            const value = stored(ApprovalRecord, row.body);

            if (value.digest !== digest) return null;
            const desired = decision ? "approved" : "denied";

            if (value.status === desired) return value;

            if (value.status !== "pending") return null;
            value.status = value.expiresAt <= Date.now() ? "expired" : desired;

            if (value.status !== "expired" && value.policyKey) {
              const key = value.policyKey;

              // This transition runs once, in the same transaction as the decision.
              const previous = raw
                .exec<{ body: string }>(
                  "SELECT body FROM records WHERE kind='approval-trust' AND id=?",
                  key,
                )
                .toArray()[0];

              const streak = decision
                ? (previous ? stored(TrustRecord, previous.body).streak : 0) + 1
                : 0;

              raw.exec(
                "INSERT INTO records VALUES ('approval-trust',?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at",
                key,
                JSON.stringify({ streak }),
                Date.now(),
              );
            }

            raw.exec(
              "UPDATE records SET body=?,updated_at=? WHERE kind='approval' AND id=?",
              JSON.stringify(value),
              Date.now(),
              id,
            );

            return value.status === "expired" ? null : value;
          }),
        ),
      expireApproval: (id: string) =>
        Effect.sync(() => {
          const raw = state.raw.storage.sql;

          const row = raw
            .exec<{ body: string }>("SELECT body FROM records WHERE kind='approval' AND id=?", id)
            .toArray()[0];

          if (!row) return;
          const value = stored(ApprovalRecord, row.body);

          if (value.status === "pending" && value.expiresAt <= Date.now()) {
            value.status = "expired";
            raw.exec(
              "UPDATE records SET body=?,updated_at=? WHERE kind='approval' AND id=?",
              JSON.stringify(value),
              Date.now(),
              id,
            );
          }
        }),
      insert: (
        kind: string,
        id: string,
        body: string,
      ): Effect.Effect<void, SqlError.SqlError | LibraryLegacyError> =>
        kind === "skill"
          ? Effect.fail(new LibraryLegacyError({ reason: "invalid" }))
          : sql`INSERT OR IGNORE INTO records VALUES (${kind},${id},${body},${Date.now()})`.pipe(
              Effect.andThen(register(kind, id)),
            ),
      charge: (id: string, day: string, kitty: string, tokens: number, actions: number) =>
        Effect.sync(() => {
          state.raw.storage.sql.exec(
            "INSERT OR IGNORE INTO charges VALUES (?,?,?,?,?)",
            id,
            day,
            kitty,
            tokens,
            actions,
          );

          return state.raw.storage.sql
            .exec<{ tokens: number; actions: number }>(
              "SELECT COALESCE(SUM(tokens),0) AS tokens,COALESCE(SUM(actions),0) AS actions FROM charges WHERE day=? AND kitty=?",
              day,
              kitty,
            )
            .toArray()[0]!;
        }),
      spent: (day: string, kitty: string) =>
        Effect.sync(
          () =>
            state.raw.storage.sql
              .exec<{ tokens: number; actions: number }>(
                "SELECT COALESCE(SUM(tokens),0) AS tokens,COALESCE(SUM(actions),0) AS actions FROM charges WHERE day=? AND kitty=?",
                day,
                kitty,
              )
              .toArray()[0]!,
        ),
      read: (kind: string, id: string) =>
        sql<{ body: string }>`SELECT body FROM records WHERE kind=${kind} AND id=${id}`.pipe(
          Effect.map((rows) => rows[0]?.body ?? null),
        ),
      write: (
        kind: string,
        id: string,
        body: string,
      ): Effect.Effect<void, SqlError.SqlError | LibraryLegacyError> =>
        kind === "skill"
          ? legacy.writeSkill(id, body, Date.now())
          : sql`INSERT INTO records (kind,id,body,updated_at) VALUES (${kind},${id},${body},${Date.now()}) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at`.pipe(
              Effect.andThen(register(kind, id)),
              Effect.asVoid,
            ),
      list: (kind: string) =>
        sql<{
          id: string;
          body: string;
        }>`SELECT id,body FROM records WHERE kind=${kind} ORDER BY id`,
      remove: (
        kind: string,
        id: string,
      ): Effect.Effect<void, SqlError.SqlError | LibraryLegacyError> =>
        kind === "skill"
          ? legacy.removeSkill(id)
          : sql`DELETE FROM records WHERE kind=${kind} AND id=${id}`.pipe(Effect.asVoid),
    };
  });
});

type HomeOperations = Effect.Success<Effect.Success<typeof makeActor>>;

export class HomeDO extends Cloudflare.DurableObject<HomeDO, HomeOperations>()("HomeDO") {}

export const HomeDOLive = HomeDO.make(makeActor);

export { KittyDO } from "./kitty.ts";

export { ChatDO } from "./chat.ts";
