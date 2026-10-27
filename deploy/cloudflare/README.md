# Cloudflare gateway

This deployment runs one Kitties gateway in a Cloudflare Container and keeps each kitty's desktop on Boat. Cloudflare Access admits `gabriel@garox.org` at `https://kitties.rccpr.tech`. The Worker verifies the platform-provided Access identity before forwarding a request with the gateway's private bearer token. The browser never receives that token. Both workers.dev and preview URLs are disabled.

The package pins Alchemy `2.0.0-beta.84`, its Cloudflare provider, and Effect `4.0.6`. The deployment uses Alchemy's supported async Worker binding and the native Durable Object Container API. It does not depend on the older Container helper class.

## State and restarts

The gateway's `/var/lib/kitties` directory is a disposable cache. `internal/statefs` hydrates it before loading stores and synchronously publishes persistent mutations. One active SQLite-backed Gateway Durable Object owns the manifest and revision; a small coordinator stores the active generation. Private R2 objects hold immutable file contents. A write is successful only after its manifest transaction and storage synchronization complete. A failed commit makes the Go gateway stop.

The private hostname `http://kitties-state.internal` is intercepted by a Worker entrypoint installed by the owning Durable Object. Its trusted props carry the object identity and process epoch. No state endpoint or storage credential is exposed on the public Worker route. An old process must stop before a new epoch starts; stale epochs cannot read or commit state. Restarting the Durable Object reinstalls interception for the existing process without changing its epoch.

The wire protocol is:

- `GET /v1/manifest`: `{ revision, files: [{ path, mode, parts: [{ sha256, size }] }] }`.
- `PUT /v1/blob/{sha256}`: raw bytes and `Content-Length`; R2 verifies the SHA-256 checksum. The limit is 512 MiB per blob.
- `GET /v1/blob/{sha256}`: raw bytes scoped to the owning gateway.
- `POST /v1/import/begin`: `{ id, files, batches }` reserves an empty target for the current epoch; `/v1/import/batch` accepts `{ id, index, mutations }` in bounded, idempotent batches. `/v1/import/finalize` accepts `{ id }` and publishes all verified staging rows in one SQLite transaction. Incomplete imports remain invisible, and stale writers cannot finalize them.
- `POST /v1/commit`: `{ id, baseRevision, mutations }`; mutations are `put`, `append`, or `delete`, with relative paths, file mode, parts, and an optional recursive deletion flag. An atomic rename is a put and delete in one commit.

Commit metadata is limited to 2 MiB. Revision conflicts and stale epochs return 409. The most recent 1,025 commit receipts are retained for idempotent retry after a lost response. Reusing an id with different content fails. SQLite stores file parts in separate rows, so a growing journal does not hit a single key-value record limit. Blobs must exist with the declared size before a commit can reference them. Unreferenced R2 objects are currently retained; primary storage is not an independent backup or a historical restore interface. Both primary and backup buckets use Alchemy's retain policy, so removing the stack does not delete their contents.

A private five-minute Worker schedule boots the installation without requiring a first login and retries recovery after prolonged outages. A 60-second Durable Object alarm keeps the Go scheduler and Boat TTL renewal available without an open browser. Each start sets a ten-minute container inactivity timeout. On an image or environment update, the object compares the image digest and a configuration fingerprint, sends SIGTERM, waits up to two minutes, and confirms the old container stopped before granting a new epoch. A fresh image hydrates from the durable manifest; readiness allows ten minutes for restoring larger state. The live platform took roughly five minutes after Worker deployment to apply image metadata to an active instance, so verify the running image or newly served asset hash before treating an upgrade as complete. Container filesystem snapshots are unnecessary for correctness: Cloudflare's snapshots expire after 30 days without restoration and cannot restore across image versions.

Configuration starts from immutable `/etc/kitties/default.yaml`; changes made in Settings live in durable `settings.json`. The initial model is `gpt-6-luna`, verified with image input and a complete function-call round trip on the configured OpenAI account. Its OpenAI profile uses the Responses API so desktop tools remain available with reasoning. No kitty or Boat VM is created by the deployment itself.

## Independent backups

Restic encrypts recovery copies into a separate R2 bucket. A private Worker entrypoint implements restic's REST protocol at `http://kitties-backups.internal/`, including streamed uploads, paginated listings, and byte-range reads. Native outbound interception supplies the owning gateway identity and epoch; retired or stale instances cannot access the repository. Every replacement fences old requests and drains pending storage mutations before starting its new process. The repository is shared across gateway generations and is never exposed on a public route. Alchemy generates the repository encryption password independently and supplies it only as a secret container binding. No S3 API token is required. Preserve the Alchemy deployment state and store the repository password in a separate recovery location before relying on these backups. Keeping encrypted objects without their password is insufficient for recovery.

