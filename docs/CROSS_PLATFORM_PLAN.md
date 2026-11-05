# Cross-platform Kitties implementation plan

Status: implementation plan; the application described below is not yet delivered.
Baseline: `a6e1625` on `main`, inspected on 2026-11-04.

## Outcome and first product slice

Build the existing skill library as one complete Foldkit screen that also runs
inside Tauri 2. A person proposes instructions, reviews them, accepts them for
their puppies, and can remove them. Only accepted instructions can enter a new
conversation turn. The cloud remains authoritative; local pending indicators
never mean that a skill was accepted.

This is the first cross-platform slice, not a rewrite of chat, remote desktops,
approvals, connections, recovery, or every Preact screen. Preserve those routes
and their behavior while establishing an idiomatic replacement path. Modernize
the library's layout and interaction states with accessible Foldkit UI controls;
retain the existing English, Spanish, and Portuguese language support.

The skill library is an existing product feature in
`apps/web/src/WorkspacePanel.tsx`. Its server writes are currently in
`apps/gateway/src/workspace-data.ts`, and `HomeDO` snapshots accepted skills into
turn configuration in `apps/gateway/src/actors.ts`. All three seams must move
together. A new screen backed by unrelated example data would not complete this
slice.

## Verified baseline and compatibility decisions

| Concern | Current pin | Decision |
| --- | --- | --- |
| Workspace | pnpm 12.16.1, Node 26, Vite+ 1.4.0 | Preserve the workspace and root tooling configuration. |
| Effect and platform packages | 4.1.1 | Preserve these pins and the single Effect override. |
| Foldkit and UI | 0.170.0 | Preserve published packages and release-matched guidance. |
| Foldkit Vite plugin | 0.29.0 | Preserve. |
| Alchemy and Cloudflare | 2.0.0-beta.84, with pnpm patches | Upgrade together to beta.85 only with the patch audit below. |
| Alchemy Domain | Not installed | Add 2.0.0-beta.85; its exact Alchemy peer is beta.85. Its Effect and Foldkit peers accept our pins. |
| Desktop | No application host | Use Tauri JS API/CLI 2.12.4, Rust core 2.12.5, tauri-build 2.7.4, Store 2.5.0, HTTP 2.8.3 and Opener 2.7.2; verify them together and commit Cargo.lock. |

The first-party Domain skill is bundled at
`@alchemy.run/domain/skills/alchemy-domain/SKILL.md`. Read that installed skill
and its modeling, testing, hosting and frontend references. No skill installer
or Effect setup is needed. Reference downloads are kept in gitignored
`.context/`; no upstream framework source or examples become workspace packages.

Baseline validation on Node 26.13.0: frozen install, `pnpm check`,
`pnpm test:coverage`, `pnpm build`, and the guest type check pass. The suite has
23 tests plus 200 generated property cases, and its coverage floors pass. Check
reports zero errors and 278 existing advisory Effect API stability warnings.

A scratch compatibility probe against the published beta.85 Domain package,
Effect 4.1.1 and Foldkit 0.170.0 compiled and exercised Story transitions,
receipt deduplication, middleware denial, ownership and an `atLeast` snapshot.
An incorrect acceptance projection was detected by the Story. This is evidence
for the APIs and pins, not an application implementation or Cloudflare proof.

### Alchemy upgrade gate

Compare the beta.85 package source and emitted output with both current patches.
Retain every still-needed workflow guarantee: callback retry accounting,
activity failure journaling, explicit placement, durable timestamps, protected
administration, bounded export, and purge tombstones. Remove a patch only when
the matching upstream behavior is demonstrated. Add focused regression coverage
for behavior touched by the upgrade, distinguishing in-memory checks from real
Durable Object execution.

Inspect the beta.85 state-store migration code and document the upgrade and
rollback constraints before invoking any CLI operation that could modify remote
state. Do not use an older Alchemy binary after upgrading a remote state store.
Keep existing stack, stage, Worker, bucket and Durable Object names. No production
deployment, remote state migration, or destructive replacement is part of this
implementation authorization.

## Ownership and package boundaries

