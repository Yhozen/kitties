import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import { Activity, DurableClock } from "effect/workflow";
import { HomeDO, KittyDO } from "../actors.ts";
import { ComputerOp } from "../computer-definition.ts";
import { boatClient, ownsSandbox, activeSandbox, readySandbox, type BoatSandbox } from "../boat.ts";
import type { ComputerState } from "../computer-state.ts";
import { bootstrapPython, prepareBootstrap, executeBootstrap } from "../guest-bootstrap.ts";
import { releaseUrl } from "../releases.ts";
import { seal, open, type Envelope } from "../secrets.ts";
import { sha256 } from "../kitty.ts";
const storage = () => "STORAGE_UNAVAILABLE";
export const ComputerOpLive = Workflows.layer(
  ComputerOp,
  Effect.gen(function* () {
    const homes = yield* HomeDO,
      kitties = yield* KittyDO;
    const env = (yield* Cloudflare.WorkerEnvironment) as {
      BOAT_DEV_API_KEY: string;
      KITTIES_DEPLOYMENT: string;
      KITTIES_KEK: string;
      KITTIES_RELEASE_KEY: string;
      GUEST_URL: string;
    };
    const boat = boatClient(env.BOAT_DEV_API_KEY);
    const request = <A>(
      method: string,
      path: string,
      body?: unknown,
      headers?: Record<string, string>,
    ) =>
      boat.request<A>(method, path, body, headers).pipe(
        Effect.retry({
          times: 3,
          schedule: Schedule.spaced("2 seconds"),
          while: (error) =>
            error.status === 0 ||
            error.status >= 500 ||
            error.status === 429 ||
            error.code === "idempotency_in_progress",
        }),
        Effect.mapError((error) => error.code),
      );
    const get = (id: string) =>
      request<{ sandbox: BoatSandbox }>("GET", "/sandboxes/" + encodeURIComponent(id)).pipe(
        Effect.map((value) => value.sandbox),
      );
    return Effect.fn(
      function* (payload, _executionId) {
        const home = homes.getByName("owner", { locationHint: "weur" }),
          kitty = kitties.getByName(payload.kittyId, { locationHint: "weur" });
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
          Activity.make({
            name,
            success: Schema.String,
            error: Schema.String,
            execute: execute.pipe(Effect.as(payload.kittyId)),
          });
        const poll = (name: string, check: Effect.Effect<boolean, string>) =>
          Effect.gen(function* () {
            for (let index = 0; index < 360; index++) {
              if (
                yield* Activity.make({
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
              const result = yield* request<{ success: boolean }>(
                "POST",
                `/sandboxes/${state.remoteId}/commands`,
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
              yield* request("POST", `/sandboxes/${state.remoteId}/stop`, { force: false });
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
              if (!exists)
                yield* request("POST", "/saved-snapshots", { sandboxId: state.remoteId, name });
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
              const point = JSON.parse(pending) as { name: string; remoteId: string };
              const { snapshot } = yield* request<{
                snapshot: {
                  name: string;
                  snapshotId: string;
                  sourceSandboxId: string;
                  status: string;
                };
              }>("GET", "/saved-snapshots/" + encodeURIComponent(point.name));
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
                yield* request("DELETE", `/sandboxes/${state.remoteId}`, undefined, {
                  "X-Ascii-Confirm-Delete": state.remoteId!,
                });
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
        const mode = yield* Activity.make({
          name: "plan",
          success: Schema.Literals(["ready", "create", "resume"]),
          error: Schema.String,
          execute: Effect.gen(function* () {
            const state = yield* read;
            if (state.phase === "ready" && !state.operation) return "ready" as const;
            const inventory = yield* boat.inventory.pipe(Effect.mapError((error) => error.code));
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
              const { snapshot } = yield* request<{
                snapshot: { snapshotId: string; sourceSandboxId: string; status: string };
              }>("GET", "/saved-snapshots/" + encodeURIComponent(checkpoint.name));
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
                ...(payload.kind === "restore" ? { from: checkpoint!.name } : {}),
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
                yield* request("POST", `/sandboxes/${state.remoteId}/resume`, {
                  ttlSeconds: 3600,
                  noEnv: true,
                });
              yield* home
                .bindCapacity(payload.kittyId, payload.operationId, state.remoteId!)
                .pipe(Effect.mapError(storage));
              return;
            }
            const operation = state.operation;
            if (!operation?.key || !operation.body)
              return yield* Effect.fail("CREATE_PLAN_MISSING");
            const inventory = yield* boat.inventory.pipe(Effect.mapError((error) => error.code));
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
              remote = (yield* request<{ sandbox: BoatSandbox }>(
                "POST",
                "/sandboxes",
                operation.body,
                { "Idempotency-Key": operation.key },
              )).sandbox;
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
            const release = JSON.parse(releaseBody) as { key: string; sha256: string };
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
            const prepared = yield* request<{ success: boolean }>(
              "POST",
              `/sandboxes/${state.remoteId}/commands`,
              { command: prepareBootstrap, timeoutSeconds: 30 },
            );
            if (!prepared.success) return yield* Effect.fail("BOOTSTRAP_FAILED");
            for (const [name, content] of [
              ["config.json", JSON.stringify(config)],
              ["artifact.json", JSON.stringify(manifest)],
              ["bootstrap.py", bootstrapPython],
            ])
              yield* request("PUT", `/sandboxes/${state.remoteId}/files`, {
                path: "/home/user/.config/kittyd-bootstrap/" + name,
                content,
              });
            const result = yield* request<{ success: boolean }>(
              "POST",
              `/sandboxes/${state.remoteId}/commands`,
              { command: executeBootstrap, timeoutSeconds: 600 },
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
            const failure = cause.reasons.find((reason) => reason._tag === "Fail");
            const code =
              failure?._tag === "Fail" && typeof failure.error === "string"
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
