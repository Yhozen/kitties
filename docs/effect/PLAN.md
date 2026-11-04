> Frontend update (2026-11-04): the client is an online website for desktop and mobile
> browsers. [Development](../DEVELOPMENT.md) defines the current CAFE/Foldkit setup.
> Earlier shell delivery and phone-notification requirements below are superseded.

> ChatGPT update (2026-11-02): [CHATGPT.md](CHATGPT.md) supersedes the Codex public-client,
> paste-back and backend-api details below. Use Kitties' dynamic registration, a one-time Mac
> helper, Cloudflare renewal and the public Responses API. Keep usage disabled through admission.

<!-- Status: approved by the owner on 2026-11-01. All ten phases are deployed; production cutover and recovery passed on 2026-11-01. -->
<!-- File:line references point at commit 7f408a1 (codex/durable-state-recovery); permalinks are in CURRENT-SYSTEM.md. -->

# Kitties on Effect: the plan

Companion documents: [README](README.md) (index and phase status) · [DECISIONS](DECISIONS.md) ·
[PARITY](PARITY.md) · [CURRENT-SYSTEM](CURRENT-SYSTEM.md) · [RESEARCH](RESEARCH.md) ·
[RISKS](RISKS.md) · [LATENCY-BASELINE](LATENCY-BASELINE.md).

## Context

Kitties is ~66k lines of stdlib-only Go. In production it runs as a Go process inside a Cloudflare
Container behind two Durable Objects (DOs), and drives Boat VMs by forking a new `ssh` per
command. Its worst problems are architectural:

- **Latency.** One human input travels Worker → Coordinator DO → Gateway DO, which re-runs the
  container start checks and a health probe on every request. From there:
  - Go takes a **global lifecycle lock** shared by all kitties.
  - It runs an unfiltered account-wide `GET /sandboxes`, then `GET /sandboxes/{id}` and
    `POST /sshkey`.
  - It forks `ssh` with `ControlMaster=no` and runs a remote guard with python startup before
    `xdotool` (`internal/boat/input.go:11-77`, `ssh.go:104-213`).

  An interrupted baseline measured 6.3–8.7 s per input; about 70% of that is avoidable
  control-plane work. Every chat turn on Boat also re-runs `startComputer`, which pipes a ~580 KB
  installer over SSH (`internal/orchestrator/activity.go:66`). There is no token streaming. Every
  past full 1280×800 PNG goes back to the model on every round (`internal/chat/chat.go:1437-1451`),
  with no prompt caching.
- **Reliability.** Every long wait lives only in memory: the task loop, ask_help, delegation,
  approvals and notifications. A restart marks work interrupted, and a human has to say
  "continue". Any state-write failure `os.Exit(1)`s the gateway (`internal/statefs/statefs.go:310-315`,
  ~10 min outage on 2026-10-28). On top of that:
  - One global write mutex, with 2 synchronous DO round trips per write.
  - Whole-session JSON is rewritten on every step, and blobs are never garbage-collected.
  - Webhooks are acked and then dropped when a goal is busy, and Access blocks them anyway.
  - Live streams fall back rects → MJPEG → polling.
  - "always"-risk actions are never enforced (`internal/approvals/approvals.go:162-183`).
- **Capabilities.** Nothing continues after an approval. Delegation polls synchronously. There is
  no MCP, connector tools are untyped `{action, text}`, and there is no accessibility tree.

**Owner decisions (2026-10-31 / 11-01):**
- Platform: **Cloudflare only**. The local gateway, Docker/Lima, CLI binaries, self-update, Wails
  and Android all go. The only client is a **web app**. Desktops stay on **Boat**.
- Data: **start fresh**, with no migration of any Go state, including Boat checkpoints.
- Integrations: **Effect AI + MCP first**. Keep **only the ChatGPT/Codex sign-in**, behind a flag.
  Drop the long-tail connectors; generic `http` covers them.
- **Single owner**.
- **Hard cutover, no migration** (owner update 2026-11-01): a new monorepo in this repo is
  verified at `next.kitties.rccpr.tech`, then takes over production once its gates pass.
  No extended parallel rollout or seven-day soak is required. Work is **stacked on top of
  draft PR #13** (`codex/durable-state-recovery`).
- **Vite+**, and **no coverage rules**.
- **Alchemy Effect Workflows on DOs** instead of Temporal.
- Evaluate **agent-desktop**.
- **Phase 1 commits the backing docs and the plan.** **Live desktop comes before brains.**

**Assessment: worth it under these decisions.** Every fix above needs a durable workflow engine,
one actor per entity, and a persistent guest channel. Retrofitting Go-in-a-container means
building all three anyway. The decisions also delete most of the code:
- yamlx, statefs, restic, SSH;
- the local runtimes, CLI, self-update, Wails and Android;
- the text tool protocol, most subscription logins, and ~35 connector tables.

