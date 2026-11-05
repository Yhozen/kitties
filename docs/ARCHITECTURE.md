# Architecture

The web client talks to a Cloudflare Worker over HTTPS, SSE and WebSockets. Cloudflare Access
and an in-Worker owner check protect the application. Guest, signed-hook and OAuth callback
hosts are separate ingress Workers and cannot reach owner routes.

The online library boots Foldkit at `/library.html` in desktop/mobile browsers and
Tauri's local incognito WebView. Other routes retain Preact. Both hosts use the
official Domain HTTP NDJSON client and the same built assets; see
[development](DEVELOPMENT.md).
Current proof and release limits are recorded in
[cross-platform implementation evidence](CROSS_PLATFORM_STATUS.md).

| Component | Owns |
|---|---|
| HomeDO | Settings, encrypted secrets, registries, goals, budgets, approval rules and capacity |
| ChatDO per chat | Message deduplication, events, inbox and model/tool records |
| KittyDO per kitty | Boat lifecycle, fenced guest channel, desktop effect receipts and live fan-out |
| Workflow DO per run | Durable turns, approvals, help, goals, delegation, lifecycle, exports and restore |
| RecoveryDO | Restore epoch, operation receipts and old-run fencing outside the restored actors |
| Domain Library aggregate | Skill lifecycle, command receipts, metadata and monotonic skill allocator |
| Domain SkillDetail views | Instruction bodies and source-version barriers per owner/skill |
| Domain directory/backfill | Native object discovery, projection delivery and resumable backfill |
| R2 | Screenshots, guest releases and encrypted retained exports |
| Boat VM with kittyd | Persistent outbound WebSocket, desktop tools and fsynced intent receipts |

New effects check the current recovery epoch. Guest commands carry remote identity, generation,
epoch and deterministic intent IDs. Unknown outcomes park for owner review instead of sending
an effect again. Desktop-bound actors use EU placement hints. Lifecycle operations use Boat REST,
with detached idempotent systemd bootstrap and durable guest-readiness polling.

Library authorization rechecks RecoveryDO before commands, receipt retries and
reads. A restore freezes the complete discovered lineage, captures immutable
bounded images, verifies a new lineage and allocator floor, then publishes its
epoch. A permanent Home fence prevents a restored legacy snapshot from reopening
skill writes. New turns capture a coherent accepted Library snapshot and keep it
immutable across retries; the frontend's selected detail reads also wait for the
known Domain source revision.

Foldkit keeps interaction state and frozen pending intent. It displays an unknown
transport outcome without allocating a new command ID. Device Layers own a single
versioned preference record and ephemeral native authentication. Rust owns OAuth
and narrow native permissions, with no second library backend. Production cutover
remains disabled pending the operational and provider gates in
[the cross-platform plan](CROSS_PLATFORM_PLAN.md).

Source: [gateway](../apps/gateway/src/), [schemas](../packages/domain/),
[guest protocol](../packages/protocol/), [daemon](../guest/kittyd/).
See [the design rules](effect/PLAN.md#design-rules-apply-to-every-phase),
[engine patches](../patches/README.md) and [measured acceptance](effect/evidence/README.md).
