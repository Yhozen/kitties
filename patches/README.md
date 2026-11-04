# Pinned Alchemy compatibility and workflow fixes

The pnpm patches apply to Alchemy and `@alchemy.run/cloudflare` 2.0.0-beta.84 with Effect 4.1.1.
They update source and emitted JavaScript together.

- OAuth uses Effect 4.1 SecureRandom/Digest instead of the removed `effect/Crypto` entrypoint.
- Durable callback retries reset only when the workflow journal makes progress. Explicit operator
  resumes can re-arm parked callbacks; repeated durable clocks do not exhaust the retry counter.
- Activity failures are journaled and reach workflow error handlers even when the parent has
  `SuspendOnFailure`. Explicit activity suspension remains unjournaled and retryable.
- New workflow objects receive an explicit western-Europe location hint so desktop workflows
  and their application actors start in the same region. Existing objects retain their placement.
- Workflow creation/completion times are durable metadata. Recovery guards can reject old runs
  even when they were not registered before a restore.
- Owner-only administration supports workflow PITR, immutable row capture and bounded export
  reads. Old workflow row captures are also purged. Purging completed journals retains the execution/result tombstone to prevent replay.

Historical cloud validation covered 3/50/200/500 activities, deferreds, dedupe, failure handling,
child workflows, storage suspension and durable clocks. The automated suite and probes have
been removed; results remain in `docs/effect/evidence/`. Validate changes to patches or pins
on a deployed Cloudflare runtime: `WorkflowEngine.layerMemory` does not reproduce the Durable
Object engine's behavior.