The estimate is ~18–25k lines of TypeScript, against ~45k non-test Go lines. The main risk is
maturity: `alchemy/Workflows` first shipped in `2.0.0-beta.84` on 2026-10-24, and Effect 4 went GA
on 2026-10-01. Phase 3 is the go/no-go gate.

## How Kitties gets better

| Area | Today | New mechanism | Target |
|---|---|---|---|
| Input latency | ssh fork + 3 Boat API calls + global lock per input | `kittyd` holds an outbound WS to the kitty's DO; browser input goes over WS to the same DO; fencing by authenticated (remoteId, generation, epoch); EU `locationHint` | warm ack p95 < 250 ms; click-to-visible p95 < 500 ms |
| Agent step | ssh per action, startComputer per turn, full-history images | readiness held in KittyDO; batched actions; guest downscales model images; last 1–2 shots in context; prompt caching; reasoning carried across rounds | non-model overhead p95 < 1 s |
| Chat | whole replies; POST blocks for up to 4 rounds | `streamText` deltas; POST with `messageId` returns 202; event ids + `Last-Event-ID` resume | first token p95 < 2 s |
| Crash/redeploy | work marked interrupted | turns, waits and effects run as Effect Workflows; kittyd reconciles intents after reconnect | redeploy mid-task resumes with no duplicate effects and no owner involvement |
| Side effects | replay ban by stopping everything | `EffectLedger` in the dispatching actor + guest intent log; unknown outcome → `DurableDeferred` for the owner | kill-after-dispatch never re-sends |
| State | global mutex, exit on failure | `@effect/sql-sqlite-do` per actor, R2 blobs with lifecycle rules, typed errors per request | no process-wide failure mode |
| Approvals | held, then nothing | `ApprovalWorkflow`: args digest → decision → runs once → kitty resumes; reminders and expiry | approving in the browser after Access authentication resumes the turn |
| Goals/events | 1-min ticker; drops when busy | per-slot goal workflows; signed webhooks on a bypass path keyed by delivery id; chat inbox queue | 0 drops in a 100-delivery burst |
| Integrations | 48 untyped connector kinds | Effect AI providers; remote MCP; typed native tools | each MCP server passes or has a written disposition |
| Perception | pixels + OCR + custom CDP helper | agent-browser (DOM refs) + agent-desktop (AT-SPI refs) via kittyd, pixel fallback | A/B decision rule (Phase 7) |
| Security | plaintext secrets; backups deletable by the gateway | AES-GCM envelopes (kid, AAD); PITR; locked, retained export bucket | scan finds no plaintext secrets in rows or journals |

## Target architecture

```
Web app (Preact; HttpApi-derived client) ─HTTPS/SSE/WS─▶ Worker "gateway"
  owner routes: Access + in-Worker identity check (fail closed); explicit allow-list router
  bypass routers (cannot reach /v1): /hooks/*, /guest/*, /.well-known/oauth-*, MCP CIMD path
  ├─ HomeDO (singleton): settings, provider profiles, encrypted secrets, OAuth connections, approval
  │     rules + idempotent trust stats, skills, goals registry, idempotent budget counters,
  │     capacity leases (≤5, reconciled with Boat), DO registry, run-health, push subscriptions
  ├─ KittyDO (per kitty, EU): record, Boat state + creation receipts, generation, guest conn epoch,
  │     leases, TTL/idle/hold alarms, control receipts, desktop EffectLedger, guest + control WSs
  ├─ KittyStreamDO (optional; decided by spike 4): frame fan-out with per-viewer credit
  ├─ ChatDO (per chat): turns/steps as rows, event log with ids, inbox queue (messageId dedupe)
  ├─ Workflow DOs (alchemy DurableObjectEngine, one per run; desktop-bound runs started from KittyDO
  │     so they are placed in the EU): Turn, Attempt (child), Approval, GoalSlot, GoalRun,
  │     Delegation, ComputerOp, Sleep, Export, Digest, Notify
  └─ R2: screenshots (lifecycle TTL), artifacts, kittyd releases; exports in a retained, locked bucket
Boat VM ─ kittyd (Effect on Bun, `bun-linux-x64-baseline`, own system user, token file root 0600,
          joins the desktop's DISPLAY/D-Bus via an address file) ─outbound WSS─▶ KittyDO
          wraps kitty-grab (C; rect diff moved into the guest), xdotool (stdin for text), scrot,
          kitty-quiesce, kitty-ocr, agent-browser (CDP :19222), agent-desktop (AT-SPI)
Boat REST from the Worker: lifecycle, POST /commands + file write (bootstrap, token, upgrade,
          fallback), POST /host (plan B with mutual auth), webhooks (hints only). No SSH.
```

## Design rules (apply to every phase)

