# Library backend and recovery boundaries

The backend uses the published Alchemy Domain host and its retained opt-in
recovery hooks. `Library` is the only skill writer; `SkillDetail` holds each
instruction body. The public API excludes import and allocator-recovery commands.
Server-owned authority is separate from browser/native session state.

## Admission and transport

`LibrarySessionLive` validates exact RPC tag/target, command epoch and current
recovery authority before entering Domain, including cached receipt retries.
Signed Access assertions supply the configured owner and expiry. Browser requests
also require same-origin policy; native bearer transport still requires the
forwarded signed assertion. The local identity Layer is limited to the local stage.

`LibraryHttp` mounts official HTTP NDJSON at `/v1/library/rpc` and its single
trailing-slash alias. The official client adds that slash to an empty request URL.
WebSocket upgrades, ambiguous selectors and query-bearing library routes are
refused. `/v1/library/session` supplies only safe owner, epoch and expiry metadata.
Absolute expiry closes an idle request scope. Prompt physical disconnect cleanup
has a separate failing local-runtime gate; it is not inferred from expiry tests.

RecoveryDO RPCs return a small `Success`/`Refused` envelope so expected journal
refusals survive the native transport. Stubs are acquired lazily per call, never
captured while building a Layer for later requests.

## Legacy inventory and turns

`LibraryLegacyStore` receives Home's synchronous SQL/transaction port. Construction
and status reconcile current RecoveryDO authority with a permanent local writer
fence. Freeze uses one transaction for `INSERT SELECT` and its marker. Ordinary
skill writes/removes use the same transaction for their fence and mutation.
No constructor performs import or freezes data automatically.

Defaults bound inventory to 65,536 rows and 512 MiB, with pages of at most 64 rows
and a conservative 2 MiB encoded budget. SQL checks strict JSON, NUL exclusion and
safe ASCII IDs before body materialization. Invalid rows retain their ordinal and
stop migration. Missing `updatedAt` uses the frozen row's SQL timestamp exactly.
No row is dropped, truncated or silently repaired.

Migration validates all bounded pages before initializing authority, resumes from
real Domain count/floor, sends deterministic import intents in an immutable epoch
scope, and verifies exact frozen metadata and detail bodies before finalization.
Preflight counts Domain's reserved JSON size incrementally rather than repeatedly
encoding the growing prefix. The 512 KiB limit rejects the same first oversized
row. Ready reruns are no-ops only for the same inventory identity, preserving
post-cutover edits.

`LibrarySnapshot` captures the accepted catalogue, reads each detail at its source
revision, verifies lifecycle/revisions and rechecks the catalogue. It retries only
within a bounded policy. `TurnConfiguration` stores the first coherent result in
Home's transaction; existing saved turns are reused after mutations and restarts.
Legacy public skill writes return `LIBRARY_API_REQUIRED`; file routes remain.

## Coordinated restore

The global recovery authority and Library journal share RecoveryDO's synchronous
SQL transaction. Discovery registers each exact native identity before invocation.
Capture requires a held scheduler, durable freeze acknowledgement and a distinct
constructor nonce. Images retain bounded raw KV, SQL and alarms, including source
history, receipts, directory state, view cursors and pending deliveries.

The coordinator copies a selected immutable sealed set into a new lineage,
independently verifies it, activates only complete membership, advances the
allocator to the maximum retained/outgoing floor, and publishes the new epoch.
A durable activation nonce permits retries after activation/eviction ACK loss.
Retained capture reads require distinct selected-set authorization; they do not
relax general operation ownership. Completed restore replay returns its original
receipt without rewinding edits. `completePublication` durably marks completion
and never clears a later unrelated Home recovery fence.

## Evidence and incomplete operational gates

Maintained commands on Node 26:

```sh
pnpm test --project gateway --project domain
pnpm test:library
pnpm test:library-http
pnpm test:library-bundle
```

The 12-case native recovery/Home run used actual production control, coordinator,
Home, snapshot and migration modules. It covers partial-copy SIGKILL, lost activation
ACK, older retained set restore, original receipts, allocator floor and fresh ID,
unrelated Home recovery replay, interrupted import, permanent legacy fences,
accepted instructions in new turns, and byte-stable saved turns after restart.
Evidence: `.context/library-check/all-1793843207153-127c21fa/results.json`.

After a crash, a committed projection may exceed the 5-second migration detail
budget. The test observes its eventual source barrier with a bounded read and
retries the same import. It does not clear provider leases or raise production
deadlines. Local restart evidence is not cloud PITR evidence.

Native HTTP passes command/receipt, typed denial/rejection, strict decoding, expiry,
fresh reconnect and cached-receipt fencing. Its browser/native idle-abort assertions
still fail. A plain-JS native stream also observes no disconnect until a new chunk
is emitted; no heartbeat or private protocol workaround is installed. See
`scripts/testing/library-http/README.md` for reproducible commands and limits.

Targeted mutations cover PITR reopening a writer, incorrect imported body
verification, raw control-character materialization, stale/coherently omitted turn
instructions, incomplete captures/activation, lowered allocator floors and
publication replay across unrelated recovery. Exact restoration logs are kept in
`.context/`; no modified provider persistence code is used by these tests.

**Production cutover remains disabled.** Local sealed sets are not yet integrated
with retained export upload/retention, owner reset and purge for all Domain stores.
The existing Home/workflow export is not a complete Library backup. Arbitrary
independent cross-object PITR is unsupported. Do not enable the cutover flag,
perform a production migration, or roll back to a legacy-writing Worker on the
strength of these local checks. Deployment and managed Access configuration require
separate authorization. The application-only uploader refuses the new native
Workflow manifest; the full Alchemy binding plan must be reviewed first.
