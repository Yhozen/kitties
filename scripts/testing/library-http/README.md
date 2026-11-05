# Local Library HTTP boundary proof

Run with the repository's pinned Node 26 and installed dependency graph:

```sh
node scripts/testing/library-http/run.mjs
node scripts/testing/library-http/run.mjs signal
```

The full command uses production `library-http`, `library-session`,
`library-control` and recovery hooks, the actual Library model, and native
SQLite Durable Objects. WorkerBundle builds the owned fixture; the official
Runtime hosts it. Native commands use `LibraryApi.clientHttp` over the official
`NodeHttpClient.layerNodeHttp`. Raw strict-decoding probes and browser transport
probes use ordinary same-origin fetch and official NDJSON frames. No handlers
or upstream suites are copied.

Authentication is explicitly local: fixture-issued session keys select immutable
expiry values passed to `localLibraryAuthenticationLayer`. This proves neither
Cloudflare Access nor native plugin authentication. The fixture must never be
mounted by the application. It has deliberately local administrative routes.

`signal` runs only the small plain-JS control in `signal-worker.mjs`, with no
Domain, Effect HTTP server, or application model. After confirmed client
cancellation, it records an idle cancellation milestone window, releases exactly
one additional chunk through a fixture signal, and records the resulting
milestones. It deliberately fails if the idle disconnect was not signalled.
No heartbeat or replacement wire protocol is introduced.

Both commands retain strict prompt-abort gates. With the pinned workerd build,
an idle disconnect is currently detected only after output activity. The
control observed `{aborted:0,cancelled:0,written:0}` before release and
`{aborted:1,cancelled:1,written:1}` after release. Full runs must continue to
report FAIL while remote idle subscriptions survive cancellation. Absolute
session expiry and successful reconnect are separate assertions.

All runtime state, bundles, result JSON and host stderr go under
`.context/library-http-check/<unique-run>`. A host uses explicit `localState`,
disk storage inside that run, and loopback-only runtime egress. Its environment
is allowlisted; no provider or credential layer is constructed. No Alchemy CLI
or application state store is invoked. Deadlines bound process and request
waits; waits target explicit lifecycle milestones. Linux process groups contain
forced cleanup. macOS and Windows process cleanup are not proven by this test.

Alchemy and cloudflare-runtime are pinned to beta85. Bootstrap has one explicit
internal dependency, `dist/core/node/internal/Paths.mjs`, located through the
installed package and version guarded. The direct control socket uses public
Runtime Plugin APIs and the pinned runtime's `user-worker` service name. The
full application probe uses the normal Runtime entry; the direct socket isolates
development forwarding from the plain workerd control. Installed engine hashes
are compared before and after scoped shutdown, whose exit status is checked.

For a held local host, choose a fresh directory below
`.context/library-http-check/` and run `node scripts/testing/library-http/host.mjs
<absolute-directory>`. Its `ready` event publishes the normal local URL. The
fixture POST `/fixture` accepts `initialize`, `issue` (optional bounded `ttlMs`),
`stats`, `wait` (metric, target, bounded `waitMs`), and `freeze`. `issue` returns
the key and expiry. Library requests carry `x-local-session`, canonical epoch
header `x-kitties-library-epoch: 1`, and either the same-origin browser Origin or
a native bearer transport without browser metadata/cookies. An unknown key
cannot select a session. No fixture identity activates production local auth.

The official HTTP client prepends its base URL to an empty request path, adding
one trailing slash: `/v1/library/rpc` becomes `/v1/library/rpc/`. The production
application accepts exactly this alias without redirecting. Query, method,
upgrade and Origin checks apply to both paths. Callers should retain the entire
epoch-qualified command ID and unchanged encoded input across uncertain retry.
The fixture also verifies the server's retained receipt on a changed-input
duplicate; that test does not authorize clients to change pending intent.

Node's global fetch adds Fetch Metadata. It therefore cannot impersonate the
native bearer path by omitting Origin; production auth correctly refuses that
combination. The official node:http adapter sends no browser metadata. Native
plugin redirect refusal, disabled cookies, platform cancellation and actual
Access edge assertions remain separate release gates.
