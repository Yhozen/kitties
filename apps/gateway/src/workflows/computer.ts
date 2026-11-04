import { RecoveryGuard, guardedActivities } from "../recovery-guard.ts";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import { DurableClock } from "effect/workflow";
import { HomeDO, KittyDO } from "../actors.ts";
import { ComputerOp } from "../computer-definition.ts";
import {
  boatClient,
  ownsSandbox,
  activeSandbox,
  readySandbox,
  BoatSandboxResponse,
  BoatSavedSnapshotResponse,
} from "../boat.ts";
import type { ComputerState } from "../computer-state.ts";
import { bootstrapPython, prepareBootstrap, executeBootstrap } from "../guest-bootstrap.ts";
import { releaseUrl } from "../releases.ts";
import { seal, open, type Envelope } from "../secrets.ts";
import { sha256 } from "../kitty.ts";

const storage = () => "STORAGE_UNAVAILABLE";

export const ComputerOpLive = Workflows.layer(
  ComputerOp,
  Effect.gen(function* () {
    const recovery = yield* RecoveryGuard;
    const fenced = (id: string) => guardedActivities(recovery(ComputerOp._tag, id));

    const homes = yield* HomeDO,
      kitties = yield* KittyDO;

    // SAFETY: Gateway declares these bindings in worker.ts and Alchemy supplies them to workflows.
    const env = (yield* Cloudflare.WorkerEnvironment) as {
      BOAT_DEV_API_KEY: string;
      KITTIES_DEPLOYMENT: string;
      KITTIES_KEK: string;
      KITTIES_RELEASE_KEY: string;
      GUEST_URL: string;
    };

    const boat = boatClient(env.BOAT_DEV_API_KEY);
    // Billing refusals (empty wallet, full snapshot allowance) clear once the owner pays.
    // They must suspend for an operator retry, never journal as a terminal failure.
    const billingCodes = ["credit_required", "subscription_required", "card_required"];

    const boatError = (error: { status: number; code: string }) =>
      error.status === 0 ||
      error.status >= 500 ||
      error.status === 429 ||
      error.code === "idempotency_in_progress"
        ? "BOAT_UNAVAILABLE"
        : error.status === 402 || billingCodes.includes(error.code)
          ? "BOAT_BILLING"
          : error.code;

    return Effect.fn(
      function* (payload, executionId) {
        yield* recovery(ComputerOp._tag, executionId);

        const home = homes.getByName("owner", { locationHint: "weur" }),
          kitty = kitties.getByName(payload.kittyId, { locationHint: "weur" });

        const request = <A>(
          method: string,
          path: string,
          response: Schema.Codec<A>,
          body?: Schema.Json,
          headers?: Record<string, string>,
        ) =>
          boat.request(method, path, response, body, headers).pipe(
            Effect.retry({
              times: 3,
              schedule: Schedule.spaced("2 seconds"),
              while: (error) =>
                error.status === 0 ||
                error.status >= 500 ||
                error.status === 429 ||
                error.code === "idempotency_in_progress",
            }),
            Effect.mapError(boatError),
          );

        const get = (id: string) =>
          request("GET", "/sandboxes/" + encodeURIComponent(id), BoatSandboxResponse).pipe(
            Effect.map((value) => value.sandbox),
          );

        const read = Effect.gen(function* () {
          const state = yield* kitty.computer().pipe(Effect.mapError(storage));

          if (!state) return yield* Effect.fail("COMPUTER_NOT_FOUND");

          return state;
        });

        const save = (state: ComputerState) =>
          kitty
            .updateComputer(payload.operationId, JSON.stringify(state))
            .pipe(Effect.mapError(storage), Effect.asVoid);

        const action = (name: string, execute: Effect.Effect<void, string>) =>
          fenced(executionId)({
            name,
            success: Schema.String,
            error: Schema.String,
            execute: execute.pipe(
              Effect.tapError((code) =>
                home
                  .write(
                    "run-health",
                    executionId,
                    JSON.stringify({
                      id: executionId,
                      kittyId: payload.kittyId,
                      operationId: payload.operationId,
                      status: "suspended",
                      code,
                      updatedAt: Date.now(),
                    }),
                  )
                  .pipe(Effect.catchCause(() => Effect.void)),
              ),
              Effect.as(payload.kittyId),
            ),
          });

        const poll = (name: string, check: Effect.Effect<boolean, string>) =>
          Effect.gen(function* () {
            for (let index = 0; index < 360; index++) {
              if (
                yield* fenced(executionId)({
                  name: `${name}/${index}`,
                  success: Schema.Boolean,
                  error: Schema.String,
                  execute: check,
                })
              )
                return;
              yield* DurableClock.sleep({
                name: `${name}/wait/${index}`,
                duration: "3 seconds",
                inMemoryThreshold: 0,
              });
            }

            return yield* Effect.fail("COMPUTER_POLL_LIMIT");
          });

        yield* action(
          "begin",
          kitty
            .beginComputer(payload.kittyId, payload.operationId, payload.kind)
            .pipe(Effect.mapError(storage), Effect.asVoid),
        );

        if (payload.kind === "sleep" || payload.kind === "delete") {
          yield* action(
            "quiesce",
            Effect.gen(function* () {
              const state = yield* read;

              if (!state.remoteId) return yield* Effect.fail("COMPUTER_ABSENT");
              const machine = yield* get(state.remoteId);

              if (
                !ownsSandbox(
                  machine,
                  env.KITTIES_DEPLOYMENT,
                  payload.kittyId,
                  state.generation,
                  state.receipt,
                )
              )
                return yield* Effect.fail("FOREIGN_COMPUTER");

              if (machine.state === "archived") {
                if (
                  state.quiesced?.remoteId !== state.remoteId ||
                  state.quiesced.generation !== state.generation
                )
                  return yield* Effect.fail("UNQUIESCED_ARCHIVE");

                return;
              }

              // The fallback is idempotent quiescence, never an arbitrary desktop input.
              const result = yield* request(
                "POST",
                `/sandboxes/${state.remoteId}/commands`,
                Schema.Struct({ success: Schema.Boolean }),
                {
                  command: "sudo -n -H -u kitty env DISPLAY=:99 /usr/local/bin/kitty-quiesce",
                  timeoutSeconds: 60,
                },
              );

              if (!result.success) return yield* Effect.fail("QUIESCE_FAILED");
              yield* save({
                ...state,
                phase: "archiving",
                quiesced: {
                  remoteId: state.remoteId,
                  generation: state.generation,
                  at: Date.now(),
                },
              });
            }),
          );
          yield* action(
            "stop",
            Effect.gen(function* () {
              const state = yield* read;

              if (!state.remoteId) return yield* Effect.fail("COMPUTER_ABSENT");

              // A repaired or replayed operation may find the machine already archived.
              if ((yield* get(state.remoteId)).state === "archived") return;
              yield* request(
                "POST",
                `/sandboxes/${state.remoteId}/stop`,
                Schema.Union([Schema.Json, Schema.Void]),
                { force: false },
              );
            }),
          );
          yield* poll(
            "archive",
            Effect.gen(function* () {
              const state = yield* read;
              const machine = yield* get(state.remoteId!);

              if (
                !ownsSandbox(
                  machine,
                  env.KITTIES_DEPLOYMENT,
                  payload.kittyId,
                  state.generation,
                  state.receipt,
                )
              )
                return yield* Effect.fail("FOREIGN_COMPUTER");

              if (machine.stop?.forced || machine.dataExpiredAt)
                return yield* Effect.fail("UNQUIESCED_ARCHIVE");

              return (
                machine.state === "archived" &&
                machine.snapshotAvailable === true &&
                machine.lastSnapshotStatus !== "failed"
              );
            }),
          );
          yield* action(
            "save-checkpoint",
            Effect.gen(function* () {
              const state = yield* read;
              const name = `kn-${env.KITTIES_DEPLOYMENT.slice(-10)}-${payload.kittyId}-g${state.generation}-${payload.operationId.slice(0, 8)}`;

              const exists = yield* boat.saved(name).pipe(
                Effect.map(() => true),
                Effect.catch((error) =>
                  error.status === 404 ? Effect.succeed(false) : Effect.fail(error.code),
                ),
              );

              if (!exists) {
                if (!state.remoteId) return yield* Effect.fail("REMOTE_NOT_FOUND");
                yield* request(
                  "POST",
                  "/saved-snapshots",
                  Schema.Union([Schema.Json, Schema.Void]),
                  { sandboxId: state.remoteId, name },
                );
              }

              yield* home
                .insert(
                  "checkpoint-pending",
                  payload.operationId,
                  JSON.stringify({ name, remoteId: state.remoteId }),
                )
                .pipe(Effect.mapError(storage));
            }),
          );
          yield* poll(
            "verify-checkpoint",
            Effect.gen(function* () {
              const pending = yield* home
                .read("checkpoint-pending", payload.operationId)
                .pipe(Effect.mapError(storage));

              if (!pending) return yield* Effect.fail("CHECKPOINT_NOT_FOUND");

              const point = Schema.decodeUnknownSync(
                Schema.Struct({ name: Schema.String, remoteId: Schema.String }),
              )(JSON.parse(pending));

              const { snapshot } = yield* request(
                "GET",
                "/saved-snapshots/" + encodeURIComponent(point.name),
                BoatSavedSnapshotResponse,
              );

              if (snapshot.status === "failed") return yield* Effect.fail("CHECKPOINT_FAILED");

              if (snapshot.status !== "ready") return false;

              if (
                snapshot.name !== point.name ||
                snapshot.sourceSandboxId !== point.remoteId ||
                !snapshot.snapshotId
              )
                return yield* Effect.fail("CHECKPOINT_CONFLICT");
              const state = yield* read;
              yield* save({
                ...state,
                phase: payload.kind === "delete" ? "deleting" : "sleeping",
                checkpoint: {
                  name: snapshot.name,
                  snapshotId: snapshot.snapshotId,
                  sourceRemoteId: point.remoteId,
                  generation: state.generation,
                  quiesced: true,
                  at: Date.now(),
                },
              });

              return true;
            }),
          );

          if (payload.kind === "delete") {
            yield* action(
              "delete",
              Effect.gen(function* () {
                const state = yield* read;
                yield* request(
                  "DELETE",
                  `/sandboxes/${state.remoteId}`,
                  Schema.Union([Schema.Json, Schema.Void]),
                  undefined,
                  {
                    "X-Ascii-Confirm-Delete": state.remoteId!,
                  },
                );
              }),
            );
            yield* poll(
              "deleted",
              Effect.gen(function* () {
                const state = yield* read;

                return yield* get(state.remoteId!).pipe(
                  Effect.map((machine) => machine.state === "blocked"),
                  Effect.catch((code) =>
                    code === "not_found" ? Effect.succeed(true) : Effect.fail(code),
                  ),
                );
              }),
            );
          }

          yield* action(
            "finish-stop",
            Effect.gen(function* () {
              const state = yield* read;
              yield* home
                .releaseCapacity(payload.kittyId, state.remoteId!)
                .pipe(Effect.mapError(storage));
              yield* save({
                ...state,
                phase: payload.kind === "delete" ? "deleted" : "sleeping",
                operation: undefined,
              });
            }),
          );

          return payload.kittyId;
        }

        const mode = yield* fenced(executionId)({
          name: "plan",
          success: Schema.Literals(["ready", "create", "resume"]),
          error: Schema.String,
          execute: Effect.gen(function* () {
            const state = yield* read;

            if (state.phase === "ready" && !state.operation) return "ready" as const;
            const inventory = yield* boat.inventory.pipe(Effect.mapError(boatError));

            const matches = inventory.filter((machine) =>
              ownsSandbox(
                machine,
                env.KITTIES_DEPLOYMENT,
                payload.kittyId,
                state.generation,
                state.receipt,
              ),
            );

            if (matches.length > 1) return yield* Effect.fail("GENERATION_CONFLICT");
            const activeIds = inventory.filter(activeSandbox).map((machine) => machine.id);

            if (state.remoteId && payload.kind === "restore" && activeIds.includes(state.remoteId))
              return yield* Effect.fail("STOP_BEFORE_RESTORE");

            if (
              !(yield* home
                .reserveCapacity(payload.kittyId, state.generation, payload.operationId, activeIds)
                .pipe(Effect.mapError(storage)))
            )
              return yield* Effect.fail("CAPACITY_LIMIT");

            if ((payload.kind === "start" || payload.kind === "upgrade") && state.remoteId)
              return "resume" as const;
            const checkpoint = state.checkpoint;

            if (payload.kind === "restore") {
              if (!checkpoint?.quiesced) return yield* Effect.fail("CHECKPOINT_REQUIRED");

              const { snapshot } = yield* request(
                "GET",
                "/saved-snapshots/" + encodeURIComponent(checkpoint.name),
                BoatSavedSnapshotResponse,
              );

              if (
                snapshot.status !== "ready" ||
                snapshot.snapshotId !== checkpoint.snapshotId ||
                snapshot.sourceSandboxId !== checkpoint.sourceRemoteId
              )
                return yield* Effect.fail("CHECKPOINT_CONFLICT");
            }

            if (!state.operation) return yield* Effect.fail("OPERATION_FENCED");

            if (!state.operation.body) {
              const body = JSON.stringify({
                name: `kn-${payload.kittyId}-g${state.generation}`,
                noEnv: true,
                type: "default",
                ttlSeconds: 3600,
                snapshots: true,
                labels: {
                  "kitties.deployment": env.KITTIES_DEPLOYMENT,
                  "kitties.kitty": payload.kittyId,
                  "kitties.generation": String(state.generation),
                },
                from: payload.kind === "restore" ? checkpoint!.name : undefined,
              });

              const key = yield* Effect.promise(() =>
                sha256(`${env.KITTIES_DEPLOYMENT}:${payload.kittyId}:${payload.operationId}`),
              );

              yield* save({
                ...state,
                operation: {
                  ...state.operation,
                  key,
                  body,
                  sourceCheckpointId: checkpoint?.snapshotId,
                },
              });
            }

            return "create" as const;
          }),
        });

        if (mode === "ready") return payload.kittyId;
        yield* action(
          "ensure-remote",
          Effect.gen(function* () {
            const state = yield* read;

            if (mode === "resume") {
              const machine = yield* get(state.remoteId!);

              if (
                !ownsSandbox(
                  machine,
                  env.KITTIES_DEPLOYMENT,
                  payload.kittyId,
                  state.generation,
                  state.receipt,
                )
              )
                return yield* Effect.fail("FOREIGN_COMPUTER");

              if (!activeSandbox(machine))
                yield* request(
                  "POST",
                  `/sandboxes/${state.remoteId}/resume`,
                  Schema.Union([Schema.Json, Schema.Void]),
                  {
                    ttlSeconds: 3600,
                    noEnv: true,
                  },
                );
              yield* home
                .bindCapacity(payload.kittyId, payload.operationId, state.remoteId!)
                .pipe(Effect.mapError(storage));

              return;
            }

            const operation = state.operation;

            if (!operation?.key || !operation.body)
              return yield* Effect.fail("CREATE_PLAN_MISSING");
            const inventory = yield* boat.inventory.pipe(Effect.mapError(boatError));

            const matches = inventory.filter((machine) =>
              ownsSandbox(
                machine,
                env.KITTIES_DEPLOYMENT,
                payload.kittyId,
                state.generation,
                state.receipt,
              ),
            );

            if (matches.length > 1) return yield* Effect.fail("GENERATION_CONFLICT");
            let remote = matches[0];

            if (!remote) {
              if (Date.now() - operation.at >= 24 * 3600000)
                return yield* Effect.fail("CREATE_KEY_EXPIRED");
              remote = (yield* request("POST", "/sandboxes", BoatSandboxResponse, operation.body, {
                "Idempotency-Key": operation.key,
              })).sandbox;
            }

            if (!/^bx_[a-z0-9]{8}$/.test(remote.id)) return yield* Effect.fail("INVALID_REMOTE");
            yield* save({
              ...state,
              remoteId: remote.id,
              previousIds:
                state.remoteId && state.remoteId !== remote.id
                  ? [...state.previousIds, state.remoteId]
                  : state.previousIds,
              receipt: {
                remoteId: remote.id,
                generation: state.generation,
                key: operation.key,
                body: operation.body,
                at: Date.now(),
              },
            });
            yield* home
              .bindCapacity(payload.kittyId, payload.operationId, remote.id)
              .pipe(Effect.mapError(storage));
          }),
        );
        yield* poll(
          "ready",
          Effect.gen(function* () {
            const state = yield* read;
            const machine = yield* get(state.remoteId!);

            if (
              !ownsSandbox(
                machine,
                env.KITTIES_DEPLOYMENT,
                payload.kittyId,
                state.generation,
                state.receipt,
              )
            )
              return yield* Effect.fail("FOREIGN_COMPUTER");

            return readySandbox(machine);
          }),
        );
        yield* action(
          "bootstrap",
          Effect.gen(function* () {
            const state = yield* read;

            const releaseBody = yield* home
              .read("release", "kittyd")
              .pipe(Effect.mapError(storage));

            if (!releaseBody) return yield* Effect.fail("GUEST_RELEASE_REQUIRED");

            const release = Schema.decodeUnknownSync(
              Schema.Struct({ key: Schema.String, sha256: Schema.String }),
            )(JSON.parse(releaseBody));

            const tokenId = `${payload.kittyId}:${state.generation}:${state.tokenVersion}`,
              aad = `guest-token:${tokenId}`;

            let encrypted = yield* home.read("guest-token", tokenId).pipe(Effect.mapError(storage));

            if (!encrypted) {
              const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
                byte.toString(16).padStart(2, "0"),
              ).join("");

              const envelope = yield* Effect.tryPromise({
                try: () => seal(env.KITTIES_KEK, aad, token),
                catch: () => "KEY_UNAVAILABLE",
              });

              yield* home
                .insert("guest-token", tokenId, JSON.stringify(envelope))
                .pipe(Effect.mapError(storage));
              encrypted = yield* home.read("guest-token", tokenId).pipe(Effect.mapError(storage));
            }

            // SAFETY: the bootstrap activity above seals the channel token and persists its Envelope for this tokenId.
            const token = yield* Effect.tryPromise({
              try: () => open(env.KITTIES_KEK, aad, JSON.parse(encrypted!) as Envelope),
              catch: () => "KEY_UNAVAILABLE",
            });

            const tokenHash = yield* Effect.promise(() => sha256(token));
            yield* kitty
              .configure({
                kittyId: payload.kittyId,
                remoteId: state.remoteId!,
                generation: state.generation,
                tokenVersion: state.tokenVersion,
                tokenHash,
              })
              .pipe(Effect.mapError(storage));

            const config = {
              url: env.GUEST_URL.replace(/^http/, "ws") + `/guest/${payload.kittyId}/control`,
              token,
              kittyId: payload.kittyId,
              remoteId: state.remoteId,
              generation: state.generation,
              tokenVersion: state.tokenVersion,
              database: "/var/lib/kittyd/intents.sqlite",
              display: ":99",
            };

            const manifest = {
              url: yield* Effect.promise(() =>
                releaseUrl(env.GUEST_URL, env.KITTIES_RELEASE_KEY, release.key),
              ),
              sha256: release.sha256,
            };

            const prepared = yield* request(
              "POST",
              `/sandboxes/${state.remoteId}/commands`,
              Schema.Struct({ success: Schema.Boolean }),
              { command: prepareBootstrap, timeoutSeconds: 30 },
            );

            if (!prepared.success) return yield* Effect.fail("BOOTSTRAP_FAILED");

            for (const [name, content] of [
              ["config.json", JSON.stringify(config)],
              ["artifact.json", JSON.stringify(manifest)],
              ["bootstrap.py", bootstrapPython],
            ])
              yield* request(
                "PUT",
                `/sandboxes/${state.remoteId}/files`,
                Schema.Union([Schema.Json, Schema.Void]),
                {
                  path: "/home/user/.config/kittyd-bootstrap/" + name,
                  content,
                },
              );

            const result = yield* request(
              "POST",
              `/sandboxes/${state.remoteId}/commands`,
              Schema.Struct({ success: Schema.Boolean }),
              { command: executeBootstrap, timeoutSeconds: 30 },
            );

            if (!result.success) return yield* Effect.fail("BOOTSTRAP_FAILED");
          }),
        );
        yield* poll(
          "guest",
          kitty.status().pipe(
            Effect.map((status) => status.guestConnected),
            Effect.mapError(storage),
          ),
        );
        yield* action(
          "finish-start",
          Effect.gen(function* () {
            const state = yield* read;
            yield* home
              .write("desktop-enabled", payload.kittyId, "true")
              .pipe(Effect.mapError(storage));
            yield* save({
              ...state,
              phase: "ready",
              operation: undefined,
              lastRenewAt: Date.now(),
              lastActiveAt: Date.now(),
              failureCount: 0,
            });
          }),
        );

        return payload.kittyId;
      },
      (effect, payload, executionId) =>
        effect.pipe(
          Effect.tapCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.void;
            const failure = cause.reasons.find(Cause.isFailReason);

            const code =
              failure && Schema.is(Schema.String)(failure.error)
                ? failure.error
                : "COMPUTER_UNAVAILABLE";

            return homes
              .getByName("owner", { locationHint: "weur" })
              .write(
                "run-health",
                executionId,
                JSON.stringify({
                  id: executionId,
                  kittyId: payload.kittyId,
                  operationId: payload.operationId,
                  status: "suspended",
                  code,
                  updatedAt: Date.now(),
                }),
              )
              .pipe(Effect.catchCause(() => Effect.void));
          }),
        ),
    );
  }),
);
