# Autonomy

Configure goals in the web app with a schedule or signed webhook trigger. Each scheduled slot is a
durable workflow; retries preserve delivery/message identities and do not double-charge budgets.
Webhook signatures and delivery IDs are checked on a separate ingress host before owner work is
queued. A burst of 100 deliveries was verified without drops.

Approvals carry an arguments digest and a durable decision. Approving resumes the parked task
without another chat message. Rules can allow safe reads; irreversible MCP actions still ask.
Help requests and secret typing also wait durably. Review pending approvals and help requests
in the web app after signing in through Cloudflare Access.

Kitties can delegate bounded work to child runs, use a backup kitty and record journal entries,
feedback and memory. Cancellation fences pending work. Budget/trust updates use idempotent keys.
After point-in-time recovery, older runs stop for owner review; start a fresh request after
checking its effects rather than resending unknown work.

See [autonomy and phone acceptance](effect/evidence/README.md) and [recovery](effect/RECOVERY.md).
