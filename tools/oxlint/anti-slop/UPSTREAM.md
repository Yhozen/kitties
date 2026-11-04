# anti-slop provenance

Source: https://github.com/dmmulroy/anti-slop

Revision: `13909c9e07590f5a85d93c62712259fe14a883f7`

Copied from `skills/install-anti-slop/assets/anti-slop/` at that revision with its
`scripts/install.mjs`. The generic entry point is `index.ts`; the optional Effect
entry point is `effect/index.ts`. Both are registered in the root `vite.config.ts`.

The plugin source is unmodified. The upstream MIT license is included as `LICENSE`.
The nested ESLint Stylistic license and provenance remain under `vendor/eslint-stylistic/`.
Upstream tests and the installer are not vendored into this repository.

Vite+ supplies Oxlint 1.89.0; `@oxlint/plugins` is pinned to the same version.
When upgrading Vite+, inspect `vp lint --version` and update this dependency with it.
Preserve local changes when updating this copy and record the new source revision.
