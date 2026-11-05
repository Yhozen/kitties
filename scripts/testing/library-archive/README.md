# Local native Library archive proof

With the pinned Node 26 toolchain on `PATH`:

```sh
pnpm test:library-archive
# Compilation only; does not start Runtime:
node scripts/testing/library-archive/run.mjs bundle
# Capture/rearm only:
node scripts/testing/library-archive/run.mjs capture
# Guarded capture-buffer cleanup and expired-plan abandonment:
node scripts/testing/library-archive/run.mjs prune
# Server discovery and the exact production Library prune Activity program:
node scripts/testing/library-archive/run.mjs scheduled
```

Run native modes in a serial validation window, separately from full repository
checks on memory-constrained hosts. The completed desktop fixture and existing
Library/workflow/HTTP harnesses remain unchanged.

The owned worker composes the production LibraryModel, recovery hooks, object
administrator, `LibraryControl.layer`/adapters, RecoveryDO, capture coordinator,
`LibraryArchiveOperations`, production archive RPC adapters, retained service
and encryption. It uses independent disk storage, native namespace identities,
the `EXPORTS` local R2 binding, and a cryptographically random fixture KEK kept
under the run's private context directory. Logs and evidence contain no key.
No application CLI, deployment planner, credentials or remote state are used.
Outbound traffic is restricted to loopback.

The controller owns a detached process group and checks the exact host command
and run directory before intentional termination. Each native request, process
shutdown, milestone wait and inventory walk has a finite budget. Assertions
await recorded milestones; they do not poll until a desired assertion passes.

Test-only hooks gate successful production native capture/rearm calls before
their caller can acknowledge them, a real conditional R2 write before its
upload receipt, and the earliest durable restore intent before retained reads.
Hard process death and same-ID retry exercise each boundary. A capture step can
already have finished its object's image; the test does not claim that every
image requires multiple calls. The fixture's milestone DO does not own
application recovery progress. Its delivery gate leaves a real Domain outbox
and native alarm backstop pending before capture.

The buffer-loss simulation deletes only the chosen capture ID from
`library_admin_images`, `library_admin_rows` and `library_admin_parts`. The
fixture requires a completed capture and matching registered source lineage;
it leaves native KV, scheduler SQL, held tables, guards and recovery metadata
intact. This operation is confined to the test worker and is not added to the
production admin interface.

The separate `prune` mode uses the production `LibraryCapturePruning` service.
It exercises incomplete upload, a pin on a second archive alias, and missing or
corrupted real local R2 objects in isolated fresh namespaces. A damaged archive
is never repaired by replacing its body or provider upload timestamp; its failed
reservation remains on disk. The successful cleanup uses another fresh state.
Verification calls assert at most eight real encrypted reads, durable failed-item
cursors, and zero local deletion before the verified grant.

A private per-run policy timestamp is bound by the local host. The fixture
supplies `LibraryCapturePruneClock` during Worker construction, so the unchanged
production RecoveryDO captures it before serving native RPCs. Only prune policy
and retained verification use this wall time; capture timestamps, monotonic time,
sleep and native alarms remain real. Tests use the exact 30-day age boundary and
original 90-day expiry without rewriting capture or upload records.

Read-only native snapshots cap each KV/table scan at 1024 rows and each encoded
fingerprint at 4 MiB. The installed `scopeRecoveryMembers` helper preserves
original member execution. Read-only snapshots are taken immediately around the
original admin Effect within one RPC, outside its semaphore and transaction.
They record native KV, scheduler, guard and alarm data; their equality does not
claim general concurrent scheduler immutability. Buffer fingerprints
compare the selected and other captures across restart; legitimate native
callback completion is observed separately, without claiming scheduler byte
identity over the whole restart. The controller then kills
the owned host after a real completed prune step but before its coordinator ACK,
and checks the original receipt is replayed after restart. Only the selected
capture's three buffer tables become empty. Native capture stores inline image
rows, so its part tables can already be empty; before counts distinguish observed
row/image deletion from the separate unit evidence for part deletion. Production
export replay and retained restore remain possible after cleanup; Native restore
refuses before freezing.

An independent partial-cleanup case advances policy time to expiry, then calls
explicit production abandonment. It kills the host after a real `StopPrune`
receipt before acknowledgement, resumes the same operation, and verifies every
remaining buffer stays unchanged. Abandonment permanently refuses the old Native
source/export without claiming successful deletion, and permits fresh capture
while preserving global workflow state and prior-run permission.

The independent `scheduled` mode uses four real captures and the server's
`capturePruneCandidates` RPC. Alias-pinned, incomplete and young archives are
excluded while an old committed archive is selected. A narrow native Workflow
calls the production `LibraryPruneSweep.run()` Activity program; it does not
reimplement discovery selection or pruning. The fixture records successful
server-discovery calls separately from direct discovery probes.

After a real prune receipt but before its acknowledgement, the controller kills
the owned host. Policy time then admits the previously young archive. Same-ID
Workflow replay must finish only its journaled selection, with no new discovery,
and preserve that later archive's buffers. A new Workflow discovers the later
eligibility, while a final empty sweep excludes both completed captures. Existing
selected receipt, live state, pinned/incomplete buffers, global workflow state
and prior-run permission remain observable. Empty 64-key page boundaries are
covered separately by SQLite and Workflow tests, avoiding large native fixtures.

The assertions cover unchanged global workflow epoch/uncached
prior-run permission during capture, paused Library admission, fresh constructor
proof for every sealed member, raw receipts and projection catch-up, native
callback/alarm preservation, same-ID capture/rearm/upload crash recovery, sealed
membership after source growth, and retained-only encrypted restore after loss
of local capture buffers. They compare the surviving ciphertext winner's
digest, size and original upload timestamp across process death. A rejected
retained read keeps its restore pin held; a Native source cannot replace the
bound retained intent before or after publication. Only completed publication
releases the pin. Replaying a completed restore preserves later writes and the
outgoing allocator floor.

Run results, process cleanup records and host logs live under the allocated
`.context/library-archive-check/` directory. The buffer-loss scenario retains
the authoritative RecoveryDO journal and ephemeral KEK; it does not simulate
loss of all recovery metadata or the encryption key.

The generated-bundle-only mutant below must exit nonzero at the uncached global
authority assertion. It changes one checked coordinator call from capture to
destructive freeze; application and installed provider files remain unchanged:

```sh
LIBRARY_ARCHIVE_MUTANT=destructive-capture node scripts/testing/library-archive/run.mjs capture
```

To restore its generated bundle, run `host.mjs <that-run-directory> --bundle-only`
without the mutation variable and compare its hash with the normal source build.
Do not launch a native host merely to restore bundle files.

This tests local native persistence and scheduling. It does not establish cloud
placement, arbitrary cross-object atomic PITR, or enforcement of R2's deployed
30-day lock/90-day expiry. Those resource policies are unchanged.
