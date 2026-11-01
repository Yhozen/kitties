# Kitties on Effect

Kitties is being rewritten from Go into TypeScript with [Effect](https://effect.website). It will
run on Cloudflare Workers and Durable Objects, with Alchemy Effect Workflows for durable work,
and keep its desktops on Boat. The Go system stays live and frozen until the verified hard cutover. No migration or extended
parallel rollout is required (D16).

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
| 3 | Walking skeleton, PWA shell, go/no-go spikes | engine probes passed; remaining perception and platform gates open | [Evidence](evidence/README.md): cloud 3/50/200/500-activity runs, local kill/recovery, deferreds, child workflows and callback parking; [20 cloud durable waits](evidence/engine-cloud-clocks.json) verify the alarm-progress patch |
| 4 | Live desktop: `kittyd`, fast input, live view | deployed; stream soak remains open | [#17](https://github.com/Yhozen/kitties/pull/17); [200 real inputs](evidence/channel-boat-visible.json): ack p95 242.6 ms, visible p95 359.6 ms |
| 5 | Brains: chat, providers, first MCP and native tools | deployed; UI and recovery acceptance in progress | [50 streamed turns](evidence/chat-stream-cloud.json): fixture first-token p95 1.872 s; [MCP approval/redeploy](evidence/tools-cloud.json), dedupe and cancel passed |
| 6 | Lifecycle: sleep, restore, capacity | deployed; live restore drill in progress | [Persistence drill](evidence/lifecycle-persistence.json): file, cookie and package survived a new VM/generation; full chaos and capacity gates open |
| 7 | Durable desktop tasks and perception | implementation in progress | Fenced child workflows, screenshot storage, vault references and durable help; live acceptance and perception A/B open |
| 8 | Autonomy: goals, webhooks, approvals, notifications | goals and signed hooks deployed; notifications/rules implemented; delegation acceptance in progress | [100 deliveries / 200 requests](evidence/webhooks-cloud.json), [goal chaining and disable fencing](evidence/goals-cloud.json); delegation fan-out, backup handoff, journal and limit tools implemented; cloud and phone approval gates open |
| 9 | Integrations: MCP with OAuth, Google and Microsoft | implementation in progress; live authorization checks pending | Encrypted PKCE, single-use bypass callback, RFC 9728/8414 discovery, DCR/CIMD, refresh single-flight and minimal native file/calendar tools; [local acceptance](evidence/application-local.json) |
| 10 | Hardening, backups, cutover, Go deleted | not started | — |

## Ground rules while the rewrite runs

- The Go code under `cmd/`, `internal/`, `desktop/` and `deploy/cloudflare/` is frozen. Only
  fixes for the live deployment land there.
- New code lives under `apps/`, `packages/` and `guest/` (from Phase 2).
- `next.kitties.rccpr.tech` is not production until Phase 10. Data entered there is test data.
- A change to a pinned version of `effect`, `alchemy` or `@alchemy.run/cloudflare` re-runs the
  spike-1 suite in the same PR.
