# Cloud Kitties implementation plan

Approved design: a private always-on gateway managing one to five persistent Boat desktops. Lima remains the local VM runtime. Applications may restart; files, browser profiles and installed tools survive. The gateway is a single writer. The user selected Cloudflare Containers for hosting, with a Durable Object manifest and immutable R2 objects acknowledging gateway state writes synchronously. Deployment follows functional and recovery verification.

## Stack

1. `codex/lima-vm-poc`: existing persistent Linux desktop baseline.
2. `codex/computer-runtime`: runtime identity distinct from the LLM provider, remote IDs, lifecycle intent and operation state, durable-machine capabilities, compatibility without silent migration. Protect local credentials.
3. `codex/guest-desktop`: canonical desktop tools, Debian/Ubuntu installers, configurable browser and CDP, readiness and orderly quiescence; retain the Kitties Xvfb display and binary streaming protocol.
4. `codex/durable-state-store`: local-compatible file transactions, exclusive cache ownership, immutable chunks, revision acknowledgements, consistent captures, and atomic import into a fresh state service.
5. `codex/boat-runtime`: authenticated lifecycle API, pinned SSH host keys, isolated guest environment, clean templates, durable ownership and request reconciliation, permanent saved checkpoints, restore and immutable export.
6. `codex/cloud-gateway`: activity leases, task/scheduler wake, idle sleep, explicit stop, TTL renewal, interrupted-work recovery, durable store integration, and streamed encrypted recovery backups. Background work drains before captures; shutdown joins all writers.
7. `codex/cloud-ui`: async lifecycle progress, retained recovery inventory, independent backup status/actions, and Cloudflare Access logout.
8. `codex/cloud-deploy`: Alchemy-managed Cloudflare Container, Worker, Durable Objects, private R2 state and independent encrypted backups. Access protects `kitties.rccpr.tech` for `gabriel@garox.org`. No Docker socket or host-shell connectors. Prove container replacement, recovery and image upgrades preserve gateway state.

Each layer includes contract tests and documentation. Use `gh stack` for topology and draft PR submission. Do not deploy until the core path and failure recovery pass.

## Runtime and persistence contracts

- One runtime per deployment. Preserve Docker/Podman/Lima compatibility. `Kitty.Provider` remains the LLM profile. Persist compute kind, owner, remote ID, generation, checkpoint and pending operations independently.
- Sleep retains eligibility for scheduled/user wake. Stop disables work until explicit Start. Remove preserves recovery; purging saved checkpoints is a separate action. Old independent backups expire by policy.
- Persist the exact create request and idempotency key before sending. Retry within Boat's 24-hour idempotency window; reconcile ownership labels beyond it. An inventory error or ambiguous response must never create a blank replacement.
- Durable sleep drains work, closes the kitty browser, flushes files, stops the VM, waits for archive, promotes the latest snapshot to a stable saved name and waits for readiness before reporting success. Failed replacement preserves the previous saved checkpoint.
- If the ordinary stopped VM/snapshot has expired, recover from the permanent checkpoint into a new VM with the same logical kitty identity.
- Use private machines with `noEnv: true`, snapshots enabled, and gateway-only API and SSH keys. Verify SSH host keys obtained from the authenticated API; never forward the SSH agent. Bootstrap as root, ordinary commands as kitty.
- Export `/home/kitty` from the permanent saved snapshot. Live testing found Boat snapshot file-download can report `content_unavailable` after the source VM is deleted even though full VM restore works. Reconstruct the saved snapshot from its immutable download bundle, verify every chunk digest, apply the final inventory and stream only the home files. This does not boot a VM or allow guest writers to change the recovery point. Browser-session backups alone are insufficient.
- Full gateway backups include chats, goals, approvals, settings, runtime mapping, credentials, encryption keys and ownership identity. Drain or stop the gateway before copying its JSON state. Restore must preserve resource ownership without duplicating machines.
- On gateway restart, mark incomplete chat and goal work interrupted. Never automatically replay potentially completed external effects.

## Defaults

Boat `small` (2 vCPU, 4 GB RAM), maximum five running desktops; idle sleep after 15 minutes. Task/model/connector/command/viewer/control leases hold activity; dashboard and thumbnail polling do not wake machines. Set a one-hour Boat TTL and renew every five minutes while active; orphan compute expires if the gateway disappears. Keep one permanent saved checkpoint per kitty plus one clean template. Independent encrypted backups retain seven daily and four weekly versions. Stream home entries and gateway state into one encrypted restic archive; temporary storage holds at most one provider chunk plus the gateway capture. Only a fully completed archive is promoted as a recovery snapshot.