The coordinator streams immutable Boat home entries directly into restic while the capture gate is held, then captures gateway state and releases the gate. It does not stage a full home or archive on the gateway disk. Seven daily and four weekly snapshots are retained. Settings shows the latest successful snapshot, errors, overdue status, and a manual backup action. Removing a kitty retains its Boat checkpoint; purging that checkpoint does not remove independent restic backups. Both R2 buckets share the Cloudflare account, so this provides recovery from gateway, provider-checkpoint, and application loss, not loss of the Cloudflare account itself.

## Operator restart and recovery

The authenticated owner can call `/v1/operator/gateway` for the active generation and recovery status. Operator mutations require the same-origin Access session, an explicit confirmation value, and a full immutable restic snapshot ID. They never accept raw state or storage credentials.

From the browser console on the signed-in gateway, a cold restart is:

```js
await fetch("/v1/operator/gateway/restart", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ confirm: "restart gateway" }),
}).then((r) => r.json());
```

To restore a verified backup into a fresh generation, first copy its complete snapshot ID from backup status. This replaces the active gateway's state with that backup and retires its current writer:

```js
const snapshot = "<full 64-character snapshot ID>";
const operation = crypto.randomUUID();
await fetch("/v1/operator/gateway/restore", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    operation_id: operation,
    snapshot_id: snapshot,
    confirm: `restore ${snapshot}`,
  }),
}).then((r) => r.json());
// Poll until operation.phase is complete or failed:
await fetch("/v1/operator/gateway").then((r) => r.json());
```

Reusing the operation ID safely retrieves that operation; it cannot name a different snapshot. The coordinator durably closes maintenance admission, drains existing activity and any backup promotion or retention still in flight, and verifies and decrypts the archive while that hold remains active. It checks Boat ownership and generation references before changing the active generation. A failed preflight releases the hold before reporting failure; an interrupted release retries from persisted state. Delayed prepare commands cannot reacquire a cancelled hold. It then durably retires the old generation, drains and confirms its process stopped, and starts a fresh generation with the requested snapshot. Only a healthy replacement becomes the active route. Retirement and activation failures retry from persisted phase state. Retired generations cannot restart from alarms, requests, or later deploys. Their manifests and blobs remain retained, and the existing backup bucket, repository password, vault key, and Worker authentication bindings are reused.

## Bootstrap recovery into empty cloud state

For initial bootstrap into an already empty authoritative store, set `KITTIES_RESTORE_SNAPSHOT` to a successful restic snapshot ID (or `latest`) when planning and deploying. Use the operator route above to replace an existing generation safely. A new Alchemy application does not automatically gain access to an old application's backup bucket or secrets. Its startup restores the gateway metadata and bootstrap secrets, imports them through the private state bridge, and then performs normal hydration. Computer home payloads stream past this gateway-only restore; they are not staged on the container disk. The import checks the empty manifest again, stages bounded batches, and commits the complete state atomically. Existing primary state is never overwritten. Later restarts verify the persisted recovery receipt matches the requested snapshot before skipping the restore; unrelated populated state fails clearly.

Preserve the existing Alchemy state so the backup bucket, repository password, and original vault key remain available. If recovering with a separately managed vault key, provide the original base64 `KITTIES_VAULT_KEY` through the private environment file. A mismatched configured key fails startup rather than replacing or discarding encrypted data. The current Worker bearer token and supplied Boat/OpenAI bindings remain authoritative. Restoring gateway records does not itself recreate lost Boat computers; use the streamed computer-home recovery procedure in `docs/BACKUPS.md` for provider loss.

```sh
KITTIES_RESTORE_SNAPSHOT=<snapshot-id> npm run plan -- --env-file ../../.env --no-input
# After reviewing the plan and confirming the target primary state is empty:
KITTIES_RESTORE_SNAPSHOT=<snapshot-id> npm run deploy -- --env-file ../../.env --no-input --yes
```

Remove the restore variable after verification. Do not run a replacement gateway against the same Boat fleet while its previous gateway is still active.

## Verify and plan

Keep the repository-root `.env` private and gitignored. It supplies `BOAT_DEV_API_KEY` and `OPENAI_API_KEY`. Alchemy uses the existing `default` Cloudflare OAuth profile and refreshes it through its own credential manager; Wrangler's login is separate. Do not set `CI=true` locally, because Alchemy then intentionally ignores saved profiles.

```sh
cd deploy/cloudflare
npm ci
npm run typecheck
npm test
npm run smoke:import
npm run smoke:backups
npm run plan -- --env-file ../../.env --no-input
```