1. **At-most-once effects.** The `EffectLedger` lives in the actor that performs the effect:
   KittyDO for desktop and guest effects, and the workflow DO's own SQLite or a per-connection
   HomeDO table for connector effects.
   - `intentId = Activity.idempotencyKey(name)`, never random.
   - The `started` row is committed before dispatch.
   - kittyd keeps an fsynced intent log of {generation, intentId, status, result} for at least
     24 h. On reconnect it sends `reconcile`, and KittyDO resolves `started` rows before declaring
     anything unknown. Only a truly unknown outcome parks on a `DurableDeferred` for the owner.
   - Acks are per action. Messages carry {generation, epoch, intentId, deadline}, and kittyd drops
     stale or queued work when a socket closes.
   - Never wrap a non-idempotent body in `Effect.timeout` or a race: interrupts re-run the body.
     Timeouts live in KittyDO, where they resolve to "unknown".
   - MCP tools have no provider idempotency, so irreversible ones (payments) are always "ask".
2. **Deterministic, unique names.** The journal key is `name/attempt`, so every activity, deferred
   and clock name is unique per execution: `round/${n}`, `tool/${n}/${callId}`, `ask_help/${step}`,
   `poll/${op}/${i}`. Workflow bodies branch only on the payload and activity results. A test helper
   fails on duplicate names and replays from the top after every activity.
3. **Failures.** Completed failures are journaled forever, and the engine never retries them.
   - Transient errors are retried inside `execute` (`Schedule.exponential` + jitter, honouring
     `Retry-After`). An activity fails only for terminal errors.
   - Never `orDie` inside an activity, and never use `Activity.retry` with a long backoff, because
     it sleeps again on every replay.
   - Turn workflows use `SuspendOnFailure`, and the web app offers resume/abandon.
4. **Bounded run segments.** The limit applies to a segment, from one wake to the next durable
   suspension, not to an activity.
   - Keep each segment under ~10 min of wall time and within `limits.cpu_ms: 300000`.
   - Make polls durable with `inMemoryThreshold: 0`; sleeps of 60 s or less don't suspend
     otherwise.
   - Split long work into child workflows (one Attempt per retry, or one per N steps).
   - After 8 cut-offs the engine parks a run and retries it only hourly, so HomeDO keeps a
     run-health table with alerts and a "kick/interrupt" action.
   - Structural changes ship as new names (`TurnV2`). Finished journals are purged after N days.
5. **Journals hold keys, not bytes.** Rows max out at 2 MB, so screenshots and large output go to
   R2 or ChatDO. Secrets never enter a journal, and a redaction layer strips provider errors of
   headers, URLs and bodies before an activity fails.
6. **One actor per entity.** No global locks. Capacity leases are keyed by
   (kittyId, generation, remoteId) and reconciled against the Boat inventory; the provider count
   wins when they disagree.
7. **Typed errors** (`Schema.TaggedError`) carry a stable `code` + params + HTTP status. The client
   renders es/pt text and the friendly-vs-technical detail; this replaces `codeFor` and
   `gatewayText.ts` string matching.
8. **Every wait is durable**: `DurableDeferred` for humans, `DurableClock` for time.
9. **Secrets.** The KEK is a Worker secret with an escrow copy off Cloudflare. Envelopes are
   `{kid, iv, ct}` with AAD `table:row:purpose`, and rotation re-wraps online. `type_secret` text
   travels only over stdin/XTEST, never argv, logs or traces.
10. **Counters are idempotent.** Budget charges are keyed by the activity idempotency key, and
    trust stats by approvalId (`INSERT OR IGNORE`).

## Repo layout & toolchain

A pnpm workspace on `vite-plus` 1.4.x (`vp`: Vite 8, Rolldown, Vitest 5, Oxlint, Oxfmt, tsgo,
Vite Task caching). Pins:
- **Exact:** `effect@4.1.1` with a pnpm override, so the workspace has one Effect instance;
  `alchemy` and `@alchemy.run/cloudflare` `2.0.0-beta.84`; matching `@effect/ai-openai`,
  `-anthropic`, `-openrouter`, `-openai-compat`, `@effect/sql-sqlite-do`, `@effect/platform-bun`,
  `@effect/vitest`.
- **Bump policy:** a pin changes only through a PR that re-runs the Phase 3 spike-1 suite.
- The legacy `deploy/cloudflare` stack was kept outside the workspace until cutover, then removed.

```
apps/web/              web app (copied in Phase 3 from desktop/frontend incl. e2e; desktop/ untouched until cutover)
apps/gateway/          Worker + DOs + workflows; alchemy.run.ts (stack "KittiesNext", stages dev/e2e/next)
apps/kittyd/           guest daemon
packages/domain/       Schemas: kitty, chat, turn, step, goal, approval, events, error codes
packages/api/          HttpApi → gateway implementation + derived client
packages/protocol/     kittyd ⇄ KittyDO messages (hello{protocolVersion, buildId}, actions, acks, reconcile, frames, clipboard, quiesce)
packages/agent/        turn loop, tools, souls/prompts, image policy, budgets
packages/integrations/ providers, ChatGPT sign-in, MCP bridge, OAuth, native tools
packages/testing/      ScriptedLanguageModel, fake kittyd (drawn desktop), replay-every-step helper
guest/                 provisioning moved from internal/guest (setup.sh, kitty-* helpers, Lumen, kittyd unit)
```

