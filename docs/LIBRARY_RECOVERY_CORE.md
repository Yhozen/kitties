# Library migration and recovery core

This layer defines the ports and durable state transitions used by the Library
host. It does not mount routes, initialize remote state, or enable cutover.
The following host-integration PR supplies Home/RecoveryDO bindings and the native
coordinator; [the plan](CROSS_PLATFORM_PLAN.md) remains the cutover authority.

`LibraryLegacyStore` accepts a synchronous SQL/transaction port. A frozen inventory
and permanent local writer fence survive retries and old Home snapshots. Current
control is reconciled during construction/status, and each write/remove checks its
fence in the same transaction. Pages are bounded to 64 rows and 2 MiB encoded;
strict SQL JSON/NUL/ID checks precede body materialization. Missing timestamps use
the frozen SQL timestamp. Invalid rows remain frozen and stop migration.

`LibraryMigration` validates the inventory before starting authority, sends trusted
Domain import commands with deterministic IDs, resumes from actual count/floor,
verifies exact projected bodies and metadata, and finalizes only when complete.
A same-inventory ready retry is read-only; another inventory conflicts. Metadata
preflight uses Domain's reserved-byte policy with linear accumulation. It does
not weaken the 512 KiB capacity limit or omit any input.

`GlobalRecoveryAuthority` and `LibraryRecoveryStore` share one synchronous SQL
transaction. They journal freeze/capture/load/activation/publication, immutable
images, operation identity, object membership and allocator floor. Publication
completion records a durable marker and preserves any later unrelated global
recovery owner. Retained old captures require selected-set authorization.

`AdvanceLibraryAllocatorFloor` is server-only, separately authorized before direct
send and cached receipt access. It preserves retained receipts and never decreases
the high-water mark. Public/import APIs do not expose that authority. A covered
floor is an allowed no-op even at revision exhaustion.

`LibrarySnapshot` reads accepted detail bodies at their source versions and verifies
a coherent catalogue before a new turn. `TurnConfiguration` persists the first
coherent snapshot and reuses it after later edits/removal or restart. Verified
Access identity and current-epoch admission are explicit services; client input
cannot supply trusted finalization state.

Validation uses real SQLite ports, Domain Story/InMemory, Effect TestClock and
controlled failures. Tests exercise lost acknowledgements, PITR writer fences,
byte/row bounds, delayed and inconsistent projections, immutable turns, stale
operation scopes, complete membership, monotonic allocators and historical
publication replay. Targeted mutations fail and source bytes are restored exactly.
These unit/in-process checks do not establish cloud deployment, native streaming,
packaged authentication, retained export upload, owner reset or purge completeness.
