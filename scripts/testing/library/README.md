# Local native Library recovery checks

From the repository root, with the pinned Node 26 toolchain on `PATH`:

```sh
pnpm test:library
```

The controller bundles the production Library model, recovery hooks, object
administrator, image codec, `LibraryControl.layer`, `LibraryControlAdapters`,
`LibraryRecoveryCoordinator.layer`, `HomeDOLive`, the production migration and
turn services, and RecoveryDO journal. Native workerd uses isolated filesystem state under
`.context/library-check/`; no application CLI, deployment state, credentials,
or remote bindings are loaded. Outbound network access is limited to loopback.
Each child owns a detached Linux process group. Shutdown and intentional
`SIGKILL` affect only that group's processes and have finite deadlines.

The run checks discovery before invocation; exact layout validation; complete
frozen KV, scheduler SQL and native-alarm images; immutable capture; bounded
parts and digest verification; partial-load crash recovery; activation after
eviction; lost activation acknowledgements after a host crash; pending delivery
to a destination absent from the sealed inventory; publication and stale
admission; preserved raw receipts; and continuity after host restart. A second
operation uses the production coordinator to select an older sealed capture on
a retired lineage, preserve the outgoing allocator floor, publish epoch 3,
allocate a fresh ID, and replay the completed request without rewinding new
writes. Direct image access outside the selected recovery and mutations of the
retired source remain refused. The first operation drives the native ports
directly to inject the two crash windows.

A fresh storage subtree then seeds legacy accepted/proposed rows through Home,
pauses after the first durable import, and kills the host. The native view's
`atLeast` read observes projection catch-up before the same migration resumes;
no production timeout or lease is changed. A crash can outlive the migration's
five-second detail budget: the native queue's callback backstop is ten seconds,
and its lease is sixty seconds. The test uses a bounded seventy-second read to
observe catch-up, not assertion retries. It does not claim immediate projection
recovery. The resume checks frozen timestamp fallback, preserved IDs, allocator
floor, and legacy write/remove/insert fences. It accepts a fresh Domain proposal,
captures its body through the real Home turn service, removes it, and verifies
new turns omit it while saved legacy and Domain turn bodies remain byte-identical
after restart.

The queued native Workflow fixture records the same immutable creation input
as DomainBackfill, waits at a controlled native step, then invokes the installed
provider's `withBackfillRecovery` wrapper and production recovery hook. After
cutover, its old input is refused rather than rebound. Missing input is refused
before the wrapped body. This fixture controls the scheduling boundary; it does
not claim to exercise Cloudflare's production queue dispatcher. The model's
ordinary native DomainBackfill also runs during model initialization.

`Status.nonce` identifies the current constructor. `Status.activating` is the
persisted nonce recorded by `Activate`. A retry must use the latter as
`VerifyActive.before`, including after eviction and loss of the acknowledgement.
Verification requires an initialized constructor with a different current nonce.

`results.json`, bundle output, captured images, and host logs remain in each
run's directory. The harness verifies installed workflow-engine file hashes
on clean shutdown. Forced termination intentionally skips those finalizers;
the next host rebuild uses the same installed sources.

The controller exercises the native ports, journal, control adapter and recovery
coordinator, migration, and Home turn capture. It does not prove backup upload,
retention workflow, cloud placement, or cloud PITR. A local quiescent image set
is the recovery boundary; independent per-object bookmarks do not establish
cross-object atomic PITR. Production publication still requires the separate
coordinator and migration gates in `docs/CROSS_PLATFORM_PLAN.md`.

For a focused run, use `node scripts/testing/library/run.mjs full` or
`node scripts/testing/library/run.mjs home`. The default runs both scenarios
sequentially. Keep the native bundler separate from full repository type/lint
checks on memory-constrained hosts.

Two build-only mutants must exit nonzero at their corresponding assertion:

```sh
LIBRARY_CHECK_MUTANT=activation-nonce node scripts/testing/library/run.mjs
LIBRARY_CHECK_MUTANT=retained-authorization node scripts/testing/library/run.mjs
```

They respectively substitute the current constructor nonce for the durable
activation proof and bypass immutable capture authorization. The bundler changes
one checked anchor in the owned module; installed packages and application
source remain unchanged. Each mutant has fresh isolated storage.