Testing has no coverage thresholds:
- Unit tests use `@effect/vitest` with `WorkflowEngine.layerMemory` and the replay helper.
  layerMemory alone does not reproduce DO-engine semantics.
- Integration tests run over HTTP against `alchemy dev` (workerd).
- `@cloudflare/vitest-plugin` is used only if spike 1 shows it can host Alchemy-built DOs.
- Playwright e2e runs against the `e2e` stage, with the scripted model and fake kittyd.
- CI runs `vp check` → `vp test` → `vp build` → `alchemy deploy --stage next`. Go CI is
  path-filtered until deletion.

Guest helpers that stay non-Effect, because they are small, proven and local to the guest:
- `kitty-grab` (C);
- `kitty-ocr`, `kitty-quiesce`, `setup.sh` and the other shell helpers;
- `kitty-open.py`, `kitty_browser.py`, `desktop-defaults.py`, `build-theme.py`.

`kitty-page.py` is replaced by agent-browser.

## Phases

Each phase is a `gh stack` of small draft PRs on top of `codex/durable-state-recovery` (#13). Exit
criteria are measured on `next`. `next` is **non-production until Phase 10**, and Go stays live
and frozen (fixes only) until then.

### Phase 1: Commit the backing documentation and the plan (docs only, ≈1 day)
Branch `effect/plan` on #13, with one draft PR and no code. New `docs/effect/`:
- `README.md`: index, reading order, phase status table.
- `PLAN.md`: this plan.
- `DECISIONS.md`: what the owner decided, plus the drops they signed off: subscription logins
  except ChatGPT/Codex; the long-tail connectors and email; demo mode; self-update/Updates;
  adoption of the old Boat checkpoints; restic. Also the change in backup semantics and why the
  guest helpers stay non-Effect.
- `PARITY.md`: one row per screen, endpoint and README/AUTONOMY feature, with keep / change /
  drop, phase and an "owner confirmed" column. It is seeded from the table below.
- `CURRENT-SYSTEM.md`: per area (HTTP/auth, state/backups, agent loop/autonomy,
  providers/connectors/OAuth, Boat lifecycle/desktop body), the **behaviour contracts to carry
  over** and the **known defects**. Cite code as commit-SHA permalinks (`7f408a1`) so the
  references survive Go's deletion. Contracts include:
  - the restart and never-replay rule;
  - the risk table and trust thresholds 2/4/6/12/never;
  - cron grammar and aliases;
  - control receipts (epoch, revoke on error, drain);
  - webhook checks;
  - OpenAI parameter rules;
  - the host allow-list;
  - Boat quirks: labels dropped on restore, the 24 h idempotency window, blocked deletes,
    checkpoint-before-delete.
- `RESEARCH.md`: dated, sourced facts on:
  - DurableObjectEngine internals: journal tables, `name/attempt` keys, at-least-once callbacks
    retrying from 5 s and parking after 8 attempts, 60 s in-memory sleep threshold, no journal
    purge, alchemy RpcWebSocket constraints;
  - the Effect 4 module map and versions; McpClient limits (protocols 2025-11-25/2026-07-28,
    static headers, no OAuth); no Effect-4 Gemini package;
  - Vite+ and the Vitest 5 / Cloudflare test status;
  - agent-desktop and agent-browser;
  - the Boat public API (commands, host, file write, webhooks, pricing, EU only, new IP on
    every resume);
  - Cloudflare limits: DO SQLite 10 GB, 2 MB rows, 15-min alarms, `cpu_ms` up to 5 min, 32,768
    hibernatable sockets, PITR, R2 locks, 64 MiB Workers;
  - CUA-RESEARCH takeaways.
- `RISKS.md`: alchemy beta churn, Effect minors, Boat API changes and EU latency, Access sessions on
  iOS, ChatGPT sign-in ToS, DO streaming cost, MCP protocol mismatch, agent-desktop on Openbox.
  Each has a mitigation and a trigger.
- `LATENCY-BASELINE.md`: today's numbers, labelled as an *interrupted* baseline (6.3–8.7 s,
  median 6.8 s; backup 2m15s; recovery 2m8s; template 2m14s; clones 17–27 s), plus the inferred
  per-hop budget. A clean re-measurement is spike 3.
- Point `docs/CLOUD-PLAN.md` and `docs/README.md` at `docs/effect/`, and mark the Go stack as frozen.

Exit: the draft PR is open in the stack and reviewed. It merges when the stack does.

