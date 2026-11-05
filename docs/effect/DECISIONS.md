# Decisions

This records what was decided for the Effect rewrite, by whom, and what each decision removes.
The plan is in [PLAN.md](PLAN.md). Behaviours worth keeping from the Go system are in
[CURRENT-SYSTEM.md](CURRENT-SYSTEM.md). Feature dispositions are in [PARITY.md](PARITY.md).

A decision changes only through a new entry that supersedes the old one. Do not edit an old entry.

## Owner decisions

| # | Date | Decision | What it removes or changes |
|---|---|---|---|
| D1 | 2026-10-31 | **Cloudflare only.** The gateway becomes a Worker with Durable Objects and Alchemy Effect Workflows. | The local gateway, the Docker/Podman and Lima runtimes, the cross-platform CLI binaries (Linux, macOS, Windows, Termux), `kitties -demo`, self-update and the Updates screen. |
| D2 | 2026-10-31 | **The web UI is the only client**. Current delivery requirements are in D17. | The Wails desktop app (`desktop/*.go`) and the Android wrapper (`android/`). The Wails and Android code paths in `desktop/frontend/src/api.ts`. |
| D3 | 2026-10-31 | **Strangler in place.** The new monorepo lives in this repo and deploys side by side at `next.kitties.rccpr.tech`. The Go deployment stays live and frozen (fixes only) until cutover in Phase 10. | No route-by-route sharing of state: with D5 there is nothing to share. Cutover is a domain switch with a tested rollback. |
| D4 | 2026-10-31 | **Keep Boat** for cloud desktops. | Other VM providers are not evaluated now. |
| D5 | 2026-10-31 | **Start fresh.** No Go state is migrated: chats, goals, settings, vault secrets, kitty records and Boat checkpoints. | No importer and no adoption of existing desktops. Old R2 buckets and Boat checkpoints are kept until the owner confirms deletion. |
| D6 | 2026-10-31 | **Effect AI and MCP first.** Providers come from `@effect/ai-*`; connectors become remote MCP servers wherever one exists. | Most native connector tables. |
| D7 | 2026-10-31 | **Single owner** behind Cloudflare Access. | Multi-user and multi-tenant design. |
| D8 | 2026-10-31 | **A full rewrite in TypeScript with Effect.** **Alchemy Effect Workflows on Durable Objects** take the role Temporal plays at Cursor. | The Go gateway, orchestrator and chat service. |
| D9 | 2026-10-31 | **Vite+** (`vite-plus`, the `vp` CLI) is the toolchain, in a pnpm workspace. | `Makefile`-driven builds for the new code. Go keeps its own CI until it is deleted. |
| D10 | 2026-10-31 | **Remove the coverage rules.** | `COVER_MIN`, `make cover` and the CI coverage gate. No coverage thresholds in the new code. |
| D11 | 2026-10-31 | **Phase 1 commits the backing documentation and the plan.** | — |
| D12 | 2026-11-01 | **Stack the work on top of draft PR #13** (`codex/durable-state-recovery`). | Phase PRs merge when the existing stack does. |
| D13 | 2026-11-02 | **Use the current Sign in with ChatGPT registration and public Responses API**, with a one-time Mac helper and Cloudflare-owned renewal. Keep usage disabled until live next admission. See [contract and acceptance](CHATGPT.md). | Codex client ID, localhost URL paste-back and backend-api inference. No automatic API-key spending on subscription limits. Other subscription/local providers remain dropped. |
| D14 | 2026-11-01 | **Drop the long-tail connectors.** The generic `http` tool and the webhook presets cover simple cases. Connectors can be re-added on demand. | email (SMTP), Mastodon, Bluesky, X, LinkedIn, Facebook, Instagram, WhatsApp, Matrix, Spotify, TIDAL, Dropbox, Zendesk, Trello, Gitea, GitLab, Nextcloud, Figma, Google Sheets, Motita. |
| D15 | 2026-11-01 | **Live desktop before brains.** The latency fix ships right after the walking skeleton. | Phase order: skeleton → live desktop → brains → lifecycle → desktop tasks → autonomy → integrations → cutover. |

## Drops that follow from these decisions

| Dropped | Follows from | Why |
|---|---|---|
| `internal/yamlx` (hand-written YAML parser) | D8 | It existed only because of the Go stdlib-only rule. Configuration moves into the UI and DO SQLite. |
| `internal/statefs` and the Go↔TS state protocol | D1, D5, D8 | DO SQLite rows replace the per-file blob and commit layer. |
| restic archives | D5 | There is no old data to restore. New backups are DO point-in-time recovery plus encrypted exports (Phase 10). |
| SSH to Boat VMs | D1, D4 | Boat's public API offers `POST /sandboxes/{id}/commands` and file writes over HTTPS, which a Worker can call. `kittyd` carries everything else. |
| The text tool protocol (`@tool`, `@connector` lines) | D6 | It existed for Claude Code and local servers without tool support. Every kept provider calls tools natively. |
| Server-side GIF replay | D8 | A client-side slideshow of stored steps replaces it. Phase 7. |
| Shell, Apple/Things/OmniFocus connectors | D1 | They need process execution or macOS. |
| Built-in OAuth apps compiled into binaries | D1 | The owner registers their own apps; client secrets live in Worker secrets. |

