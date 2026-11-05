# Domain provider extensions

The published beta.85 packages remain the implementation of Domain persistence,
RPC and Foldkit integration. Two small, opt-in extensions expose boundaries
needed by the Library migration. Framework sources, examples and upstream tests
are not workspace packages; only pnpm patches and matching emitted files are
committed. Both patches retain the existing no-option behavior.

## Recovery hooks

`@alchemy.run/cloudflare/Domain/RecoveryHooks` exports a typed service selected
through `layerDurableObjects({ recovery: hooksLayer })`. The factory caches by
the exact Layer identity as well as its existing options. One Worker cannot
silently use two different recovery hook implementations. Share one Layer.

The provider passes frozen model/layout/jurisdiction and generated class
descriptors to namespace and object hooks. Namespace hooks cover both declared
objects and namespace bindings used by directory-only and native-workflow
isolates. The object hook receives both initialization phases; application
admission can precede either phase and any callback registration. The original
aggregate, view, queue and backfill storage algorithms are unchanged.

Two provider helpers adapt its erased native member/transport types at that
boundary. `scopeRecoveryMembers` preserves each Effect's success, error and
service requirements while supplying an application scope; effects stay lazy
and member receivers/descriptors are retained. `recoveryNamespaceCalls` awaits
selection and registration before obtaining a stub, retaining the distinct
HTTP response type. Raw transport failures follow the existing provider's
defect semantics. Application code supplies the actual authority and scope;
these helpers do not authenticate calls or remove Effect requirements.

An explicit, pure `backfillInput(model)` supplies JSON in the native Workflow's
creation parameters. Reconciliation retains those exact parameters on every
creation attempt and notices configuration changes. The body rejects missing
input before its first durable step. Application code validates the immutable
epoch/lineage mapping and pins it around the body. A workflow queued before
restoration must never resolve the current lineage when it first starts later.

The hook is an integration boundary, not a recovery implementation. Application
code must still supply durable registration before invocation, complete bounded
capture, frozen constructors, immutable restores, callback handling, allocator
floors, coordinated admission and operation journals. The Library integration
remains disabled until those pieces and their runtime checks are complete.

## Strict RPC decoding

`Domain.Api` accepts optional `parseOptions: SchemaAST.ParseOptions`. These
options annotate the RPC group passed into the original API construction, so
the official HTTP NDJSON server applies them before middleware and receipt
lookup. The Library uses `{ onExcessProperty: "error" }`.

This matters because the default Struct codec drops an unexpected `key` on a
command carrying `target`; middleware cannot reject ambiguity it no longer
sees. Merely annotating the API's exposed group creates another group and does
not change the one its fetch handler closed over. The patch adds configuration
at construction without copying handlers or implementing another protocol.

The separate WebSocket live-read decoder does not consume this option. The
initial Library integration uses official HTTP NDJSON for browser and desktop
and refuses WebSocket upgrades. This patch makes no WebSocket strictness claim.

## Validation and boundaries

Both patches were compiled with the pinned TypeScript/Effect dependencies.
Source, JavaScript, source maps and declarations were compared to the installed
files. Clean application, reversal and reapplication reproduced the candidate
bytes. Cloudflare's existing workflow patch remains intact.

Isolated native workerd probes exercised seven recovery cases against the typed
provider candidate: registration before invocation; no original initialization
for unknown/frozen/staging identities; exact 13-object native KV and scheduler
images; pending delivery in a new lineage; original receipts and allocator;
queued-before-first-execution backfills; and a whole-host restart retaining the
old workflow scope. Three no-hook native cases and five factory/input probes
also passed. These are provider seam experiments, not verification of a completed
application recovery coordinator. Scratch references and results are kept under
`.context/cross-platform-domain-recovery/` and are not dependencies.

The strict API probe called the actual API fetch with real Domain InMemory and
Effect RPC. An ambiguous request using a retained command ID failed before any
middleware, admission or send call; a valid request returned its existing
receipt; no-option construction retained upstream behavior. Substituting stock
API output in the isolated probe made the strict assertion fail. The restored
candidate passed again. Evidence is under
`.context/cross-platform-library-session/domain-port/`.

The maintained workflow regression command is `pnpm test:workflows`. Library
application/native tests will accompany the integration that opts into these
hooks. Neither local native storage nor these patches prove cloud placement,
cross-object arbitrary-time PITR, Access login, or a deployed migration.

Installed patch SHA-256 values:

- Cloudflare: `0c0d99ba4fcf574ac1397285c852ad7217df1333394026b0f9389a50baf8240f`.
- Domain: `56208771ea8fd614f0bd9f7ce8a629ea2523beb4d9a1fdab4027724d406e189f`.

No remote state initialization, infrastructure application or production data
migration is authorized by installing these packages. See
[the upgrade guide](ALCHEMY_UPGRADE.md) and
[the implementation plan](CROSS_PLATFORM_PLAN.md).