### Phase 2: Toolchain groundwork (≈1–2 days)
- Remove the coverage rules:
  - `Makefile`: `COVER_MIN` (18-19), the `cover` target (63-70), `.PHONY` `cover`,
    `coverage.out`, `-cover` in `desktop-check`.
  - `.github/workflows/ci.yml`: the "coverage gate" step (41-42), the job name
    "fmt · vet · test · coverage", `-cover` (84).
  - `docs/DEVELOPMENT.md:5` and `docs/DEPLOY.md:137` (the required-check list).
  - Update branch protection if it names the old check.
- Add the pnpm + `vite-plus` workspace with the pins, `run.tasks`, a CI job and Go path filters.
- Exit:
  - No enforcement remains in Makefile or CI; development/deployment docs list the new check.
    Historical decisions and this plan retain the rationale.
  - `vp check && vp test` is green.
  - `alchemy deploy --stage dev` of a hello Worker + static assets works inside the vp workspace
    without peer errors (alchemy declares a peer on `vite`).

### Phase 3: Walking skeleton, web shell and go/no-go spikes (≈1–1.5 weeks)
- Stack `KittiesNext` (stages dev/e2e/next):
  - Worker with an Effect init and `limits.cpu_ms`.
  - Access app plus an in-Worker identity check.
  - Allow-list router and separate bypass routers; workersDev and previews off.
  - Static Assets.
  - `packages/api` with `/v1/health` + `/v1/session`.
  - HomeDO/KittyDO/ChatDO on `@effect/sql-sqlite-do` + `Migrator`.
  - Effect logs and traces.
- `apps/web` copied from `desktop/frontend` (with e2e). The web client must work in desktop
  and mobile browsers, including Android Chrome and iOS Safari.
- `packages/testing`: ScriptedLanguageModel and a fake kittyd for the dev/e2e stages.
- **Spikes.** Each gets thresholds written before it runs, and results go into `RESEARCH.md`:
  1. **Engine semantics.** Prove these behave as documented:
     - segment cut-off at 15 min and parking after 8;
     - `inMemoryThreshold: 0` polls;
     - a failed activity is journaled;
     - SuspendOnFailure + resume;
     - child workflows and deterministic parallel fan-out (each child started in a named step,
       joined in a fixed order);
     - redeploy mid-run;
     - killing workerd under `alchemy dev` mid-run;
     - replay CPU at 50/200/500 journal entries;
     - whether vitest-plugin can host Alchemy DOs.
  2. **EffectLedger + reconcile.** Kill KittyDO between send and ack, and separately restart kittyd
     in the same window. Pass if the turn resumes with no double action and no owner prompt.
  3. **Boat channel and latency gate.**
     - A kittyd prototype on a real Boat VM: outbound WSS that reconnects across stop/resume (new
       IP), token delivered by file write.
     - `POST /commands` p95.
     - Boat webhook event types.
     - A clean re-measurement of today's Go warm input (N ≥ 50, stream connected).
     - **Gate:** prototype browser→KittyDO→guest warm ack p95 < 250 ms.
  4. **Messaging and frames.** alchemy RpcWebSocket for client→DO calls; a tagged-union protocol
     for DO→kittyd dispatch; frames on a separate binary channel. Relay 15 fps to 2 viewers, one
     throttled to 3G, and record input-ack p95 and DO memory. Decide whether frames move to
     KittyStreamDO. Plan B: Cloudflare Realtime (WebRTC).
  5. Worker startup CPU and bundle size with the Effect AI packages; check that Effect spans show
     up in Workers Observability.
  6. **Boat image probe**: glibc, AVX2, at-spi2-core, Chrome a11y, agent-browser `connect 19222`,
     agent-desktop `status`.
  7. **MCP probe**: McpClient initialize + listTools from a deployed Worker against GitHub,
     Stripe, Notion, Linear, Atlassian, Slack and Home Assistant. Record the negotiated versions.
     Plan B: a thin Streamable-HTTP client on `effect/http`.
- Exit: deployed and Access-protected; web client usable in desktop and mobile browsers; every
  spike passes its threshold or has a written decision. If spike 1 fails, the fallback is
  `NativeEngine`. Its cost is a 5 s poll step
  per child-wait check (~1,440 steps for a 1-h delegation), and step budgets for Delegation and
  GoalSlot get re-checked.

### Phase 4: Live desktop, i.e. kittyd and fast input (≈2 weeks)
- **Boat namespace isolation from Go:**
  - A random deployment id for `next`.
  - Its own prefixes: `kn-<kittyId>-g<gen>` for VMs, `kn-…` for checkpoints.
  - Every reconcile filters on the deployment label, or on the exact receipt for restores.
  - Names outside the prefix are ignored.
- Minimal `ComputerOpWorkflow`: create from a clean template, resume, kittyd install/upgrade and
  token rotation via `POST /commands` + file write, all with deterministic names.
- **kittyd:**
  - Install: its own system user and a systemd unit. `kitty-desktop.sh` writes
    DISPLAY/D-Bus/AT-SPI addresses to a file that kittyd reads. The binary is downloaded from a
    presigned R2 URL and checksum-verified, and the build target is baseline.
  - Protocol: `hello{protocolVersion, buildId}`, with N-1 supported.
  - Safety: the intent log, per-action acks, epochs and deadlines from rule 1.
  - Frames: XShm diff in the guest via kitty-grab, a latest-frame queue, and streaming only while
    viewers are connected.
