# Latency baseline

These are the numbers the rewrite reports against. Every phase that changes a path measures it
again on `next` and adds a row to the tables below. It never edits the old rows.

The historical baseline figures come from the Go deployment at commit
[`7f408a1`](https://github.com/Yhozen/kitties/commit/7f408a17a33e87c29701dc0ec0ca89df3b75947a).

## Measured today

| Path | Value | Conditions | Source |
|---|---|---|---|
| Human input, request to reply | 6.329–8.728 s, median 6.809 s (9 of 11 delivered) | Revision 5 counter test. Two inputs were rejected during a lifecycle transition, and the stream disconnected during the test. | [CLOUD-PLAN.md:124-128](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/docs/CLOUD-PLAN.md#L124-L128) |
| Human input (earlier session) | about 7–8 s | 2026-10-27 baseline, before the warm-input layer | [CLOUD-PLAN.md:74](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/docs/CLOUD-PLAN.md#L74) |
| Live view lag | about a quarter of a second behind | rects stream, documented behaviour | [DESKTOP.md:89](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/docs/DESKTOP.md#L89) |
| Template build plus first startup | 2m14s | five small VMs | [CLOUD-PLAN.md:69](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/docs/CLOUD-PLAN.md#L69) |
| Clone from template | 17–27 s | subsequent VMs in the same test | [CLOUD-PLAN.md:69](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/docs/CLOUD-PLAN.md#L69) |
| Normal stop with the checkpoint helper | 1.710 s | production canary | [CLOUD-PLAN.md:130-131](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/docs/CLOUD-PLAN.md#L130-L131) |
| Encrypted backup | about 2m15s | maintenance window; new work is refused during it | [CLOUD-PLAN.md:73](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/docs/CLOUD-PLAN.md#L73) |
| Gateway recovery | about 2m8s, including about 21 s to replace the active route | fresh generation | [CLOUD-PLAN.md:73](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/docs/CLOUD-PLAN.md#L73) |

**These input numbers are an interrupted baseline.** The stream dropped during the test, and the
warm-input layer (commit `6666e97`) has never been measured in production
([CLOUD-PLAN.md:55](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/docs/CLOUD-PLAN.md#L55)).
Spike 3 re-measures the Go warm-input path cleanly before anything is compared with it: at least
50 inputs, stream connected, p50 and p95.

## Where the time goes today (inferred)

The code has no per-step timing, so this budget is reconstructed from reading it. Source:
[`internal/boat/input.go`](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/boat/input.go#L11-L77),
[`internal/boat/ssh.go`](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/boat/ssh.go#L104-L213)
and
[`internal/boat/generation.go`](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/boat/generation.go#L14-L50).

| Step | Estimate | Avoidable after the rewrite |
|---|---|---|
| Browser → Worker (Access) → Coordinator DO → Gateway DO | 50–200 ms | partly: one hop to KittyDO |
| Gateway DO start checks and container health probe, on every request | 100–500 ms | yes |
| DO → container → Go handler | 20–100 ms | yes |
| Wait on the global lifecycle lock shared by all kitties | 0 to several s | yes |
| Unfiltered account-wide `GET /sandboxes` (generation guard) | 300–1000 ms | yes: only lifecycle operations scan |
| `GET /sandboxes/{id}` | 200–600 ms | yes |
| `POST /sandboxes/{id}/sshkey` and rewriting `known_hosts` | 500–2000 ms | yes: no SSH |
| New `ssh` process and handshake (`ControlMaster=no`) | 600–1500 ms | yes: persistent WebSocket |
| Remote `sudo`, `env`, systemd checks, `kitty-ready` with Python startup | 300–800 ms | yes: checked once per connection |
| `xdotool` | 20–200 ms | no |
| Reply back through container, DO and Worker | 100–300 ms | partly |
| Visible change through the separate frame stream | 250–600 ms | partly: diff moves into the guest |

That totals about 2.4–7.8 s before lock waits. Roughly 70% is control-plane work the new design
removes.

## Targets

These come from [PLAN.md](PLAN.md) and [CUA-RESEARCH.md](../CUA-RESEARCH.md). They are acceptance
targets, not measurements.

| Path | Target | Measured in |
|---|---|---|
| Warm human input acknowledgement | p95 < 250 ms | spike 3 (prototype), Phase 4 (at least 200 inputs) |
| Click to visible change | p95 < 500 ms | Phase 4 latency fixture |
| First streamed token after the model starts | p95 < 2 s | Phase 5, over 50 turns |
| Non-model overhead per agent step | p95 < 1 s | Phase 7 |
| Continuous live stream | 30 min without fallback | Phase 4 soak |

## Results on `next`

| Date | Phase | Path | p50 | p95 | Notes |
|---|---|---|---|---|---|
| 2026-11-01 | 4 | Real Boat input acknowledgment | 123.5 ms | 242.6 ms | 200 inputs from a European Boat client through public Cloudflare WS; four viewers total. [Evidence](evidence/channel-boat-visible.json) |
| 2026-11-01 | 4 | Real Boat click to visible pixel | 197.3 ms | 359.6 ms | Same monotonic client clock; decoded changed pixel. Not a physical mobile-browser measurement. |
| 2026-11-01 | 4 | Regional DO to real guest acknowledgment | 90 ms | 155 ms | 200 inputs; excludes browser to European edge. [Evidence](evidence/channel-boat-eu.json) |
| 2026-11-01 | 5 | First streamed fixture-model token | — | 1.872 s | 50 turns through deployed workflow and SSE; excludes paid-provider characteristics. [Evidence](evidence/chat-stream-cloud.json) |
| 2026-11-01 | 4 | Continuous real stream | 30 min | no disconnects | Three viewers, including a constrained viewer. [Evidence](evidence/stream-soak.json) |

| 2026-11-01 | 7/10 | Non-model overhead, real desktop action | 653 ms | 1,421 ms | 50 turns; original p95 < 1 s target unmet. Owner accepted cutover with this limitation documented. [Evidence](evidence/step-latency-cloud.json), [decision](evidence/latency-cutover-decision.json) |
