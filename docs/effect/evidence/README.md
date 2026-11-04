# Rewrite acceptance evidence

Historical results only: automated tests, fixtures, probes and their setup have been removed.

These probes ran on 2026-11-01. Each JSON file records its scope and limitations. Local workerd
results establish behavior, not Cloudflare CPU or regional latency. Fixture-model timings exclude
paid-provider performance. Unknown desktop outcomes require owner review and are never replayed.

| Area | Evidence | Result |
|---|---|---|
| Durable engine | `engine-cloud.json`, `engine-cloud-clocks.json` | Real DO 3/50/200/500-activity runs, duplicate starts, durable waits and journaled failures passed after the progress patch. |
| Engine failure recovery | `engine-activity-errors-cloud.json`, `engine-storage-suspension-cloud.json`, `engine-workerd-kill.json`, `callback-parking-local.json` | Terminal failures, resumable storage outages, actual local workerd termination and callback parking verified. |
| Desktop channel | `channel-boat-visible.json`, `channel-boat-eu.json` | 200 real inputs: public European client ack p95 242.6 ms, visible p95 359.6 ms, with three additional viewers. Regional DO ack p95 155 ms. |
| Stream | `stream-soak.json` | 30 minutes, three viewers including a constrained viewer, no disconnects. |
| Chat | `chat-stream-cloud.json`, `chat-contracts-cloud.json`, `tools-cloud.json`, `retry-cloud.json` | 50 fixture-model streamed turns, first-token p95 1.872 s; dedupe, approvals, redeploy and retry behavior passed. |
| Desktop workflow | `desktop-cloud.json`, `capture-cloud.json`, `vault-cloud.json` | Real capture/replay, durable help, cancellation cleanup, kill after actual click, redeploy while parked, and owner resolution without a second click. Vault typing succeeded; actor/journal scan found no plaintext canary. |
| Perception | `perception-ab-cloud.json` | Twenty real-model tasks per arm: both 20/20, references used about 74% fewer input tokens. |
| Lifecycle | `lifecycle-full-drill.json`, `capacity-cloud.json` | Automatic quiesced sleep/checkpoint/new-generation restore retained a file, cookie and package. Five active Boat desktops; sixth refused. |
| Autonomy | `webhooks-cloud.json`, `goals-cloud.json`, `delegation-cloud.json` | 100 deliveries sent twice created 100 turns; goal chaining, disable fencing, child fan-out, backup handoff and cancellation passed. |
| Phone approval | `phone-approval-cloud.json` | Owner approved on a physical iPhone after Access authentication; pending tool resumed. |
| Integrations | `oauth-cloud.json`, `mcp-cloud.json`, `mcp-endpoint-dispositions.json` | OAuth PKCE, replay and refresh races passed; server dispositions are also in `../PARITY.md`. Vendor authorizations require owner configuration. |
| Recovery | `recovery-pitr-cloud.json`, `key-escrow-mac.json` | Real ChatDO PITR retained the earlier message, removed the later message and fenced old runs. Encrypted KEK escrow saved and verified on the owner's Mac. |
| Retention and publishing | `export-retention-cloud.json`, `ci-permissions-cloud.json` | Locked export deletion refused; unlocked canary deleted. Restricted publisher updated all four Workers and assets; its token cannot change bucket locks. GitHub Actions secret and account variable were configured and verified through the owner’s Mac login; workflow execution is separate. |

The full encrypted export authenticated all 4,564 parts and reconstructed 4,544 rows
(`export-cloud.json`). Boat 5xx/lost-create, quiesce repair and TTL review passed
(`boat-chaos-cloud.json`, `quiesce-chaos-cloud.json`, `ttl-chaos-cloud.json`). A real candidate
hostname rollback to Go and back passed in under three seconds (`rollback-cloud.json`).

The purge/tombstone drill passed (`purge-cloud.json`). An actual R2 write refusal suspended
a guarded activity and resumed once after repair (`r2-error-cloud.json`). The final desktop
crash/redeploy test passed again after the dispatch optimization (`desktop-cloud.json`).

The cutover 50-action non-model run measured p50 653 ms / p95 1,421 ms. The original p95 < 1 s
target was unmet; the owner explicitly accepted cutover with this limitation documented
(`latency-cutover-decision.json`). A newer PITR plus historical-operation retry passed
(`recovery-history-cloud.json`). Production cutover and the authenticated production smoke/PITR/guest-reconnect drill passed (`production-cutover-cloud.json`). A source change or an implemented feature is not a passing acceptance result.

After cutover, a dispatch and orchestration optimization was measured on `next` with the same
harness: p50 222 ms / p95 525 ms and, in a second run, 212 ms / 453 ms. The p95 < 1 s target is met
(`step-latency-optimized-cloud.json`, `step-latency-optimized-cloud-run2.json`).
The optimized build and lifecycle billing/repair fix were published to production on 2026-11-02.
Authenticated app/asset/Health checks and repair of the production desktop are recorded in
`latency-production-rollout-cloud.json`. The latency measurements above remain from `next`.

Earlier local probes remain available in `engine-local.json`, `engine-progress-local.json`,
`engine-advanced-local.json`, `application-local.json`, `chat-local.json` and `channel-local.json`.
The interrupted stream probe is retained as `stream-soak-interrupted.json`; the later completed soak
is the acceptance result.

Detached bootstrap duplicate-launch/reconnection acceptance passed (`bootstrap-service-cloud.json`).
The candidate screenshot/dedupe/replay also passed before cutover (`candidate-desktop-cloud.json`).

The final application was published to both production and next with the restricted token
(`final-publish-cloud.json`). Local checks and removal scope are in `cutover-validation.json`.