| Location | Responsibility |
| --- | --- |
| `packages/domain/src/Library/` | Branded identities, library aggregate, skill lifecycle, commands, events, rejections and detail view. |
| `packages/domain/src/Library.model.ts` and `LibraryApi.api.ts` | Model and the explicit public API. Existing shared contracts remain available. |
| `apps/gateway/src/` | Domain hosting, verified actor middleware, legacy cutover, compatibility routes and recovery integration. |
| `apps/web/src/foldkit/library/` | Schema Models, Messages, pure update/view, official adapter Commands and Subscriptions, Story/Scene tests. |
| `packages/device/src/` | Small platform service contracts, browser/Tauri implementations, deterministic test Layers. |
| `apps/desktop/src-tauri/` | Minimal Rust host, native permissions, configuration and packaging. |
| Root `vite.config.ts` | Shared formatting, lint, types, tests, coverage and tasks. |

The domain imports Effect and Alchemy Domain, never Foldkit, Tauri, browser APIs
or a Cloudflare implementation. The gateway hosts the model using
`@alchemy.run/cloudflare/Domain`. Both frontend hosts consume
`@alchemy.run/domain/Foldkit`; do not wrap its commands or watches in a second
HTTP/subscription framework. Device implementations are selected at the runtime
composition boundary. Rust contains no library business decisions or second
backend.

## Domain behavior

Use one owner-keyed `Library` aggregate with a branded `LibraryId`. It stores
only active catalogue metadata and a monotonically increasing ID counter; full
instruction bodies are recorded in individual proposal/import events and folded
into one `SkillDetail` view type, keyed by owner and branded `SkillId`. Expose the
catalogue through the aggregate's documented read/watch contract. This gives
the library one authoritative ordering without putting every body into one
Durable Object value or an unbounded owner projection.

New proposals receive server-allocated IDs from the aggregate's counter. A
retried command returns the original allocated ID through its durable receipt.
Removal frees catalogue capacity; IDs are never reused. Keep the removal fact
in the detail view/event history and retain old receipts, rather than accumulate
every removed identity in hot aggregate state. Import preserves legacy IDs and
advances the allocator past any matching reserved IDs before enabling writes.
Recovery must preserve the high-water mark and fence pre-restore operations.
Validate canonical ordinal encoding and fail explicitly at numeric exhaustion;
never round or wrap an ID. Import finalization and the high-water result become
durable before public proposals are accepted.

Enforce conservative encoded-byte limits before committing: at most 512 KiB
for aggregate metadata and 512 KiB for each event/detail payload, with room for
host metadata beneath the platform's 2 MB SQLite-backed key/value/row limit.
Reject over-capacity proposals explicitly; acceptance/removal remain available.
Keep the current character bounds as well and test multibyte strings. If an
existing inventory exceeds these bounds, stop import and report it; never
truncate or discard accepted instructions. This bounds records and hot state,
not total event history, which still needs the recovery/retention policy.

The two core commands are `ProposeSkill` and `AcceptSkill`. Include `RemoveSkill`
in the same slice to retain the existing removal action. Their events are facts
(`SkillProposed`, `SkillAccepted`, `SkillRemoved`), with validated data and
typed replies and rejections. A server-only legacy import operation is not
exposed by the public API.

Rules to establish before wiring the UI:

- Validate the current name/body bounds at the server boundary and reject empty
  or whitespace-only names. The UI gives feedback using those shared schemas.
- Derive ownership from the verified actor. Middleware checks command targets
  and read keys before receipt lookup, since a duplicate receipt bypasses
  `decide`. Keep aggregate decisions and read validation as additional checks.
- Proposal never implies acceptance. A command cannot supply an accepted status.
  Existing accepted records are handled only by the trusted migration path.
- Acceptance requires an existing proposal owned by the caller. Fresh redundant
  acceptance/removal commands have explicit lifecycle rejections; repeating the
  original command ID returns its receipt without another event.
- Removal makes the skill unavailable to future turns. Already captured turn
  configurations retain their historical instructions, as they do today.
- Preserve domain rejections, authorization denials and unknown transport
  outcomes as distinct cases. Do not manufacture success after a timeout.

The versioned `SkillDetail` view contains one confirmed instruction body and its
lifecycle. The catalogue records each skill's relevant source-event version.
Wait for that version when reading its detail; a receipt for another skill is
not a consistency barrier for this key. Bodies are immutable for an identity;
replacing instructions means a fresh proposal, not editing accepted content.
Keep ID ordering, the existing eight-skill turn limit and 12,000-character
per-skill prompt limit explicit in domain-owned selection helpers. Use
`Domain.verify` and Domain Story tests before adding the server or UI.

## Server integration and existing data

