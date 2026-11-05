# Testing

The suite starts from current behavior. Historical tests were removed rather
than ported. Use Vite+'s bundled Vitest; all runner and lint configuration lives
in root `vite.config.ts`.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm test --project protocol --project web
pnpm test:watch
pnpm test:coverage
pnpm test:workflows # Linux: real local workerd and persistent SQLite
pnpm build
pnpm --filter @kitties/kittyd check
```

Node 26, pnpm 12.16.1, Vite+ 1.4.0 and Vitest 5.0.5 are pinned together.
`@effect/vitest` matches Effect 4.1.1. Coverage uses the matching V8 provider.
Do not add an independent Vitest runner or a separate Vitest configuration.

## What to test

| Behavior | Approach |
| --- | --- |
| A concrete boundary or regression | A small example with a literal, independently specified outcome |
| An invariant across many inputs | `it.prop` or `it.effect.prop` with Effect Schema/Arbitrary |
| A sequence of state changes | Exercise the real sequence; use a small independent model when generated histories add value |
| Effect services | `it.effect` and Layers, supplying controlled implementations of external ports |
| Foldkit update decisions | Story: assert on Messages, Model transitions and emitted Commands |
| Foldkit user interactions | Scene: exercise the view and assert accessible roles, text and behavior |
| Real browser/Worker integration | A separate, explicitly configured environment when the behavior requires that runtime |

The node projects do not claim to exercise Cloudflare Durable Object persistence,
real providers, browser rendering, or the Bun guest runtime. Add integration
coverage at those boundaries as features require it; do not fake a whole Worker
and call it an integration test.

`pnpm test:workflows` is the separate Linux runtime check for the pinned Alchemy
workflow patch. Its owned fixtures bundle with the official Worker builder and
run in native workerd against isolated persistent storage. They exercise typed
activity failure handling, callback progress and parking, durable clocks,
immutable bounded exports, process termination/restart and purge deduplication.
The controller awaits observable persisted milestones with deadlines; it does
not retry assertions. It terminates only its own workerd child through Linux
`/proc` process discovery. No credentials or remote deployment state are loaded;
the fixture's outbound network is limited to loopback.

Each run writes its result and diagnostic logs under gitignored
`.context/workflow-check/`. This proves local storage and scheduling behavior,
not cloud placement, PITR, or a deployed application. The bootstrap has one
version-pinned dependency on the runtime's internal `Paths` module; revalidate
that boundary when upgrading Alchemy. See [patch notes](../patches/README.md)
and [upgrade guidance](ALCHEMY_UPGRADE.md).

Ordinary tests import `describe`, `test` and `expect` from `vite-plus/test`.
Effect/property tests use unaliased `it` from `@effect/vitest`; the lint rules
recognize `it.effect`, `it.effect.prop`, `it.prop` and `it.live`. Read the
installed Effect testing examples before adding Layers or clock-driven tests.

Use `TestClock` for Effect time. Foldkit Scene/Story tests resolve Commands and
emit subscription events directly. Avoid wall-clock sleeps, real network
requests, module mocks, and retries. Model provider failures through services
and typed values. Keep generated failures' seed and shrink/replay information.

## Tests must detect broken behavior

Write the behavior the test protects before writing the assertion. Expected
results must not be computed by the production function under test. Avoid broad
snapshots, assertions on incidental implementation details, duplicate cases,
and fixtures copied from implementation output.

For a new regression or important invariant, deliberately break that behavior
and verify the test fails for the intended reason. Use an isolated checkout or
a coordinated temporary edit with guaranteed byte-for-byte restoration. Never
change expected output merely to match a failure. Record the command and
observed failure in the PR; dedicated mutation tooling is not required.

The starting suite protects:

- Video congestion invalidating a delta chain, keyframe recovery, frame/byte
  credits, cumulative acknowledgements and malformed headers.
- Chat retry ordering, stale stream fragments and terminal message states.

Three temporary mutants were rejected when introducing this suite: continuing
the delta chain after congestion, accepting an old chat attempt, and overwriting a
replayed chat message's original question in place. The last mutation exposed
an aliased test expectation during review; fresh fixtures and independent
expected values now catch it.

## Checks and reports

Focused tests fail at runtime; disabled/focused tests, invalid assertions and
assertion-free bodies are lint errors. Runtime assertion counting is also
required. Tests have no automatic retries. Test files are included in lint and
formatting, including tests next to the legacy web source.

Coverage reports include untested application and shared-package files, so the
small initial suite does not imply full application coverage. The two fully
exercised protocol/client modules have per-file coverage floors. Overall
coverage remains a report, not an artificial project-wide target. Raise floors
as meaningful coverage grows rather than adding tests to satisfy a percentage.

CI runs checks, coverage/tests, local workflow recovery, builds and guest type
checks. It uploads HTML, LCOV, JSON summary, JUnit and workflow runtime reports
for 14 days, including failed test runs.
Local reports live in gitignored `coverage/` and `test-results/` directories.

Foldkit's upstream tests are not copied into this repository. New tests belong
beside owned source under `apps/*/src` or
`packages/*/src`. Bun-only guest tests need an appropriate runtime project
before adding them; its current gate is build plus its dedicated type check.
