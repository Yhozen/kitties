# Local workflow regression check

Run `pnpm test:workflows` using the repository's pinned Node toolchain on Linux.
The uncached root task launches application-owned fixtures in native workerd. It
requires installed dependencies only; it never calls the application Alchemy
stack, deployment planner, Cloudflare APIs, or a provider. The fixtures and
controller contain no upstream test suite or downloaded reference dependency.

Each invocation creates `.context/workflow-check/<unique-run>/`. `results.json`
records assertions, bundle hashes, installed engine hashes and runtime lifecycle
milestones. Host stderr is saved as `host-<pid>.stderr.log`. Bundles and SQLite
files stay local in that directory and are not needed as CI artifacts.

## Runtime boundary

`host.mjs` builds the owned `worker.ts` with official `WorkerBundle`, wraps it
with public Worker/DurableObject bridges, and serves it through official
`Runtime.start`. It supplies `localState()` with an absolute isolated
`AlchemyContext.dotAlchemy`; no remote state store is constructed or upgraded.
The runtime uses local binding Layers and disk storage. `layerRuntime` is
intentionally not used because it includes `RemoteBindings` and credential
requirements. No containers or remote binding hooks are configured.

The controller passes an environment allowlist to the host and workerd, without
Cloudflare credentials. Workerd outbound networking permits loopback only.
Every controller HTTP request is checked against the loopback runtime address.
The fixture HTTP operations are local test controls, not a production recovery
router or an owner-authorization implementation.

Alchemy and cloudflare-runtime are pinned to `2.0.0-beta.85`; Effect is `4.1.1`.
Runtime APIs use public package subpath imports. One necessary exception is
`dist/core/node/internal/Paths.mjs`: beta85's public `RuntimeLive`, registry and
binding Layers require its service, but beta85 does not export a public Paths
subpath. The host discovers that file from the installed package, checks the
exact package versions, and types its Layer through the public registry's
requirements. Re-audit this bootstrap and remove the exception when upstream
provides a public local-only construction.

## Assertions

The owned workflow runs with `SuspendOnFailure` enabled. Its typed activity
failure must reach its handler exactly once. Ten native durable timers must
finish without repeating their journaled effects. A separate owned callback
fixture passes eleven invocations with a two-attempt budget by committing
progress, then parks work that makes no progress. Parking accounting survives
native workerd death and an external schedule explicitly resumes the job.

The controller kills only the verified native workerd child, waits for the
runtime's replacement milestone, and resumes a suspended workflow. A 70,000
character activity result reconstructs from three export parts, each at most
32,768 characters. Captures include the expected workflow and alarm tables;
an old capture stays byte-identical after completion. Started/completed
metadata survive purge and a full host restart. A duplicate execution after
purge returns its original result and does not repeat recorded effects.

Waiters observe persisted ledger milestones; they have a 12-second scoped
server deadline and clean up on completion or timeout. Terminal result requests
have an 8-second Effect deadline. HTTP, startup, restart and shutdown waits also
have fixed deadlines. There are no assertion retry loops or harness sleeps;
the short durable timers and callback recovery delay are the behavior under
test. The official workflow client may poll its terminal result internally.

Successful shutdown must finish with exit code zero and exactly one
`engine-files-unchanged: true` milestone. The host retains a normal signal
listener until its scoped fiber finishes: Rolldown's bundled `signal-exit`
otherwise sees a consumed `once` listener as permission to re-send SIGTERM
before finalizers finish. A failing finalizer cannot be converted to success.
If graceful shutdown times out or fails, the controller kills the fixture's
dedicated Linux process group, waits for its pipes to close, and reports failure.
This group contains only that run's host and inherited native workerd process.

## Mutation proof

This intentional build transform restores the old activity annotation bug in
exactly one installed engine module as it is bundled:

```sh
WORKFLOW_CHECK_MUTANT=activity-suspend node scripts/testing/workflows/run.mjs failure
```

It must exit nonzero: the failing activity runs once, its handler is absent,
and the terminal assertion fails. The transform never writes installed source,
emitted JavaScript, maps or declarations. Their SHA-256 identities are recorded
at startup and checked again during scoped shutdown. Run `pnpm test:workflows`
without that environment variable to rebuild and prove the restored behavior.
An engine-source change that removes the exact mutation anchor fails explicitly
and requires review.

## Limits

The crash check currently uses Linux `/proc` to verify the workerd child. The
command refuses unsupported host platforms, so this is not a macOS or Windows
packaging check. Local SQLite/workerd persistence is not proof of Cloudflare
PITR, placement/jurisdiction, remote state migration, or deployed owner Access.
Those require their separate authorized staging gates. This harness does not
claim arbitrary crash-point coverage or exactly-once external provider writes.
