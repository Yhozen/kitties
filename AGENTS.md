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
`pnpm build` (recursive Vite+ task builds), and `pnpm --filter @kitties/kittyd check`
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

Automated tests and their setup were intentionally removed. Do not restore test
suites or test tooling unless explicitly requested; validate changes with the
applicable checks and builds above. Historical reports in `docs/effect/evidence/`
are records of earlier validation, not a runnable suite.