Cloud configuration disables local-token retrieval, bearer-token logging and host-shell connectors. Cloudflare Access injects the private gateway bearer only after verified owner identity and same-origin checks; the browser never receives the secret. A Durable Object alarm keeps the Go scheduler available while the laptop is off. Secrets never enter guest environment, image layers, Git or build context. Surface checkpoint failure, overdue backups, quota and billing failures rather than reporting success.

## Acceptance evidence required

- Real browser and terminal; screenshots, input, clipboard and stream; cancellation leaves no capture process.
- Files, browser login and installed packages survive restore into a **new** VM, beyond same-host resume grace.
- Scheduled wake works; explicit stop stays stopped; dashboard polling does not wake; activity prevents sleep.
- Gateway restart preserves ownership and machine identity, reconciles pending operations, and leaves interrupted tasks safely resumable.
- Lost create response, API outage, TTL expiry, archive failure and checkpoint replacement failure preserve work without duplicate/blank machines.
- Unauthorized desktop and control access fails. Cloud credentials stay on the gateway.
- Restore encrypted gateway and home backups on a replacement host; verify retained remote resources and recovery references.
- Run one canary first, then up to five; measure actual latency, storage and charges. Provider incompatibility blocks rollout rather than substituting another backend silently.

## Follow-ups, not first-stack substitutes

The next desktop follow-up should share the original Lumen session, wallpaper, fonts, icons and home defaults with the Boat/Lima guests, migrate existing homes without replacing user preferences, and verify fresh and restored desktop appearance. The current VM session uses stock Openbox and tint2. Interactive input latency also needs a separate improvement that preserves ownership, generation, expiry and pending-operation checks.

Vercel Sandbox/Drives, AgentFS, Fly Sprites can be evaluated later. AgentFS is a filesystem layer, not a VM disk/RAM snapshot. Cross-architecture Lima/cloud transfer is an explicit cold file handoff, not a memory or executable migration.

## Verified provider differences

- Boat saved-snapshot creates currently omit the submitted ownership labels. Only an authenticated creation receipt for the exact restored ID/generation/source checkpoint plus API-reported owner access may substitute for labels. Fresh creates and unrelated VMs retain strict label checks. Repeated real restore requests with the same idempotency key returned the same VM ID.
- Boat deletion may temporarily report `blocked` and then complete; poll the original operation rather than reissuing deletion or treating an observation timeout as completion.
- Cloudflare filesystem snapshots are tied to an image and are not authoritative gateway storage. Live state uses a private intercepted outbound HTTP binding to the owning Durable Object; no state-service secret is exposed publicly.

## Verification recorded on 2026-10-27

- A real Boat desktop retained a binary marker, installed package and persistent Chromium cookie after deleting its source VM and restoring a new remote ID. Screenshots, input, clipboard, streaming and cancellation passed.
- Immutable snapshot export recovered all 225 current home files in a checkpoint fixture, omitted eight deleted files, and preserved the cookie database. The provider's direct file export failed after source deletion, so recovery uses verified snapshot download bundles.
- Five private small VMs ran concurrently with isolated clipboard/workspace contents. A sixth was rejected. All five were archived with permanent checkpoints and the account had zero active VMs after the test. Template plus first startup took 2m14s; subsequent clones took 17–27 seconds. The five VMs reported $0.00327 combined compute cost, excluding the already-deleted template builder.
- A 512 MiB encrypted bundle used 81.6 MiB decoder peak RSS in the local probe. A separate maximum-window zstd probe used 130.3 MiB. This bounds export scratch, but does not substitute for measuring the full gateway/restic process on Cloudflare.
- The real Go gateway image persisted settings and encrypted vault data through the TypeScript/SQLite/R2 protocol, lost its local cache, then recovered both in a fresh container.
- A live `gpt-5.4-mini` request succeeded through Kitties after correcting OpenAI's completion-limit parameter. The request used 14 input and nine output tokens.
- Cloudflare owner login, anonymous denial, native private state/backup transport, a real model reply, cold restart, image replacement, encrypted backup and fresh-generation gateway recovery passed. The retired writer exited successfully and could not restart. Backup took about 2m15s; recovery took about 2m8s, including roughly 21 seconds replacing the active route.
- The owner browser displayed the real 1280×800 rectangle stream and delivered desktop control input. The viewer now survives readiness transitions and reports live status only after a decoded frame. Inputs currently take about 7–8 seconds; the desktop parity and latency follow-up remains separate.
- The approved seven archived test VMs and eight saved checkpoints were deleted and verified absent. Production resources were excluded.
- The requested `gpt-6-luna` model accepted an image, correctly identified its colors, called a function with those observations, and completed the tool-result continuation through the Responses API.
