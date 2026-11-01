# Architecture

The Preact PWA talks to a Cloudflare Worker over HTTPS, SSE and WebSockets. Cloudflare Access
and an in-Worker owner check protect the application. Guest, signed-hook and OAuth callback
hosts are separate ingress Workers and cannot reach owner routes.

| Component | Owns |
|---|---|
| HomeDO | Settings, encrypted secrets, registries, goals, budgets, approval rules and capacity |
| ChatDO per chat | Message deduplication, events, inbox and model/tool records |
| KittyDO per kitty | Boat lifecycle, fenced guest channel, desktop effect receipts and live fan-out |
| Workflow DO per run | Durable turns, approvals, help, goals, delegation, lifecycle, exports and restore |
| RecoveryDO | Restore epoch, operation receipts and old-run fencing outside the restored actors |
| R2 | Screenshots, guest releases and encrypted retained exports |
| Boat VM with kittyd | Persistent outbound WebSocket, desktop tools and fsynced intent receipts |

New effects check the current recovery epoch. Guest commands carry remote identity, generation,
epoch and deterministic intent IDs. Unknown outcomes park for owner review instead of sending
an effect again. Desktop-bound actors use EU placement hints. Lifecycle operations use Boat REST,
with detached idempotent systemd bootstrap and durable guest-readiness polling.

Source: [gateway](../apps/gateway/src/), [schemas](../packages/domain/),
[guest protocol](../packages/protocol/), [daemon](../guest/kittyd/).
See [the design rules](effect/PLAN.md#design-rules-apply-to-every-phase),
[engine patches](../patches/README.md) and [measured acceptance](effect/evidence/README.md).