- **kittyd token:**
  - KittyDO stores only a hash bound to (kittyId, remoteId, generation, tokenVersion).
  - Every older version is invalidated when a resume or restore *starts*.
  - The token is delivered only to the exact remoteId, never in a command line.
  - The guest principal is low-privilege: it can't release control, complete approvals or read
    secrets, and it is rate- and size-limited.
  - Plan B (`/host`) requires mutual auth.
- **Control receipts** live in KittyDO SQLite as {kittyId, generation, remoteId, guestConnEpoch,
  nonce, lastInputAt}.
  - Any epoch bump revokes them: reconnect, restart, sleep or restore.
  - Any input error revokes.
  - Release drains in-flight work and rejects queued input.
  - Agent dispatch returns Held during a grant, and a grant waits for an in-flight agent action.
  - A hold-expiry alarm fires.
  - After a reconnect the client drops unacked input.
  - Port `internal/orchestrator/control_receipt_test.go`.
- Web live view: a control WS plus a frame channel; DesktopCare status/restart.
- Latency fixture: a guest square changes on click, with per-hop timestamps.
- Exit:
  - Warm ack p95 < 250 ms and click-to-visible p95 < 500 ms over at least 200 inputs.
  - A 30-min stream soak with no fallback.
  - A deploy during input causes no double execution and no owner prompt.
  - A checkpoint built with an older kittyd upgrades and connects.

### Phase 5: Brains, i.e. chat and first tools (≈2–2.5 weeks)
- **Providers** in HomeDO, with keys in AES-GCM envelopes:
  - `@effect/ai-openai` Responses: `strictJsonSchema: false` or strict-safe schemas; temperature
    only when the owner set one; reasoning carried across rounds.
  - `@effect/ai-anthropic`: cache_control and thinking.
  - `@effect/ai-openrouter`.
  - `@effect/ai-openai-compat` for groq, deepseek, mistral, DashScope, ollama-cloud and custom.
  - Gemini via its OpenAI-compatible endpoint.
  - The models list doubles as the key check, and the base-URL guard stays.
  - **ChatGPT/Codex sign-in behind a flag**: PKCE with a paste-back URL, streaming Responses with
    `store: false`, encrypted tokens, single-flight refresh.
- **ChatDO**:
  - Turns and steps as rows.
  - Event ids with `Last-Event-ID` replay and a 20 s heartbeat.
  - An inbox queue instead of `ErrBusy`.
  - POST requires a client `messageId`, inserted with `INSERT OR IGNORE`; the run id is derived
    from (chatId, messageId).
- **`TurnWorkflow`**:
  - Rounds run as activities with `disableToolCallResolution`.
  - Deltas are batched (≥100 ms) and tagged with (round, attempt), with `round_reset`.
  - Budgets use idempotent counters; Retries=0 is allowed.
  - Compaction happens after the turn.
  - Cancel works through the workflow interrupt, with a defined end state, and drains the inbox.
- Product features:
  - kitty CRUD with soul and PixelCat avatars; group chats with `@name` routing;
  - feedback thumbs, demand level, memory and distill (port `internal/memory`);
  - the Library (skills propose/accept, artifacts in R2); Welcome;
  - es/pt i18n via error codes;
  - souls from `souls/*.yaml`.
- **First tools ("MCP first")**:
  - A static-token MCP bridge (e.g. a GitHub PAT) through `McpClient.toolkit` with per-connection
    prefixes and untrusted-output marking. Annotations may only *raise* risk; unannotated tools
    default to "ask".
  - Native `http` (host allow-list, risk by method), `ntfy` and webhook presets.
  - A basic `ApprovalWorkflow`: hold with an args digest → decision → run once → resume.
- Web app: chat and settings on the derived client, with the Wails/Android branches removed in
  `apps/web/src/api.ts`.
- Run-health table and Health page.
- Exit:
  - First-token p95 < 2 s over 50 turns.
  - A redeploy mid-turn resumes with no duplicate steps.
  - A retried POST produces one turn.
  - Cancel mid-turn is tested.
  - The ported `internal/chat` contract specs and the e2e tests pass on the `e2e` stage.

### Phase 6: Lifecycle, i.e. sleep, restore, capacity (≈1.5–2 weeks)
- **`SleepWorkflow`**:
  - KittyDO enters Draining and refuses new leases, then quiesces via kittyd, falling back to
    `/commands`.
  - If quiesce fails during an idle sleep: don't stop, keep renewing the TTL, retry, and alert
    after N failures. If it fails during an owner stop: ask the owner.
  - Then: stop → archived → save checkpoint → verify → record.
  - Compensation is "wait for archived, then resume", and it keeps the lease.
  - Unquiesced or TTL-forced checkpoints are marked as such and never replace the last verified
    quiesced checkpoint without confirmation.
