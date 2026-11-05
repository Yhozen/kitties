# Library domain

The shared skill-library model lives in `packages/domain/src/Library/` and uses
published Alchemy Domain beta.85 with Effect 4.1.1. This package implements the
pure model and in-process API contracts. The application still uses the legacy
library until hosting, migration and recovery gates in
[CROSS_PLATFORM_PLAN.md](CROSS_PLATFORM_PLAN.md) are complete.

## Authority and operations

`LibraryModel` contains one `Library` aggregate per branded owner ID and one
versioned `SkillDetail` view type keyed by owner/skill. The gateway will map its
verified single owner to the stable ID `owner`; an email or caller-supplied ID
is not proof of ownership.

The explicit public `LibraryApi` exposes:

- `ProposeSkill(owner, { name, body }, { commandId })`, replying with the
  server-allocated skill ID and proposal revision.
- `AcceptSkill(owner, { skillId, expectedProposalRevision }, { commandId })`.
- `RemoveSkill` with the same identity/revision input.
- Authoritative `Library` catalogue reads and per-skill `SkillDetail` reads.

Proposals are not accepted automatically. Bodies are immutable for an identity.
Fresh redundant acceptance/removal commands reject explicitly. A retry reuses
its original command ID **and exact input**: Domain returns the retained receipt,
including when a caller mistakenly sends different valid input with the same ID.
A transport failure must remain an unknown outcome until reconciled.

The aggregate retains active metadata, the allocator high-water mark, the
catalogue revision and import progress. Bodies live in events and detail views.
Removal frees catalogue capacity without reusing an ID or storing a growing
removed-ID set. Removed bodies remain in event/receipt history and detail state;
removal is not a promise of physical erasure.

New IDs contain `kitties-skill-` followed by a canonical 16-digit decimal ordinal.
Allocation checks the exact safe-integer ceiling; it never rounds or wraps.
Name/body limits retain 80/64,000 UTF-16 code units and reject whitespace-only
names. Encoded JSON also has a 512 KiB UTF-8 budget per catalogue/event/detail.
Admission reserves metadata growth so acceptance and removal remain possible
at capacity. There is no arbitrary lifetime item-count limit.

## Import and authorization

`LibraryImportApi` is separate and must never be mounted publicly. A trusted
migration imports a frozen inventory with deterministic command IDs, preserving
legacy IDs, acceptance and timestamps. Reserved IDs must be canonical, and
advance the allocator. `FinalizeLibraryImport` checks the inventory identity,
imported count and high-water mark. Even an empty owner needs explicit
finalization. Public writes and reads reject until their authority is ready.

`LibrarySession` and `LibraryImportSession` declare middleware; they do not
verify credentials themselves. Server middleware must authenticate, decode the
whole payload with `LibraryRequestPayload`, and call
`ownsLibraryPayload(actor, rpc._tag, payload)` **before** entering a handler or
looking up a receipt. The helper rejects conflicting selectors, wrong owners,
unknown operations and inappropriate import authority. Duplicate receipts bypass
aggregate decisions, so decision-time checks alone cannot authorize requests.

Only after ownership checks may middleware read the internal Library service to
supply `LibraryActor.importFinalized`. This is a trusted fact, never input from a
client. Aggregate reads independently check their own finalization state; detail
reads check the trusted fact and owner namespace. A recovery-lineage switch must
fence old request context, command intents, receipts and subscriptions.

## Consistent turn reads

Catalogue `proposalRevision` identifies the immutable body fact;
`detailRevision` advances on acceptance. Both are source event versions, not the
detail view's local cursor. Read each selected detail with its own source version:

```ts
client.SkillDetail.get(key, {
  atLeast: { stream: libraryStream, version: entry.detailRevision },
});
```

A receipt for a different skill is not a catch-up barrier for this key.
`acceptedSkillsForTurn` supplies the existing lexical ID ordering and eight-skill
limit; `skillPrompt` keeps the 12,000-character body limit. Future server capture
must check coherent catalogue/detail revisions and persist the first coherent
turn configuration, as described in the implementation plan.

## Verification

```sh
pnpm test --project domain
pnpm check
pnpm test:coverage
pnpm build
```

Thirty tests cover Story transitions/replay, import/finalization, byte capacity,
canonical allocation/exhaustion, derived views and actual in-process middleware.
Generated histories use deterministic inputs and explicit delivery drains.
Meaningful Vitest assertions inside Story callbacks retain runtime assertion
counting. Four deliberate mutations were rejected: wrong-owner receipt access,
removed-ID reuse, weakened capacity and stale acceptance detail revisions.

These tests do not claim native persistence, wire transport, real Access
verification, migration inventory equivalence, server turn-capture consistency,
or packaged desktop behavior. Those remain separate integration gates.