Host the model in the current gateway with the documented Durable Object Layer.
That adapter creates separate aggregate/view objects; it cannot be placed inside
the existing HomeDO through a supported configuration option. Do not invent a
custom persistence platform to evade the cutover and recovery work.
Expose a narrow Domain API under a dedicated path. Commands and reads use its
middleware and actor context; retain the gateway's existing owner and recovery
checks. A locally configured owner identity is allowed only in the existing
local stage.

Legacy `/v1/skills` reads must delegate to the same authority once cut over.
The old arbitrary-ID/status-bearing PUT is intentionally retired: return an
explicit migration error pointing to the new Domain API. Do not preserve an
accepted-body overwrite path or silently treat a retry as a fresh proposal.
Retire the remaining old skill mutations with the same explicit response once
the new screen replaces their callers; remove their client declarations in that
PR. Existing files/artifact routes remain available. This deliberately narrows
the legacy API; it is not a promise of full old-client write compatibility.

Define the server's turn-capture ordering independently of the frontend. Read
the authoritative catalogue for a new turn, select its accepted entries, and
read every detail at least through its recorded event version. Verify the
detail revision/lifecycle still matches that catalogue; on mismatch, retry the
whole capture within a bounded policy, or fail explicitly. Re-read/check the
catalogue before committing a coherent result. A completed mutation preceding
capture must be reflected; overlapping mutations must have a documented
linearization point. Never silently omit a lagging selected skill.

Enter HomeDO's transaction only to persist the first coherent `turn-config`,
rechecking whether another initializer already saved it. Reuse that saved
snapshot on all retries and rounds. Prove delayed delivery, accept/remove from
another tab before a new turn, concurrent capture and removal, and a consistency
timeout. Frontend-only receipts cannot protect scheduled or other server callers.

Cutover is an engineering gate, not an automatic data reset:

1. Inventory legacy skill rows and validate them. Preserve IDs, acceptance and
   timestamps; report invalid records without silently dropping them.
2. Fence legacy skill writes while taking the import snapshot. Record migration
   progress durably and use deterministic import command IDs.
3. Resume safely after interruption. Import retries must not create duplicate
   facts, overwrite newer edits, or resurrect removed skills.
4. Verify the derived view against the import inventory, then switch reads and
   writes together. Do not run two independently writable libraries.
5. Cover export, restore, owner reset, purge, and recovery guards for the new
   authoritative stores before enabling a production cutover. Restore must not
   replay provider side effects or forget duplicate-command protection.
6. Document the rollback boundary. Restoring an old Worker that still writes
   legacy rows is not a safe rollback after new Domain writes.

The backend PR must prove the migration and recovery path against local durable
storage. If first-party APIs cannot safely cover a required recovery operation,
keep cutover disabled and record that gate as incomplete rather than substitute
an unreviewed storage implementation.

Recovery inventory includes directory/backfill objects, source history, receipts,
allocator state, view generations/checkpoints, pending deliveries and deletion
facts. A current business-state export is insufficient. Restoring HomeDO alone
must never revert the cutover marker or reimport old records over new Domain
writes. A supported, narrowly reviewed provider extension may be needed; that
would be its own PR and runtime proof, not hidden inside a feature adapter.

## Shared Foldkit screen

Provide a separately booted Foldkit library route during the Preact migration.
Use normal navigation from the existing shell; do not render Preact components
inside Foldkit or maintain two editable library implementations. Preserve access
to the existing file-library feature when replacing skill controls.

The same built assets and screen run in the browser and desktop. The native host
opens that entry; it does not need a parallel frontend build. Keep the runtime
entry separate from pure definitions and retain the full Foldkit lint preset.

The Model holds drafts, navigation, selection, pending commands, command IDs,
receipts and subscription state. Credentials stay outside Models, Messages,
DevTools history and logs. Use `@foldkit/ui` form controls and accessible status
and error messages. Verify narrow/mobile layouts, keyboard use, focus, long
instruction text, empty states and translations.

Derive commands using `DomainFoldkit.make(LibraryApi)` and allocate IDs with the
documented `CommandIds` helper from a session ID obtained at the effect boundary.
Keep an ID for the entire logical operation, including retries after an unknown
outcome. Capture receipts and use `atLeast` when a subsequent read must include
the write. Display pending and confirmed state distinctly.

