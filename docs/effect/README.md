# Kitties on Effect

Kitties now runs TypeScript and [Effect](https://effect.website) on Cloudflare Workers and
Durable Objects, with Alchemy Effect Workflows and Boat desktops. Production switched to
[kitties.rccpr.tech](https://kitties.rccpr.tech) on 2026-11-01 after authenticated smoke and recovery
checks. The retired Go Worker and legacy R2 buckets remain available; the source and native clients
have been removed. The owner authorized deletion of old Boat checkpoints on 2026-11-02, so legacy
desktop checkpoints are no longer available for rollback. There was no data migration (D16).

The non-model p95 <1 s goal is now met on `next`: two 50-action runs measured **222 ms median / 525 ms
p95** and **212 ms / 453 ms** (previously 653 ms / 1,421 ms, accepted at cutover as a limitation).
The optimized build was published to production on 2026-11-02; these measurements are from `next`.

## Read in this order

| Document | What it is for |
|---|---|
| [PLAN.md](PLAN.md) | The approved plan: why, the target architecture, the design rules, ten phases with exit criteria, and verification. |
| [DECISIONS.md](DECISIONS.md) | What the owner decided, what each decision removes, and the technical decisions from research. |
| [PARITY.md](PARITY.md) | Every feature, screen and endpoint today, and whether it is kept, changed or dropped, and in which phase. |
| [CURRENT-SYSTEM.md](CURRENT-SYSTEM.md) | How the Go system works, the behaviours to carry over, and the known defects not to rebuild. Code links are pinned to commit `7f408a1`. |
| [RESEARCH.md](RESEARCH.md) | Dated, sourced facts about Alchemy Workflows, Effect 4, Vite+, Cloudflare limits, Boat, agent-desktop and agent-browser. |
| [RISKS.md](RISKS.md) | The risk register, with mitigations and triggers. |
| [LATENCY-BASELINE.md](LATENCY-BASELINE.md) | Today's measured numbers, the inferred per-hop budget, targets, and results as phases land. |

## Phase status

Each phase is a stack of draft PRs on top of `codex/durable-state-recovery` (#13). Update this
table when a phase starts, when its exit criteria are measured, and when it merges.

| Phase | Scope | Status | Exit evidence |
|---|---|---|---|
| 1 | Backing documentation and the plan | committed; draft PR open | [#14](https://github.com/Yhozen/kitties/pull/14), commit `1aca978`; links and pinned paths checked |
| 2 | Toolchain groundwork: coverage rules removed, pnpm + Vite+ workspace | deployed to dev | Vite+ check, typecheck, PKCE regression, task build and Alchemy deploy passed; [dev](https://dev.kitties.rccpr.tech) |
| 3 | Walking skeleton, PWA shell, go/no-go spikes | deployed; platform gates passed | [Evidence](evidence/README.md): cloud 3/50/200/500-activity runs, local kill/recovery, deferreds, child workflows and callback parking; [20 cloud durable waits](evidence/engine-cloud-clocks.json) verify the alarm-progress patch |
| 4 | Live desktop: `kittyd`, fast input, live view | deployed; input and stream gates passed | [#17](https://github.com/Yhozen/kitties/pull/17); [200 real inputs](evidence/channel-boat-visible.json): ack p95 242.6 ms, visible p95 359.6 ms; [30-minute three-viewer soak](evidence/stream-soak.json) had zero disconnects |
| 5 | Brains: chat, providers, first MCP and native tools | deployed; chat, UI and recovery acceptance passed | [50 streamed turns](evidence/chat-stream-cloud.json): fixture first-token p95 1.872 s; [MCP approval/redeploy](evidence/tools-cloud.json), dedupe and cancel passed |
| 6 | Lifecycle: sleep, restore, capacity | deployed; restore, capacity and lifecycle faults passed | [Full sleep/restore drill](evidence/lifecycle-full-drill.json): automatic completion on generation 4, with file, cookie and package intact; [five active desktops / sixth refused](evidence/capacity-cloud.json); [5xx/lost-create](evidence/boat-chaos-cloud.json), [quiesce repair](evidence/quiesce-chaos-cloud.json) and [TTL review](evidence/ttl-chaos-cloud.json) passed |
| 7 | Durable desktop tasks and perception | deployed; live desktop recovery passed; latency target passed on next | Fenced child workflows, screenshot storage, vault references and durable help; [20-task real model A/B](evidence/perception-ab-cloud.json): both arms 20/20, refs use ~74% fewer input tokens and are the default. [Optimized step overhead](evidence/step-latency-optimized-cloud-run2.json): p95 453 ms on next; optimized build published to production. |
| 8 | Autonomy: goals, webhooks, approvals, notifications | deployed; autonomy and physical phone acceptance passed | [100 deliveries / 200 requests](evidence/webhooks-cloud.json), [goal chaining and disable fencing](evidence/goals-cloud.json); delegation fan-out, backup handoff, journal and limit tools implemented; [two children, backup handoff and cancellation passed](evidence/delegation-cloud.json); [physical iPhone approval passed](evidence/phone-approval-cloud.json) |
| 9 | Integrations: MCP with OAuth, Google and Microsoft | deployed; server dispositions and OAuth race verified | Encrypted PKCE, single-use bypass callback, RFC 9728/8414 discovery, DCR/CIMD, refresh single-flight and minimal native file/calendar tools; [cloud OAuth](evidence/oauth-cloud.json) and [server dispositions](PARITY.md#deployed-dispositions-2026-11-01); real vendor authorizations require owner configuration |
| 10 | Hardening, backups, cutover, Go deleted | deployed to production; recovery passed; legacy source removed | Retained encrypted exports, external restore epoch and PITR deployed; [Mac key escrow](evidence/key-escrow-mac.json), [ChatDO PITR](evidence/recovery-pitr-cloud.json) and [retention enforcement](evidence/export-retention-cloud.json) passed. [Full encrypted export](evidence/export-cloud.json), [purge](evidence/purge-cloud.json), [R2 failure](evidence/r2-error-cloud.json), [restricted publisher/CI](evidence/ci-permissions-cloud.json) and [candidate owner sign-in](evidence/candidate-owner-cloud.json) passed. [Production cutover and PITR/guest reconnect](evidence/production-cutover-cloud.json) passed; legacy source and CI removed. |

## Operating rules

- Production is `kitties.rccpr.tech`; `next` remains a test deployment.
- Legacy cloud resources are retained for rollback and must not be destroyed without owner approval.
- Configure providers and authorize vendor connections in the fresh application; test fixtures are removed.
- A change to a pinned version of `effect`, `alchemy` or `@alchemy.run/cloudflare` reruns the engine acceptance suite.
- See [deployment](../DEPLOY.md), [recovery](RECOVERY.md) and [costs](COST-REPORT.md) for operations.
