# Repository guidance

## Vite+ monorepo

This is a pnpm workspace managed with Vite+. Keep shared formatting, linting,
type checking and task configuration in the root `vite.config.ts`. Applications
live in `apps/*`, shared packages in `packages/*`, and guest components in `guest/*`.
Use workspace dependencies for internal packages. Keep the pinned toolchain and
Effect/Alchemy patches together.

Read [Vite+ guidance](node_modules/vite-plus/AGENTS.md) and the installed docs in
`node_modules/vite-plus/docs/` before changing the toolchain. Use `vp run <name>`
for package scripts and configured tasks; `vp <name>` invokes a built-in command.
The repository commands are `pnpm check` (Vite+ formatting, lint and types),
`pnpm test` (Vitest through Vite+), `pnpm test:coverage`, `pnpm build`
(recursive Vite+ task builds), and `pnpm --filter @kitties/kittyd check`
for the guest's Bun types. Install dependencies with `pnpm install --frozen-lockfile`.

## Effect

Before writing or changing Effect code, read
[Effect's installed agent guide](node_modules/effect/AGENTS.md). Follow its linked
examples in `node_modules/effect/ai-docs/` and inspect the installed Effect source
for APIs compatible with the pinned version. Prefer this installed guidance to
examples for other Effect versions. Use Schema at untrusted boundaries, contextual
services and Layers for dependencies, and tagged errors and matching for control flow.

## Lint policy

The generic anti-slop rules and all optional Effect rules are enabled at error
severity in the root Vite+ configuration. The vendored implementation and source
revision are recorded in [UPSTREAM.md](tools/oxlint/anti-slop/UPSTREAM.md).
Fix the underlying issue; do not weaken rules, add broad ignores or introduce
unsafe casts to pass lint. A necessary assertion needs a specific `SAFETY:` comment
explaining the invariant that makes it sound. Effect's service-import rule checks
relative imports; package and path aliases are outside its analysis.

The full Foldkit lint preset applies to native Foldkit modules under
`apps/web/src/foldkit/`, including its upstream entrypoint, server and test
overrides. Keep new Foldkit code there during the Preact migration. Effect's
typed correctness rules run through the pinned `@effect/tsgo` Oxlint integration,
installed by `postinstall`. API stability notices remain warnings: this project
deliberately uses pinned Effect HTTP, workflow, AI and testing APIs. Other typed
correctness findings are errors. Existing anti-slop rules remain errors.

## Testing

Write fresh behavior tests; the old suite was removed because it was not a
useful migration baseline. Tests and test tooling are now explicitly wanted.
Read [testing guidance](docs/TESTING.md) and use the installed `test-behaviour`
skill. Keep all runner configuration in the root `vite.config.ts`.

Use `vite-plus/test` for ordinary tests and `@effect/vitest` for `it.effect`,
Layers and generated properties. Use unaliased `it` from `@effect/vitest` so
the lint rules recognize its test blocks. Use `TestClock` for Effect time,
and Foldkit Story/Scene Command resolution for UI time. Test services through
Layers and ports; do not mock modules, access live services, or sleep in tests.

Assert observable behavior with an independent expected result. Prefer named
examples for boundaries, properties for invariants, generated histories for
stateful protocols, and Scene tests for rendered Foldkit behavior. No focused,
skipped, assertion-free, or retry-until-green tests. Demonstrate that a new
regression test catches its bug, restoring any temporary mutation exactly.
Historical reports in `docs/effect/evidence/` are not the current suite.

## Foldkit and installed skills

CAFE means Cloudflare, Alchemy, Foldkit and Effect. The existing gateway and
Alchemy stack supply the backend; Foldkit is the frontend framework. Read
[FOLDKIT.md](FOLDKIT.md) for conventions and [development](docs/DEVELOPMENT.md)
for the package and runtime boundaries.

Consume Foldkit through its published npm packages. Read installed declarations
under `apps/web/node_modules/foldkit/` and `apps/web/node_modules/@foldkit/ui/`.
Use release-pinned online examples when needed. Do not commit framework source,
subtrees, example applications or upstream test suites. Any reference downloads
belong in gitignored `.context/` and are never application dependencies.

The app still boots Preact until its migration. Foldkit's Vite plugin, UI
package, lint rules, agent skills and DevTools MCP are configured now. For
Foldkit UI work use `foldkit`, `generate-program` and `audit-program`; their
references point to the matching upstream release online. Work in the existing
Vite+ workspace. Root instructions and the user's authorization take precedence
over upstream scaffolding commands and repeated approvals.

Ratstack's `uncomplect`, `durability`, `investigate-a-failure`, `learn-alchemy`
and `test-behaviour` skills supplement this setup. Ratstack-only packages,
paths and deployment commands are reference examples; use this repository's
Vite+ commands, contracts and infrastructure. Do not add XState or replace the
monorepo just because an upstream example uses them. See
[skill provenance](.agents/skills/UPSTREAM.md) for pins and local adaptations.
