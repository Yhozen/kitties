# Rewrite acceptance evidence

These are machine-generated probe outputs, dated 2026-11-01. Local workerd evidence does not establish cloud latency or CPU.

- `engine-local.json`: durable clocks, deferreds, failure journaling, idempotent start, interrupts, route isolation; 3/50/200/500 activities.
- `engine-workerd-kill.json`: SIGKILL of the actual local workerd while the durable clock was pending; automatic restart and no repeated recorded effect.
- `engine-advanced-local.json`: three concurrent child starts with fixed-order joins; SuspendOnFailure, repair and explicit resume with the preceding activity recorded once.
- `callback-parking-local.json`: the actual Alchemy callback reached attempt 8, parked, and scheduled its next recovery one hour later. This is attempts without progress, not eight minutes.

Cloud results, real guest latency, constrained viewers and mobile device installation remain separate acceptance gates. Unknown outcomes inside a guest action are deliberately not auto-replayed; completed guest receipts can reconcile without asking the owner.

- `engine-cloud.json`: real Cloudflare acceptance passed for 3/50/200/500-entry workflows, duplicate starts, clocks, deferred completion and journaled failure. Observed signal-to-result wall times were 113/710/382/1035 ms.
- `engine-cloud-observed-cpu.json`: raw live-tail CPU/wall measurements for observed Gateway alarm invocations. The tail does not identify each execution; these must not be presented as a per-case replay benchmark.
- `channel-local.json`: 200 fake-guest actions over the actual hibernatable local DO channel, p95 acknowledgment 48 ms, exactly 200 effects, plus release and bypass-route checks.

## Application and autonomy acceptance (2026-11-01)

- `chat-stream-cloud.json`: 50 streamed fixture-model turns; first-token p95 1.872 s. This measures the deployed workflow and SSE path, not paid-provider latency.
- `lifecycle-persistence.json`: quiesced checkpoint restored into a new Boat VM, retaining a marker, Chrome cookie and installed package. The initial run needed manual callback recovery; this is a persistence result, not the full lifecycle gate.
- `engine-cloud-clocks.json`: after the journal-progress patch, 20 durable 250 ms waits completed in 14.2 s without manual resumes. The unpatched engine propagated callback attempts across clock/run handoffs, eventually parking successful polling workflows.
- `webhooks-cloud.json`: 100 signed deliveries, each sent twice, produced exactly 100 completed turns; altered-body replay returned 409.
- `goals-cloud.json`: real minute slot, next-slot chaining and disabled-revision fencing passed without manual resumes.

Stream soak, physical phone approval, desktop replay/cancellation, native perception A/B, capacity and chaos acceptance remain open.
