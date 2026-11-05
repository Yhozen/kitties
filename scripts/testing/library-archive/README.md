# Local native Library archive proof

With the pinned Node 26 toolchain on `PATH`:

```sh
pnpm test:library-archive
# Compilation only; does not start Runtime:
node scripts/testing/library-archive/run.mjs bundle
# Capture/rearm only:
node scripts/testing/library-archive/run.mjs capture
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
