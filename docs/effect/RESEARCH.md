# Research and implementation gates

Checked 2026-11-01. Package-source facts below were inspected in the exact npm tarballs,
not inferred from product marketing. Deployment probes remain pending until their outputs are
recorded. An available API is not evidence that our integration works.

## Version and module map

`npm view` confirmed `effect@4.1.1`, `alchemy@2.0.0-beta.84`,
`@alchemy.run/cloudflare@2.0.0-beta.84`, `vite-plus@1.4.0`, and the matching
`@effect/{sql-sqlite-do,platform-bun,vitest,ai-openai}@4.1.1` on 2026-11-01.
Alchemy peers on Vite `^8.0.7` and Effect `^4.0.5`; Vite+ includes its Vite fork and Vitest
5.0.5. Its supported Node versions include our Node 26.13.0. Pin Vite through the Vite+ alias,
and pin one Effect instance for the new workspace. Keep `deploy/cloudflare` independent.

| Concern | Effect 4 module/package |
|---|---|
| Typed values, services and errors | `effect/Schema`, `effect/Context`, `effect/Effect` |
| HTTP API/client/router | `effect/httpapi/*`, `effect/http/*` |
| Durable work | `effect/workflow/{Workflow,Activity,DurableDeferred,DurableClock}` |
| AI, tools and MCP | `effect/ai/*`; provider implementations in `@effect/ai-*` |
| Durable Object SQL | `@effect/sql-sqlite-do`, `effect/sql/Migrator` |
| Guest runtime | `@effect/platform-bun` |
| Tests | `@effect/vitest`; Vite+ supplies Vitest 5 |

