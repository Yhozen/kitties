# Library capture and retained archives

Library backups use a capture-only lease in the permanent RecoveryDO journal.
They pause Library admission and discovery, freeze and evict the registered
objects, seal their native images, then resume the same lineage and epoch. Every
sealed object must acknowledge a distinct, initialized constructor before the
lease opens traffic. Capture never advances the global destructive-recovery epoch
or marks already admitted workflows for review. Timeouts leave journaled progress
for the same operation ID to resume; they do not reopen traffic.

The operation ID and code digest are bound before the first image read. Changing
either identity on retry is refused. Sealed membership is paged independently of
the live registry, so objects discovered after capture are excluded. Images retain
native KV, SQL scheduler rows, alarms, receipts, event history and pending delivery.
The server records the first seal's timestamp and preserves it on replay.

After source resume, an immutable export grant authorizes reads of only that
capture's exact source identities, ordinals and manifests. It grants no mutation
authority. The upload lifetime is separate from the capture lease: slow or failed
R2 upload leaves Library traffic available.

## Retained storage

The existing `RetainedExports` R2 bucket stores Library data under
`exports/library-v1/<archiveId>/`. Each bounded image part is encrypted with the
existing AES-GCM key; AAD binds its exact object key. The authenticated contents
also bind the archive, capture, code digest, native source and image metadata.
The permanent journal retains immutable plaintext/ciphertext hashes, sizes,
upload times and readback acknowledgements. An existing object is decrypted and
verified before it can satisfy a retry; a HEAD result alone is insufficient.

Metadata is stored in encrypted, hash-linked pages of eight objects. The final
manifest commits only after every image part and metadata page is acknowledged.
Randomized encryption does not require overwriting a conditional-write winner:
replay verifies the winning ciphertext against the original plaintext identity.
`expiresAt` is based on the oldest retained object's upload time, including parts,
pages and manifest. It is not extended by a later manifest upload. The bucket's
existing 30-day lock and 90-day object lifecycle remain unchanged.

Upload and restore pins are durable. Restore pins survive interrupted reads and
failed publication. Releasing a restore pin requires the exact permanent restore
operation, selected set, published lineage and completed publication marker.

## Restore and production integration

`LibraryArchiveOperations.restore` selects the retained source explicitly. It
binds the selected set, code digest, archive ID and manifest digest in the permanent
restore journal before acquiring a pin or reading R2. Changed inputs or a switch
to the native source under the same operation ID are refused, including after
publication. Historical unbound restore records cannot silently acquire a new
source identity. It validates the committed, unexpired archive and reads every
part through that source; a failure never falls back to local capture buffers. The normal recovery
coordinator loads fresh staged objects, verifies images and constructor activation,
raises the allocator floor and publishes the replacement lineage. Unlike capture,
restore deliberately enters destructive global recovery. A completed same-ID
retry replays its published result before attempting to acquire another restore
pin, and cannot rewind a later operation.

An already-expired archive is refused before acquiring the destructive lease.
Completed publication replay remains available after expiry because it returns
the existing journaled result without reading or restoring data again.

R2 body reads have byte and time bounds. Interruption cancels the reader and
releases its lock without waiting indefinitely for a provider cancellation
acknowledgement; interrupted reads cannot acknowledge a part or complete a
manifest. The R2 header request has no abort API, so a local timeout does not
claim physical cancellation before headers arrive. An interrupted restore keeps
its durable intent and pin for an exact retry.

The archive journal and permanent recovery metadata must survive. This is not a
claim of restoring from R2 after losing RecoveryDO, arbitrary per-object PITR, or
an atomic snapshot spanning both Library and the legacy Home/Chat stores.

The existing Export workflow includes a distinct Library archive section once
Library is initialized. Legacy-only exports cannot authorize Library cleanup.
Owner-only Library export and retained-restore routes remain behind
`KITTIES_LIBRARY_CUTOVER_ENABLED`, which defaults to false. They additionally
require `KITTIES_LIBRARY_CODE_DIGEST`, a reviewed SHA256 of the compatible deployed
code/layout; the request must match that deployment input. Missing configuration
fails closed. This change supplies no deployed value or provider modification.

## Capture-buffer cleanup

`LibraryCapturePruning.prune` accepts an operation ID, capture ID and archive ID.
The server derives the code and manifest digests from the committed archive. A
capture must be at least 30 days old and its original archive expiry must still
be in the future. The first reservation atomically binds those identities and
creates a permanent source barrier in the same database transaction. Active
upload/restore pins on any archive alias and existing Native consumers prevent
reservation. The barrier prevents new capture/destructive maintenance and use of
the selected Native image without changing ordinary traffic, workflow epoch or
permission.

The verifier reads and authenticates the actual encrypted manifest, metadata
pages and every part against their original receipts. Each call reads at most
eight bounded objects and journals its cursor after each success. A failed read
leaves that item pending and the reservation held. Deletion starts only after the
durable verification is complete; neither HEAD nor an old upload acknowledgement
is a fresh verification.

Each object deletes at most 64 rows per step, restricted to the selected capture
in `library_admin_parts`, `library_admin_rows` and `library_admin_images`, in that
order. The deletion cursor and terminal receipt commit with the deletion. Other
captures, live KV, events, command receipts, scheduler rows, alarms, holds, guards
and permanent source metadata remain. Exact per-object acknowledgements precede
the permanent completion proof and retained reservation release. A lost reply is
retried with the same operation ID. Completed export replay reads the committed
archive; it does not require deleted Native buffers.

