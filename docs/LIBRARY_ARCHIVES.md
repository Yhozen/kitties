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

## Validation

Use Node 26 and the repository's pinned dependencies:

```sh
pnpm check
pnpm test
pnpm test:library-archive
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

Guarded administrative-buffer pruning, owner reset and retired-object erasure
are separate work. Authoritative live event and deduplication history are retained;
the published Domain API has no supported atomic live-history compaction contract.