## Backup semantics change

Today a nightly restic archive holds the gateway state and every desktop home, encrypted
independently of Cloudflare and Boat. After the rewrite:

- Owner data in Durable Objects has 30-day point-in-time recovery. A nightly encrypted export
  goes to a separate R2 bucket with a lock rule the gateway cannot remove (Phase 10).
- Desktop homes rely on Boat permanent checkpoints. These live with the same provider and are
  reachable with the same API key, so they are **not** an independent backup. A later option is
  for `kittyd` to export the browser profile and work directory to the locked bucket.
- `next` is not production until Phase 10. Data entered before then is test data.

## Guest helpers that stay outside Effect

The guest daemon `kittyd` is Effect on Bun. These helpers stay as they are because they are
small, proven and local to the guest:

| Helper | Language | Role |
|---|---|---|
| `kitty-grab` | C (X11 XShm, libjpeg) | Change-only frame capture. The rectangle diff moves into the guest. |
| `kitty-ocr`, `kitty-quiesce`, `kitty-clip`, `kitty-shot`, `kitty-stream`, `kitty-ready`, `kitty-launch`, `kitty-install`, `kitty-apt`, `kitty-theme`, `kitty-desktop`, `kitty-shelf-*`, `setup.sh`, `finish.sh`, `install-desktop.sh` | POSIX shell | Desktop operations, shelf widgets and provisioning. |
| `kitty-backup`, `kitty-restore` | POSIX shell | Browser-session export. Kept for the optional profile export to the locked bucket. |
| `kitty-open.py`, `kitty_browser.py`, `desktop-defaults.py`, `build-theme.py` | Python | Browser launch and profile, desktop defaults, icon theme. |

`kitty-page.py`, the custom CDP helper, is replaced by agent-browser in Phase 7.

## Technical decisions from research and review

| # | Decision | Reason | Revisit if |
|---|---|---|---|
| T1 | Run workflows on Alchemy's `DurableObjectEngine`. | One DO per run keeps the journal close to the code and needs no extra Cloudflare product. | Spike 1 fails. The fallback is `NativeEngine`, whose cost is noted in the plan. |
| T2 | Pin exact versions: `effect@4.1.1` (one instance via pnpm override), `alchemy` and `@alchemy.run/cloudflare` `2.0.0-beta.84`. | beta.84 is the first release with Workflows. The Effect AI, SQL and test packages need effect `^4.1.1`. | A bump PR re-runs the spike-1 suite. |
| T3 | `kittyd` dials out to the kitty's DO over WebSocket. | Guests have internet egress, and hibernatable WebSockets are accepted by the DO. | Spike 3 fails. Plan B is the DO dialing a private Boat `POST /host` URL with mutual auth. |
| T4 | The effect ledger lives in the actor that performs the effect, and `kittyd` keeps its own intent log. | Every deploy resets DOs and sockets. Reconciling after reconnect avoids asking the owner about every in-flight action. | — |
| T5 | Perception uses agent-browser for web pages and agent-desktop for native apps, with pixel tools as the fallback. | Most kitty work happens in the browser. agent-desktop needs AT-SPI work on our guest. | The Phase 7 A/B decides the default. |
| T6 | Whether frames move to a separate `KittyStreamDO` is decided by spike 4. | Frame fan-out must not slow input acknowledgements. | — |
| T7 | Pin Alchemy, Cloudflare and Domain at `2.0.0-beta.85`, retaining Effect `4.1.1`. Supersedes T2's Alchemy pin. | The published Domain integration requires the matching family. Retain the workflow recovery patch; upstream now supplies the crypto compatibility fix. See [upgrade guidance](../ALCHEMY_UPGRADE.md). | Local workerd regression failures block the upgrade; cloud rollout also needs staging and authorized state-store migration. |

## D16 — 2026-11-01: Hard cutover, fresh data

The owner confirmed: “we don't have customers, you can do hard cutovers and no need to make
migrations.” This supersedes D3's extended parallel rollout and Phase 10's seven-day soak gate.
Use a separate deployment while building; after the functional, recovery and security gates pass,
switch the production hostname directly. No compatibility bridge, importer or old-state
reconciliation is required. Retain the old buckets and Boat checkpoints under D5.

## D17 — 2026-11-04: Online browser client

The owner selected a regular website for desktop and mobile browser tabs. This supersedes
D2's earlier delivery requirements and the shell/phone-notification requirements in the rewrite
plan. Build the frontend with Foldkit on the existing CAFE stack and Vite+ workspace. The client
requires a network connection; pending approvals and help remain available in the web UI.

## T7 — 2026-11-01: agent-desktop FFI exists

The current upstream README exposes a native FFI library as well as the CLI. This supersedes
any assumption that every action must spawn a process. Start with the CLI and measure first.