- **Restore into a new VM** (generation++): replay the byte-identical body with the same key
  within 24 h, and use per-generation names as a conflict check. Beyond 24 h, fail closed.
  Afterwards: rotate the token, upgrade kittyd, and inject a "desktop changed (gen N→M)"
  observation.
- **Delete** = checkpoint → verify the saved id/source → delete → poll `blocked`. The previous
  verified checkpoint stays authoritative.
- **Leases**: held only by in-flight activities, live grants and visible viewers; parked workflows
  release theirs.
  - Capacity leases are reconciled against the provider.
  - Alarm handlers never throw and always reschedule.
  - A cron watchdog checks lastRenewAt and the slots.
  - The account-wide generation scan gates lifecycle mutations only.
- Exit:
  - Restore into a new VM keeps a marker file, a cookie and an installed package.
  - Five desktops run concurrently; a sixth is refused.
  - TTL-lapse and quiesce-failure chaos tests pass.
  - The Go/next same-name isolation test passes.

### Phase 7: Durable desktop tasks and perception (≈2 weeks)
- Desktop tools in `TurnWorkflow`:
  - One child `AttemptWorkflow` per retry, which bounds segments and replay.
  - Ledger + reconcile; a screenshot only after visual batches; stuck detection.
  - `ask_help` = a deferred raced with a 15-min clock; takeover waits on a "desktop-returned"
    deferred.
  - Cancel mid-batch releases leases and stops captures.
- Vault API/UI and `type_secret` by vault reference (stdin only); Help modal.
- Image policy: the last 1–2 downscaled shots, plus prompt caching.
- **Perception**:
  - agent-browser `connect 19222` (snapshot, refs, `--if-changed`) replaces `kitty-page.py`.
  - agent-desktop for native apps: at-spi2-core + atk-bridge, `at-spi-bus-launcher` in
    `kitty-desktop.sh`, `toolkit-accessibility`, `--force-renderer-accessibility` in
    `kitty-open.py`. Update `kitty-quiesce` if the document-portal path moves.
  - New tools `ui_read` / `ui_click` / `ui_type` by ref, with `STALE_REF` handling.
- A client-side replay slideshow replaces `internal/replay`.
- Exit:
  - Non-model overhead p95 < 1 s.
  - Kill-after-click and redeploy-mid-task both resume without duplicates.
  - A/B on a fixed suite of 20 tasks: refs become the default if success is at least the baseline
    and image tokens drop by at least 30%.

### Phase 8: Autonomy (≈2 weeks)
- **Goals**: `GoalSlotWorkflow` per (goal, slotTime) keeps the `internal/agenda/cron.go`
  semantics and adds a per-goal timezone, and chains the next slot. A cron reconciler guarantees
  exactly one scheduled slot per enabled goal. Add run-now and per-goal threads.
- **Webhooks** on `/hooks/*`:
  - A 1 MB cap before verification, plus WAF rate limits.
  - GitHub HMAC, Stripe-Signature (5 min), or a generic HMAC over `timestamp.body`. `?secret=` is
    dropped.
  - Runs are keyed by `X-GitHub-Delivery` / Stripe `event.id`, with dedupe kept ≥30 days.
  - Boat webhooks are hints, and are re-read via the API before acting.
- **Approvals, full**:
  - Trust streaks (idempotent), a rules UI, reminders and expiry.
  - A decision that loses the race against expiry returns 409.
  - Open pending approvals in the web app behind Access; reauthenticate before deciding.
- Delegation as child workflows, using the deterministic fan-out pattern from spike 1, depth ≤ 2.
  The backup-kitty handoff stays.
- **Notifications (historical backend contracts)**:
  - The existing delivery workflow and stored subscriptions remain backend compatibility
    contracts. The current web client exposes pending work through its approval and help views.
  - Real 10-min folding; notify test and event selection.
  - An at-most-once digest, also on demand.
- Kitty journal, limits form with `day_actions`, and the `limit` tool.
- Exit:
  - A 100-delivery burst with duplicates produces exactly one run per delivery.
  - Reauthenticating from a mobile browser and approving resumes the turn.
  - The goal-chain reconciler test passes.

### Phase 9: Integrations (≈1.5 weeks)
- OAuth generalised from `internal/oauth`: PKCE, flows stored in HomeDO, single-flight refresh,
  Finish hooks. MCP authorization adds RFC 9728/8414 discovery and DCR or CIMD on the bypass
  path. The MCP client is rebuilt per activity with a fresh token.
- Remote MCP servers: GitHub, Stripe, Notion, Linear, Atlassian, Slack, Home Assistant.
- Native minimal Google Workspace and Microsoft 365. CalDAV/CardDAV only if PROPFIND works from
  Workers.
- Exit: each server passes or has a documented disposition in `PARITY.md`; OAuth refresh-race
  tests pass.

