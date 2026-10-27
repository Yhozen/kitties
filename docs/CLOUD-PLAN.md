# Cloud Kitties implementation plan

Approved design: a private always-on gateway managing one to five persistent Boat desktops. Lima remains the local VM runtime. Applications may restart; files, browser profiles and installed tools survive. The gateway is a single writer with durable local storage. Deployment follows functional and recovery verification.

## Stack

1. `codex/lima-vm-poc`: existing persistent Linux desktop baseline.
2. `codex/computer-runtime`: runtime identity distinct from the LLM provider, remote IDs, lifecycle intent and operation state, durable-machine capabilities, compatibility without silent migration. Protect local credentials.
3. `codex/guest-desktop`: canonical desktop tools, Debian/Ubuntu installers, configurable browser and CDP, readiness and orderly quiescence; retain the Kitties Xvfb display and binary streaming protocol.
4. `codex/boat-runtime`: authenticated lifecycle API, pinned SSH host keys, isolated guest environment, durable ownership and request reconciliation, permanent saved checkpoints, restore and export.
5. `codex/cloud-lifecycle`: activity leases, task/scheduler wake, idle sleep, explicit stop, TTL renewal, restart recovery, async lifecycle API and UI progress.
6. `codex/cloud-deploy`: gateway without Docker socket, private ingress, durable state, encrypted independent backups and tested recovery. Alchemy manages Cloudflare Tunnel/DNS, Access and R2; the Go gateway runs on a durable Linux host.

Each layer includes contract tests and documentation. Use `gh stack` for topology and draft PR submission. Do not deploy until the core path and failure recovery pass.

## Runtime and persistence contracts

- One runtime per deployment. Preserve Docker/Podman/Lima compatibility. `Kitty.Provider` remains the LLM profile. Persist compute kind, owner, remote ID, generation, checkpoint and pending operations independently.
- Sleep retains eligibility for scheduled/user wake. Stop disables work until explicit Start. Remove preserves recovery; purging saved checkpoints is a separate action. Old independent backups expire by policy.
- Persist the exact create request and idempotency key before sending. Retry within Boat's 24-hour idempotency window; reconcile ownership labels beyond it. An inventory error or ambiguous response must never create a blank replacement.
- Durable sleep drains work, closes the kitty browser, flushes files, stops the VM, waits for archive, promotes the latest snapshot to a stable saved name and waits for readiness before reporting success. Failed replacement preserves the previous saved checkpoint.
- If the ordinary stopped VM/snapshot has expired, recover from the permanent checkpoint into a new VM with the same logical kitty identity.
- Use private machines with `noEnv: true`, snapshots enabled, and gateway-only API and SSH keys. Verify SSH host keys obtained from the authenticated API; never forward the SSH agent. Bootstrap as root, ordinary commands as kitty.
- Export `/home/kitty` from a consistent stopped snapshot. Boat's default home export would omit this directory. Browser-session backups alone are insufficient.
- Full gateway backups include chats, goals, approvals, settings, runtime mapping, credentials, encryption keys and ownership identity. Drain or stop the gateway before copying its JSON state. Restore must preserve resource ownership without duplicating machines.
- On gateway restart, mark incomplete chat and goal work interrupted. Never automatically replay potentially completed external effects.

## Defaults

Boat `small` (2 vCPU, 4 GB RAM), maximum five running desktops; idle sleep after 15 minutes. Task/model/connector/command/viewer/control leases hold activity; dashboard and thumbnail polling do not wake machines. Set a one-hour Boat TTL and renew every five minutes while active; orphan compute expires if the gateway disappears. Keep one permanent saved checkpoint per kitty plus one clean template. Independent encrypted backups retain seven daily and four weekly versions.

Cloud configuration disables local-token retrieval, bearer-token logging and host-shell connectors. Secrets never enter guest environment, image layers, Git or build context. Surface checkpoint failure, overdue backups, quota and billing failures rather than reporting success.

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

Vercel Sandbox/Drives, AgentFS, Fly Sprites and a complete Cloudflare Containers gateway can be evaluated later. AgentFS is a filesystem layer, not a VM disk/RAM snapshot. Cross-architecture Lima/cloud transfer is an explicit cold file handoff, not a memory or executable migration.