Override `KITTIES_CLOUDFLARE_DOMAIN` and `KITTIES_ACCESS_EMAIL` when deploying a separate owner environment. Alchemy generates and retains the gateway token, vault encryption key, and independent backup password as secrets in its deployment state. Preserve that deployment state when recovering the installation.

Build and test a cold restart locally:

```sh
# Repository root
docker build --platform linux/amd64 -f deploy/cloudflare/Dockerfile -t kitties-cloudflare:verify .
cd deploy/cloudflare
KITTIES_SMOKE_ENV_FILE=../../.env npm run smoke
```

The smoke test runs two disposable containers against the real TypeScript state protocol and SQLite. It writes a provider setting and synthetic encrypted vault entry, destroys the first container and its cache, advances the epoch, and verifies recovery in a fresh container. The Boat key is used only by the gateway's read-only account readiness check. No VM or model request is created. The containers are removed on completion.

Deployment is a separate final step after the independent backup restore and cloud canary checks:

```sh
npm run deploy -- --env-file ../../.env --no-input --yes
```

For initial acceptance, `KITTIES_LIVE_VERIFY=true` temporarily adds an unrouted verification Worker. Its private schedule exercises one desktop and model reply, cold restart, an image replacement, encrypted backup, fresh-generation recovery, and retirement fencing. It pauses at `await-image-update` until a changed image is deployed; advance the Docker image revision label for that check. Inspect only the redacted phase records in Alchemy logs, then deploy without the verification flag to remove the Worker and its schedule. The canary kitty remains stopped and its chat records the model result. Separately verify anonymous denial and owner Access login. The local smoke does not exercise Cloudflare's native outbound interception, Access enrollment, or container scheduling.

Live acceptance on 2026-10-27 verified owner Access login, anonymous login redirect, native private state and backup interception, a Boat desktop PNG and SSH command as `kitty`, an OpenAI reply, cold hydration, image replacement, and recovery from an encrypted snapshot into a fresh gateway generation. The previous container exited successfully and its retired generation rejected restart. The backup took about two minutes and fifteen seconds; recovery took about two minutes, including roughly twenty seconds while replacing the route. The final owner browser check also loaded the new viewer, displayed the persistent Linux desktop, and accepted control input. Opening the remote connection takes longer than the original six-second client deadline; the viewer now remains mounted through runtime startup and waits up to thirty seconds for its first decoded frame. The current Boat lifecycle checks still add about seven to eight seconds to each input request; reducing that latency is a separate optimization.

## Local resource acceptance

The amd64 image was exercised with Docker limits matching `basic`: 1 GiB RAM, no additional swap, and 0.25 CPU. A real Go-to-TypeScript durable-state cold restart peaked at 52.1 MiB initially and 53.3 MiB after hydration. A separate local fixture completed five concurrent scripted desktop tasks while restic encrypted a 4,529,848,320-byte stream using one 480 MiB compressed scratch file. The container peaked at 715.3 MiB including page cache, used 481 MiB of temporary storage, and did not OOM. The encrypted repository was mounted outside the container, representing remote backup storage.

This bounds the local gateway and restic workload without model charges or extra Boat VMs. It is not a claim that a fixture covers every real home, Cloudflare's network behavior, or all browser workloads; the live Boat export and cloud recovery canaries remain separate checks.

## Cost

At 730 running hours, `basic` has about $6.35 of memory and $0.69 of disk charges after included usage, plus the $5 Workers plan and actual CPU consumption. The first 6.25 vCPU-hours are included. A single continuously active 128 MB Durable Object fits within the included 400,000 GB-seconds if that account allocation is otherwise unused. R2 includes 10 GB-month, one million writes, and ten million reads. Account usage, logs, traffic, backup storage, and Boat desktops are additional. The gateway starts on `basic` (1 GiB RAM, 0.25 vCPU, 4 GB disk). The deployed instance API confirmed 1,024 MiB RAM, 0.25 vCPU, and 4,000 MB disk on 2026-10-27; the current scheduling-policy documentation disagrees about accepting this legacy size, so verify allocation again before changing scheduling policy or sizing. A custom 512 MiB / 0.25 vCPU instance is unavailable: custom sizes require at least one vCPU and 3 GiB RAM per vCPU, with at most 20 GB disk by default. Large home backups must stream rather than stage the fleet on this disk. A small local fixture does not prove capacity for full homes.

Sources: [restic REST protocol](https://github.com/restic/restic/blob/master/doc/REST_backend.rst), [Container API](https://developers.cloudflare.com/containers/api/durable-object-container/), [outbound handlers](https://developers.cloudflare.com/containers/configuration/outbound-traffic/), [container pricing](https://developers.cloudflare.com/containers/platform/pricing/), [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [instance limits](https://developers.cloudflare.com/containers/platform/limits/), and [Alchemy containers](https://alchemy.run/cloudflare/compute/containers/).
