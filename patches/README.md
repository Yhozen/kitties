# Pinned Alchemy patches

The pnpm patch applies to `@alchemy.run/cloudflare` **2.0.0-beta.85** with
Alchemy/Domain beta.85 and Effect 4.1.1. It changes the workflow engine's source,
emitted JavaScript and source map together. The workflow declarations are unchanged;
the application deliberately narrows the administrative extension in
`apps/gateway/src/workflow-admin.ts`.

The same Cloudflare patch also supplies opt-in Domain recovery hooks, including
immutable creation-time scope for native backfills. A second patch for
`@alchemy.run/domain` exposes Effect RPC parse options when constructing an API.
Both include matching compiler output and declarations. See
[Domain extension notes](../docs/DOMAIN_PROVIDER_EXTENSIONS.md) for the exact
contracts, evidence and limitations. Installing these extensions alone neither
enables the Library backend nor performs a data migration.

## Guarantees retained

- Activity failures are journaled and reach workflow error handlers even when
  the parent has `SuspendOnFailure`. Explicit activity suspension remains
  unjournaled and retryable.
- New workflow objects request western-Europe placement (`weur`). Existing
  objects keep their identity and placement. The gateway uses the memoized
  `layerDurableObjectEngine()` with no jurisdiction option.
- Execution creation, its initial wake and its start timestamp commit together.
  Completion and its timestamp also commit together. The existing `StartedAt`
  context remains available to recovery guards; historical missing timestamps
  remain zero so guards fail closed.
- The internal `adminCall` bridge permits only the seven existing administration
  methods: summary, bookmark, restore preparation, eviction, capture, bounded
  export-part reads and purge. The gateway remains responsible for owner
  authorization; these methods are not public HTTP endpoints.
- Immutable captures include execution, activity, deferred, clock and metadata
  rows, plus beta.85's progress counter, alarm callbacks, alarm schema version
  and scheduled events. Repeating a capture ID returns the original manifest.
  Export parts contain at most 32,768 SQLite characters; blob values retain hex
  encoding. Invalid part coordinates and unknown table names are rejected.
- Purging completed journals preserves the execution/result tombstone, durable
  timestamps, progress counter and alarm bookkeeping. A repeated execution ID
  cannot repeat its original work. Old export captures are removed too.

Beta.85's progress-aware wake/deferred/clock implementation is retained. Its
callback retry accounting resets only when journal progress justifies it; the
old beta.84 retry patch is not copied over those upstream blocks.

## Retired compatibility patch

The core `alchemy` beta.84 patch is no longer required. Beta.85 uses Effect
4.1's `effect/crypto/SecureRandom` and `effect/crypto/Digest` in OAuth and exposes
both through its Node/Bun `PlatformServices`. Source, emitted code and
TypeScript declarations were checked. A local S256 authorization probe using
the real platform Layer verified the challenge against Node's independent
SHA-256 implementation without calling an OAuth server.

See [the upgrade guide](../docs/ALCHEMY_UPGRADE.md) for remote state-store v8
migration and rollback constraints. Installing the dependency is separate from
authorizing a remote state-store upgrade or application deployment.

## Validation

Port validation includes strict isolated source type checking, clean patch
application/reversal/reapplication, byte comparison of installed source/emitted
files, and SQLite probes for timestamps, failures, purge deduplication and
immutable export. Deliberate failure-journaling, tombstone and capture mutations
were rejected. Unicode export reconstruction and invalid admin coordinates were
also exercised.

These service-port probes do not emulate Durable Object scheduling. Run the
separate, owned Linux integration fixture through Vite+:

```sh
pnpm test:workflows
```

It bundles the installed package into native workerd with isolated persistent
SQLite storage. The beta.85 run exercised typed failure handling, eleven
progress callbacks with a two-attempt budget, parking/external resume, ten
durable clocks, a 70,000-character export, an actual workerd SIGKILL, immutable
recapture, purge deduplication and a full host restart. It loads no deployment
credentials or remote state. Runtime results live in `.context/workflow-check/`
and CI uploads its result/log files. See [testing](../docs/TESTING.md).

Local workerd does not establish cloud placement or Cloudflare PITR behavior;
staging validation remains required before rollout.

Historical cloud validation of the beta.84 patch remains under
`docs/effect/evidence/`. It is not evidence that beta.85 was deployed or tested
in Cloudflare.