Expiry refuses further deletion grants and unrecorded delete acknowledgements.
An expired partial operation can be explicitly abandoned with the same request.
It first enters `stopping`, then sends a stop-only request to every sealed member
through the same object semaphore as deletion. Each durable stop tombstone drains
an admitted delete and blocks stale grants. Only all exact stop acknowledgements
permit `abandoned` and release the maintenance barrier. Retained aliases release
their reservation only when both journals have matching terminal states and the
exact permanent proof. No automatic abandonment or expiry extension occurs.

Abandonment does not claim a successful backup or complete deletion. Remaining
buffers stay permanently unavailable through Native/export authorization. A
valid, unexpired retained alias can still be used after abandonment; the selected
expired archive remains expired. New captures can proceed once stopping finishes.

Owner-only POST routes `/v1/recovery/library/prune` and
`/v1/recovery/library/abandon-prune` use `{operationId, captureId, archiveId}` and
remain behind disabled Library cutover. They derive identity from historical
archive metadata rather than requiring its digest to match the current deploy.
The application exposes no timestamp, age override or verification flag.

The private policy clock is selected in RecoveryDO construction and explicitly
provided to its prune-policy methods; an RPC caller's ambient clock does not
cross the native boundary. Capture timestamps and native scheduling keep their
ordinary clock. The native pruning run below exercises that clock across actual
RPCs, exact age/expiry boundaries and process restarts.

The existing Purge workflow has a separate Library section. Discovery examines
at most 64 permanent capture keys per page before filtering, so an empty eligible
page still advances its cursor. It selects a matching committed, unexpired
archive, excludes active pins across aliases, and preserves interrupted plans'
original request IDs. New IDs are deterministic hashes of capture/archive identity.
Each selection page is recorded as an Activity result before cleanup begins;
replay uses that selection even if another capture becomes eligible meanwhile.
Expected refusals are reported separately from successful cleanup, with at most
64 detailed refusals in the summary. Storage errors suspend for retry with the
same identities. Expired/stopping plans are reported for explicit abandonment.
No Library object is passed to the legacy object-kind purge dispatch.

## Validation

Use Node 26 and the repository's pinned dependencies:

```sh
pnpm check
pnpm test
pnpm test:library-archive
pnpm test:library-prune
pnpm test:library-prune-scheduled
```

The maintained [native harness](../scripts/testing/library-archive/README.md)
uses real local workerd, RecoveryDO, the production coordinator and local R2. It
keeps state and receipts under `.context/library-archive-check/`. It intentionally
kills only its own processes, restarts the same disk state and retries the same
operation. Local R2 tests persistence and restore behavior; they do not prove
cloud object-lock enforcement or placement.

The full native run at
`.context/library-archive-check/1793849256632-d8d0dedd/results.json` passes four
scenarios. Capture/rearm preserves all 11 sealed objects and the prior workflow's
uncached permission through two process crashes. A lost R2 write acknowledgement
reuses the original verified ciphertext and upload time. After all 11 local
capture buffers are removed, restore performs 77 encrypted reads and zero native
part reads, publishes lineage 2, preserves the original receipt and allocates
the next skill above the outgoing floor. Same-ID replay survives another process
restart and preserves later writes. All seven owned host process groups are clean.

The separate native prune run at
`.context/library-archive-check/1793851811791-ef6e80f2/results.json` passes eight
scenarios. Incomplete upload, an alias restore pin, and missing/corrupt encrypted
objects refuse cleanup. The successful case verifies 79 encrypted objects in
calls of at most eight, prunes 11 sealed members while protecting a larger live
registry and another capture, replays a lost delete receipt, then restores from
retained storage into epoch 2. Native capture rows/images existed and were removed;
the separate part table was already empty. SQLite tests exercise nonempty parts
and the 64-row deletion bound.

Expired partial cleanup survives a stop-acknowledgement crash, abandons without
deleting the ten remaining members' buffers, permanently refuses the old Native
source, and permits a fresh capture with the prior workflow permission intact.
Twelve prune and twelve stop observations found protected KV/scheduler/guard
state unchanged immediately around each admin Effect in one native RPC, outside
its semaphore and transaction. Across restarts, four legitimate callback
completions were recorded separately; scheduler byte identity across restart is
not claimed. All 25 owned host process groups are clean.

The final scheduled run at
`.context/library-archive-check/1793852626797-686e404c/results.json` passes three
cases with the native Workflow engine and four real captures. Server discovery
excludes pinned, incomplete and young captures. After a successful prune step
loses its acknowledgement, the restarted Workflow reuses the exact request and
receipt and performs no second discovery, even though another capture has become
eligible. A later sweep selects that capture; a final sweep excludes both completed
plans. All four owned process groups are clean. SQLite tests cover the 64-key
page boundary; the Workflow regression proves empty-page continuation and the
literal `start` cursor that exposed an Activity-name collision during review.

Owner reset and retired-object erasure remain open. Authoritative live event and deduplication history are retained;
the published Domain API has no supported atomic live-history compaction contract.