### Phase 10: Hardening, backups, cutover (≈1.5 weeks)

Owner update (2026-11-01): deploy with the measured non-model latency limitation documented.
The original p95 < 1 s performance target remains an optimization target, but is waived as a
cutover gate. The completed run at this decision measured p50 557 ms, p95 1,596 ms over 50 real
actions. See [decision evidence](evidence/latency-cutover-decision.json).
- **Restore semantics:**
  - A `restoredEpoch` in HomeDO interrupts pre-epoch runs for owner review instead of replaying
    them.
  - A DO registry drives exports and per-object PITR through an admin RPC.
  - After a restore, rotate kittyd tokens and re-validate OAuth.
  - The KEK escrow is part of the drill.
- **Exports:** the `ExportWorkflow` writes encrypted JSONL to a retained bucket with a lock rule.
  Lifecycle expiry is longer than the lock, and the CI token has no bucket-config permissions. Run
  the journal purge job.
- **Chaos suite:** DO eviction, kittyd disconnect, Boat 5xx / lost create / TTL expiry, R2
  errors, and parked runs. Plus a cost and latency report for 1 and 5 desktops.
- **UI:** Backups/Recoveries changed to PITR and export status; Updates replaced by a version line
  on Health.
- **Cutover:**
  - Run the checklist: re-enter providers and secrets, connect MCP, seed souls and goals.
  - Point `kitties.rccpr.tech` at `KittiesNext`, with a tested DNS rollback to Go in under 10 min.
  - Run the production smoke/recovery checks after the hard cutover (D16).
  - Then delete `cmd/`, `internal/`, `go.mod`, `desktop/`, `android/`, the old `deploy/cloudflare`,
    and the Go CI/release workflows (`tag.yml`, cross-compile, self-update, android).
  - Rewrite the docs.
  - Keep the old R2 buckets and Boat checkpoints until the owner confirms.

## Parity seed (expanded in `docs/effect/PARITY.md`)
| Feature | Disposition | Phase |
|---|---|---|
| Live view + take control, clipboard, DesktopCare | changed (WS, receipts) | 4 |
| Chats, group `@name`, cancel, feedback/demand/memory/distill, Library, kitty CRUD + soul + avatars, Welcome, es/pt | kept | 5 |
| Providers (OpenAI, Anthropic, OpenRouter, compat kinds, Gemini via compat), ChatGPT sign-in (flag) | changed | 5 |
| Copilot / Claude Code / gcloud Gemini / Qwen / local Ollama logins | dropped | — |
| Sleep/restore/recoveries, capacity | changed | 6 |
| Desktop tasks, ask_help, vault + type_secret, Help, replay (slideshow) | changed | 7 |
| Goals, run-now, webhooks, approvals + rules, delegation, backup kitty, notifications, digest, journal, limits | changed | 8 |
| GitHub/Stripe/Notion/Linear/Atlassian/Slack/HA via MCP; Google/M365 native; http/ntfy/webhook presets | changed | 5/9 |
| Long-tail connectors (incl. email/SMTP), shell, Apple/Things/OmniFocus, motita | dropped | — |
| Backups/Recoveries UI, Updates/self-update, demo mode, CLI, Wails, Android, Lima/Docker | changed / dropped | 10 / — |

## agent-desktop verdict
It helps, but as **guest-side perception**, not as infrastructure: it doesn't provide VMs,
streaming or remote control.
- **Strengths:** Apache-2.0 Rust CLI (v1.0.2, linux-x64 release); AT-SPI refs with `STALE_REF`;
  XTEST in-process; JSON envelopes; `batch`.
- **Gaps on our guest:** no at-spi2-core/atk-bridge; the session bus lives only inside
  `dbus-run-session`; Chrome runs without a11y. The tool targets GNOME 46 (Openbox/Xvfb is
  unverified), and the CLI spawns per call; a native FFI library is also available.
- **The bigger early win is agent-browser** for web tasks (CDP refs, occlusion checks,
  `--if-changed` screenshots).
- **Plan:** probe both in spike 6, ship both behind kittyd in Phase 7, and keep pixel tools as the
  fallback. The 20-task A/B decides the default.

## Verification
Every phase ends with its exit criteria measured on `next` (or `e2e` for scripted tests), and the
results are recorded in `docs/effect/README.md`:
- Phase 1–2: review, plus the grep/CI checks.
- Phase 3: spike PRs with commands, outputs and pass/fail against pre-written thresholds.
- Phase 4: latency fixture p50/p95, stream soak, deploy-during-input test.
- Phase 5: e2e (scripted model), redeploy mid-turn, messageId retry, cancel.
- Phase 6: restore drill, capacity, chaos.
- Phase 7: kill-after-click, the A/B suite.
- Phase 8: burst and phone-approval tests.
- Phase 9: per-server MCP results.
- Phase 10: chaos suite, PITR/export drill, rollback drill, production smoke, cutover checklist.