Sources: [Effect 4.1.1](https://www.npmjs.com/package/effect/v/4.1.1),
[Alchemy beta.84](https://www.npmjs.com/package/alchemy/v/2.0.0-beta.84),
[Vite+ 1.4.0](https://www.npmjs.com/package/vite-plus/v/1.4.0).
Do not assume a separate Gemini package is available: use the compatible endpoint and verify it.

## DurableObjectEngine

[Official execution description](https://alchemy.run/cloudflare/compute/effect-workflows/#how-a-run-executes-on-durable-objects).
The pinned `@alchemy.run/cloudflare/src/Workflows/DurableObjectEngine.ts` declares one DO class per
workflow and one DO instance per execution. Tables are `workflow_execution`, `workflow_activity`,
`workflow_deferred`, `workflow_clock`. An activity key is `${activity.name}/${attempt}` and stores
its encoded Exit, including completed failures. Replays begin at the top; cached activities return
their stored result. Consequently transient retries must happen inside the activity, and names
must be deterministic and unique.

Runs and clocks use `alchemy/Callback.makeCallback` with an initial five-second retry delay.
`alchemy/Callback.ts` documents at-least-once delivery, an eight-attempt default and hourly parked
recovery. A 15-minute interrupted callback is a **segment** boundary; validate it under workerd,
not with an accelerated in-memory test. Parent references wake child joins. DurableDeferred
completion inserts once and wakes the execution. DurableClock defaults to a 60-second in-memory
threshold (`effect/src/workflow/DurableClock.ts`); explicit `inMemoryThreshold: 0` forces short
polls to suspend. No general journal purge is exposed here; implement retention explicitly.

A durable activity journal does not make an unrelated external effect atomic. KittyDO and kittyd
must reconcile a persisted intent before any effect can be resent.

Pinned source: [Cloudflare package](https://unpkg.com/@alchemy.run/cloudflare@2.0.0-beta.84/src/Workflows/DurableObjectEngine.ts),
[callback contract](https://unpkg.com/alchemy@2.0.0-beta.84/src/Callback.ts),
[durable clock](https://unpkg.com/effect@4.1.1/src/workflow/DurableClock.ts).

## Messaging and test constraints

Pinned `Workers/RpcWebSocket.ts` has per-activation parsers and pending sets, closes with code 1012
on activation reset, persists metadata in socket attachments, and requires exclusive ownership
of the object's auto-response pair. It rejects buffered serializers. Do not assume arbitrary
frame traffic can share that transport; the frame channel is separate. Its documented reconnect
behavior does not substitute for effect receipts.

Use black-box workerd tests for storage, alarms and eviction. `WorkflowEngine.layerMemory` is
useful for ordinary deterministic unit tests but cannot prove DO behavior. Evaluate Cloudflare's
Vitest integration before making it a required dependency.

## Boat

The existing audited API base is `https://boat.dev/api/v1` (`internal/boat/api.go`). Official docs:
[create](https://docs.boat.dev/api/reference/sandboxes/create-sandbox),
[permanent snapshots](https://docs.boat.dev/api/reference/snapshots/save-saved-snapshot),
[API documentation](https://docs.boat.dev/).
The Go live probes recorded restore dropping labels, a 24-hour idempotency window, a new remote
identity on restore, and five active desktops. Those observations are in the pinned
[current-system contracts](CURRENT-SYSTEM.md), not assumptions about a future API.

For the rewrite, verify command execution, file writes and host exposure from the current
published API before calling them. Commands install/bootstrap only; persistent outbound WSS
carries warm actions. Deliver guest tokens by exact remote-ID file write. Templates contain no
account credentials. Probe outbound WSS across stop/resume, glibc/CPU baseline, AT-SPI, CDP and
both perception tools on an isolated `kn-` machine. Do not change the existing Go fleet.

## agent-desktop and agent-browser

[agent-desktop](https://github.com/vercel-labs/agent-desktop) provides accessibility references,
JSON results and stale-reference detection. Linux needs `at-spi2-core` and a graphical session.
It does not provision VMs, provide a remote viewer, or host the agent loop. The current README
also advertises a native FFI library: the old plan's assertion that spawning the CLI is the only
integration option was too broad. Start with the CLI behind kittyd; measure FFI only if needed.
Pin an actual release after probing Openbox/Xvfb rather than assuming GNOME coverage applies.

[agent-browser](https://github.com/vercel-labs/agent-browser) is the initial web perception choice
through Chrome's existing CDP endpoint. Pixels remain available. Default perception changes only
after the 20-task comparison meets success and image-token thresholds.

## MCP

`effect@4.1.1/src/ai/McpClient.ts` has protocol versions `2025-11-25` and `2026-07-28`, static
transport headers and Streamable HTTP session handling. Token discovery/refresh is our layer;
rebuild the client with a fresh token for each activity. Unannotated tools require approval and
server annotations can only raise risk.

Probe GitHub, Stripe, Notion, Linear, Atlassian, Slack and Home Assistant from a deployed Worker.
For each record initialize/listTools, negotiated protocol and auth requirements. Owner OAuth
registration or missing credentials are a pending disposition, not a successful probe.

Source: [pinned McpClient](https://unpkg.com/effect@4.1.1/src/ai/McpClient.ts).

## Cloudflare operational limits

Validate the account plan and current limits at deployment. Reference limits are 10 GB per SQLite
DO, roughly 2 MB per row, 128 MB per isolate and up to 32,768 hibernatable sockets. Paid Worker
CPU can be configured to 300,000 ms; this does not extend an alarm's wall-time execution window.
Journals contain R2 keys rather than screenshots. PITR is per object and is not a distributed
transaction; restoredEpoch gates old workflows. Export retention must exceed its bucket lock.

Sources: [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
[Worker limits](https://developers.cloudflare.com/workers/platform/limits/),
[PITR](https://developers.cloudflare.com/durable-objects/api/point-in-time-recovery/),
[R2 locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/).

## Computer-use research

The supplied Cursor/AnyOS analysis supports the controller/guest split and step-stamped,
retryable provisioning. A fixed desktop resolution is enough for stable coordinates; it does
not by itself prove why Cursor uses a particular size. xdotool is common infrastructure and
ffmpeg libraries may be transitive dependencies. Broken citation markers in that analysis do
not establish FUSE behavior, published throughput or private artifact protocols. Our own guest
must quiesce GVFS/document-portal mounts before checkpoints regardless of Cursor's design.

## Acceptance ledger

| Probe | Threshold written before execution | Result |
|---|---|---|
| Engine | failure journaling, durable short clock, deferred resume, ordered children, workerd kill/redeploy, 50/200/500-entry replay; bounded segment/parking | pending |
| Effect ledger | kill between dispatch and ack; reconcile without duplicate or owner prompt | pending |
| Boat channel | reconnect over stop/resume; warm ack p95 <250 ms; clean Go baseline N>=50 | pending |
| Frames | 15 fps, two viewers including throttled 3G; bounded memory and unchanged ack gate | pending |
| Startup | configured CPU/startup limits, bundle fits account limit, traces observable | pending |
| Guest capabilities | baseline binary, CDP snapshot, AT-SPI status | pending |
| MCP | initialize/listTools or explicit vendor/auth disposition for all seven | pending |

## Owner scope update: hard cutover

On 2026-11-01 the owner confirmed there are no customers and authorized a hard cutover with no
migration. Production changes after the functional/recovery/security gates pass. A parallel
rollout, compatibility window and seven-day soak are no longer release prerequisites. Existing
R2 buckets and checkpoints remain retained; replacing the live route does not delete them.

## Phase 2 evidence — 2026-11-01

The unmodified pins do **not** load together: Alchemy beta.84 imports the removed
`effect/Crypto` entrypoint. `patches/alchemy@2.0.0-beta.84.patch` ports OAuth randomness and
PKCE to `effect/crypto/{SecureRandom,Digest}` and supplies those Layers in both platform
entrypoints. Source, emitted JS and public types are patched, so Node and Bun agree. A regression
test checks fresh state/verifier values and the RFC 7636 S256 challenge against Node crypto.
No workflow engine source changed. Re-run the Phase 3 engine suite before altering this patch.

Vite+'s bundled Vite fork has npm version 1.4.0 while providing the Vite 8 API; the explicit
peer rule admits that alias. capnp-es's TypeScript peer range is older than TypeScript 7; the
workspace admits the pinned compiler after typechecking. `pnpm peers check` reports no conflicts.

`vp check`, `tsc --noEmit`, `vp test --run` (one PKCE regression) and `vp run build -r` pass.
Alchemy deployed the Effect hello Worker and static assets at `https://dev.kitties.rccpr.tech`,
with workers.dev/previews off, owner-only Access and 300000 ms CPU configured.
The branch-protection API returned 403 to the GitHub integration; no branch rule was changed.
Legacy enforcement is removed in Makefile/CI and their development/deployment documentation.

## Phase 3 observations — 2026-11-01

Effect-native actors on `@effect/sql-sqlite-do` and the DO workflow engine run under real workerd.
Local acceptance passed for short durable clocks, signals, failure journaling, interruption,
3/50/200/500-entry replay, a workerd SIGKILL, concurrent children joined in fixed order, and
SuspendOnFailure followed by dependency repair and explicit resume. The prior side effect remains
journaled once. See [raw evidence](evidence/README.md). Signal-to-result wall time is not CPU.

The actual Alchemy callback parks after **eight attempts without progress**, with an hourly
recovery wake. A 15-minute wall cutoff is a platform constraint, not a configurable automatic
segmenter in DurableObjectEngine. Application workflows must keep segments below ten minutes,
use durable clocks for every poll, and split attempts into children. Do not interrupt a side
effect with `Effect.timeout`; reconcile its durable receipt instead.

The PWA shell passes four Chrome desktop/mobile tests, including offline navigation with owner
APIs excluded from the service worker cache. Real iOS installation remains untested.

`alchemy dev --stage dev` replaced the earlier cloud dev resource with a local resource because
both use the same stage state. Production was unaffected. Local development now uses the
dedicated `local` stage; cloud `dev`, `e2e`, `next` and production stay separate.

The isolated Boat capability VM has glibc 2.39, AVX2, Node 24.22.1, Chrome, xdotool, AT-SPI core
and an active 1920×1080 X display. CDP is not listening by default. This VM uses `noEnv: true`,
name `kn-spike-g1` and the deployment label `next-1793547500`; the archived Go fleet was untouched.