Use the adapter's watch support with initial snapshots, cursors, teardown,
key changes, disconnect/reconnect and typed failure handling. Use the documented
HTTP transport for authenticated desktop streaming when browser WebSocket cookie
semantics do not apply. The published HTTP RPC protocol streams NDJSON; the
separate plain-HTTP adapter offers SSE. Do not describe them as interchangeable.

## Desktop security and capability boundary

Tauri development loads Vite; production loads local static assets. Validate an
explicit HTTPS API endpoint for packaged use. Never infer the backend from the
WebView's origin. A loopback development exception must be explicit and excluded
from release configuration.

Use `DevicePreferences` for the existing language/theme preferences, with browser,
Tauri Store and in-memory Layers.
This is the first native capability. Store must not contain authentication
tokens or an authoritative copy of the library. Use fixed-file native read/write
commands backed by official Store; its broad JS operations do not establish a
filename sandbox. Explicitly save before confirming persistence. Declare and
grant the custom commands through Tauri's application ACL too.

Use [Cloudflare Access Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
as the native authentication path to prove: discover the configured application,
register a public client if required, use authorization code with S256 PKCE and
state, open the system browser, and receive a single-use loopback callback.
Managed OAuth issues opaque user tokens; Access resolves them and forwards the
existing signed assertion to the gateway. Validate metadata/endpoints against
the configured HTTPS application and expected Access issuer. Require public
client support; never embed a client secret in a desktop application.

This Access feature is beta and is not yet verified or enabled for Kitties.
Prepare the exact staging configuration and test flow before requesting any
external configuration change. Do not add a bespoke authentication service or
Access bypass as an unreviewed fallback if the managed flow proves incompatible.
Keep credentials ephemeral behind a service for the initial release; sign in
again after restart. No long-lived token belongs in URLs, Store, logs or UI
history. Short-lived callback codes still require state validation, PKCE,
single-use handling, redacted logs and listener cleanup.

Provide the official Domain HTTP protocol through a native Effect `HttpClient`
boundary. Treat native authorization separately from the browser's CSRF policy:
a recognized Origin alone never authenticates a request. Preserve browser
same-origin enforcement, require the signed Access owner assertion, and test
expiry, cancellation, denied identity, redirect and endpoint substitution.
Carry verified expiry in server request context and bound stream lifetime to it,
including an idle stream. An authenticated upgrade must not authorize an
unlimited session. Refresh/re-authentication must actually restart the scoped
client/subscription; replacing a token does not restart a terminal watch.

Keep capabilities limited to the main local window and operations actually
used. Remote pages receive no native permissions. Restrict outbound origins,
opener URLs and content security policy. Validate IPC results at the TypeScript
boundary; use custom Rust commands only where official plugins are insufficient.
For HTTP plugin 2.8.3 explicitly disable its default cookie persistence and enable
redirect destination scope checking. Prefer refusing redirects for authenticated
API calls, so credentials cannot leave the configured application origin.

The inspected Amazon Linux VM has Rust 1.99.1 and GTK 3 but no WebKitGTK 4.1
development package in its enabled cached repositories. Use an Ubuntu/Debian
build environment with the documented Tauri dependencies for the first Linux
packaged proof, including Xvfb and the WebKit WebDriver where needed. Do not
substitute a different WebKit ABI to make this VM appear supported.

The native feasibility proof must establish a runnable packaged build.
Compile-only evidence and a browser using simulated Tauri globals do not count
as packaged verification.
Track Linux, macOS and Windows separately, and use CI for feasible build targets.

## Reliability scope

Start online-first. There is no queued offline editing requirement, so do not
add a synchronization engine, CRDTs, SQLite, a local backend, or a background
submit queue. A disconnected action stays visibly unconfirmed.

Uncertain outcomes still need safe recovery. Retain the original ID and payload
while retrying in a session. If restart recovery requires persisted operation
intents, add only a versioned, validated, user-scoped pending-intent record;
persist it before claiming durability, serialize submissions, and reconcile
with Domain receipts/views. Do not silently replay another user's intent.
Document whether restart recovery is implemented instead of implying it from
in-session retries.

Use bounded retry policies only for transient failures. Stop and request
authentication on expiry. Cancel watches and native resources when the owning
scope closes. Projection rebuilds must not trigger new external operations.

## PR sequence and merge gates

Each PR targets the preceding branch, has its own validation evidence, and is
reviewable independently. Keep the top branch checked out in Conductor. Do not
merge or deploy automatically. Split a row further if its review scope grows.

| PR | Deliverable | Gate before moving forward |
| --- | --- | --- |
| 1 | This committed plan and baseline/compatibility findings | Concrete product slice, ownership, migration and security risks recorded. |
| 2 | Coordinated beta.85 upgrade, retained patches, Domain dependency and installed guidance | Frozen install, unique Effect version, patch regression evidence, full existing checks/tests/build. |
| 3 | Library aggregate, core commands plus removal, versioned detail view, API, Story tests | Capacity, allocator, invariants, ownership-before-dedupe, replay and duplicate IDs proven without UI/cloud deployment. |
| 4 | Local Cloudflare host, auth, transport, legacy cutover and recovery integration | Real local Worker commands/live reads, denied access, restart and migration/recovery drills. |
| 5 | Minimal shared Foldkit screen, Tauri host, device Layers and authentication proof | Packaged app authenticates, writes, observes a denial/rejection, receives live state, expires and reconnects. Local fixture proof and real staging proof are separate required gates. |
| 6 | Complete Foldkit library UX, browser navigation, desktop packaging polish | Expand the screen only after PR 5's packaged integration gate; Story/Scene, production browser smoke and accessibility check. |
| 7 | Reliability closure, supported-platform CI and operational documentation | Full checks, actual evidence matrix and explicit remaining platform/deployment limitations. |

Begin the desktop dependency/auth feasibility investigation during PR 1 and
exercise the minimal native host as soon as server auth exists. Independent
Domain, tooling and deterministic test work may continue while a staging
approval/login is pending, but broad screen expansion depends on the packaged
integration proof required by the handoff.

## Verification and evidence

All Vitest projects remain in the root Vite+ config. Ordinary tests use
`vite-plus/test`, Effect tests use unaliased `it` from `@effect/vitest`, Domain
tests use Story, and Foldkit tests use Story/Scene. Register their assertion
helpers with lint without disabling the runtime assertion-counting rule. First
prove representative Story and Scene tests under the unchanged runtime policy:
use meaningful Vitest assertions inside supported state/view assertion callbacks
or a runner-compatible matcher that counts assertions. Lint registration alone
does not count Domain Story's internal comparisons. Never add a meaningless
assertion just to pass this gate.

| Boundary | Required observable proof |
| --- | --- |
| Domain | Valid proposal/accept/remove, invalid transitions, wrong owner, event replay, derived view and repeated command IDs. |
| API | Schema rejection, actual middleware, lost response after commit followed by same-ID retry, read after receipt, cancellation and watch resumption. |
| Migration/recovery | Existing proposed/accepted rows survive, interruption resumes, no dual writers, turn snapshots stay stable, export/restore/purge cover the new authority. |
| Foldkit | Visible pending/success/rejection/denial/unknown states, no double submit, same-ID retry, stale subscription fencing, navigation and accessible controls. |
| Device services | Preferences persist through the real native plugin, malformed stored data fails explicitly, errors/cancellation/cleanup through test Layers. |
| Browser | Development and static production assets, authenticated command and live read through the real adapter. |
| Packaged desktop | Static assets without Vite, authentication, success, denial/rejection, live update, session expiry/reconnection, native persistence and restart. |

Keep the current protocol/chat suite and coverage floors. Plant a targeted bug
for each important new invariant or regression and show the expected failure,
then restore production bytes exactly. Do not use module mocks, live provider
calls or wall-clock sleeps in unit tests. Keep explicit runtime integration
fixtures separate and label what they actually authenticate and persist.

Repository checks:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm test:coverage
pnpm build
pnpm --filter @kitties/kittyd check
```

Add reproducible Vite+ tasks for local integration and desktop work when those
targets exist. Record exact commands, OS/toolchain, transport and artifact for
each smoke. A local test issuer is not proof of a live Cloudflare Access login;
an unsigned build is not a signed distribution; a Linux run is not macOS or
Windows verification.

## Completion report

Update architecture, development, testing and deployment/recovery documentation
to describe the code actually shipped. Report the PR stack, package/file changes,
exact run commands, tests and mutation evidence, browser/desktop artifacts,
deviations and remaining risks. Mark every unexercised requirement incomplete.

The goal is complete only when the same real skill-library slice works through
Domain and Foldkit in a browser and packaged desktop, with one demonstrated
native capability and the authentication/reliability proofs above. Cloud
deployment and signed distribution remain separate authorized actions.
