# Desktop cost and latency report

Boat's default desktop is 4 vCPU and 8 GB RAM at $0.036 per running hour. The live
`GET /sandboxes?include=cost` response on 2026-11-01 agreed: the four capacity fixtures each
reported $0.00001 per running second. These are provider-reported usage amounts before plan
credits. Archived machines are not included in the running-hour projection.

| Running desktops | Hour | 24 hours | 30 days continuously running |
|---|---:|---:|---:|
| 1 | $0.036 | $0.864 | $25.92 |
| 5 | $0.180 | $4.320 | $129.60 |

This projects VM runtime only. It excludes model usage, Cloudflare requests/CPU/duration, R2
storage/operations, network and any separately billed snapshot retention. A complete invoice
cannot be inferred from a short acceptance run. Idle desktops quiesce and checkpoint after
15 minutes; TTL is an emergency bound, not the sleep mechanism.

The single-desktop public-input acceptance used a European Boat client and real `kittyd` with
four viewers: acknowledgment p50/p95 123.5/242.6 ms, visible change p50/p95 197.3/359.6 ms over
200 clicks. The five-desktop capacity drill brought all five provider machines online and
refused the sixth. It establishes the capacity limit, not simultaneous five-desktop interactive
throughput. See [latency](LATENCY-BASELINE.md) and [capacity evidence](evidence/capacity-cloud.json).

The final non-model agent-step run measured p50 653 ms and p95 1,421 ms over 50 real desktop
actions, down from p50 2,648 ms / p95 3,378 ms before dispatch optimization. The original p95
< 1 s target remains unmet. The owner accepted this measured limitation for cutover; provider
model latency and human approval waits are excluded. See [step evidence](evidence/step-latency-cloud.json)
and [the cutover decision](evidence/latency-cutover-decision.json).
