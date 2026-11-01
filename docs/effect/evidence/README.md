# Rewrite acceptance evidence

These are machine-generated probe outputs, dated 2026-11-01. Local workerd evidence does not establish cloud latency or CPU.

- `engine-local.json`: durable clocks, deferreds, failure journaling, idempotent start, interrupts, route isolation; 3/50/200/500 activities.
- `engine-workerd-kill.json`: SIGKILL of the actual local workerd while the durable clock was pending; automatic restart and no repeated recorded effect.
- `engine-advanced-local.json`: three concurrent child starts with fixed-order joins; SuspendOnFailure, repair and explicit resume with the preceding activity recorded once.
- `callback-parking-local.json`: the actual Alchemy callback reached attempt 8, parked, and scheduled its next recovery one hour later. This is attempts without progress, not eight minutes.

Cloud results, real guest latency, constrained viewers and mobile device installation remain separate acceptance gates. Unknown outcomes inside a guest action are deliberately not auto-replayed; completed guest receipts can reconcile without asking the owner.
