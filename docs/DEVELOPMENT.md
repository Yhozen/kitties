# Development

Install Node 26+, pnpm 12.16.1 and Bun 1.4.4. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

`pnpm dev` runs Alchemy's local Worker on port 1337 with the configured owner identity and guest
ingress on 1338. Supply the required variables from [deployment](DEPLOY.md) through your shell;
keep credentials out of tracked files.

The workspace contains `apps/{gateway,web,desktop}`, `packages/{api,domain,protocol,device}` and
`guest/{desktop,kittyd}`. The guest build requires Bun and produces the Linux baseline binary.
`pnpm --filter @kitties/kittyd release` creates the content-addressed archive and release manifest.

The root Vite+ commands cover formatting, lint/type checks, Vitest and task builds.
The fresh behavior suite is described in [testing](TESTING.md). Run
`pnpm test:watch` while developing and `pnpm test:coverage` for coverage reports.
Historical validation evidence in `docs/effect/evidence/` is separate from this suite.
Keep the exact Effect/Alchemy versions and pnpm patches together; see
[patches/README.md](../patches/README.md).

## Lint rules and agent guidance

`pnpm check` uses the root Vite+ configuration, including the vendored anti-slop
generic rules and optional Effect rules at error severity. Read [AGENTS.md](../AGENTS.md)
for the workspace conventions and links to the installed Effect and Vite+ documentation.
The vendored revision, licenses and update notes are in
[anti-slop provenance](../tools/oxlint/anti-slop/UPSTREAM.md).

Use `pnpm exec vp lint --fix`, then `pnpm exec vp fmt` for spacing changes. Review
semantic findings individually; a formatter cannot establish runtime type safety.
When upgrading Vite+, keep `@oxlint/plugins` pinned to the version printed by
`pnpm exec vp lint --version`. Existing source exclusions remain in `vite.config.ts`;
the Effect service-import rule checks relative imports, not package or path aliases.

The pinned `@effect/tsgo` postinstall step adds Effect's typed correctness rules
to the Oxlint bundled with Vite+. API stability notices retain upstream warning
severity for deliberately pinned HTTP/workflow/AI/testing integrations; other
correctness diagnostics are errors. Vite+ upgrades must be supported by the
installed Effect integration; do not skip its postinstall when running checks.

## CAFE frontend

[CAFE](https://ratstack.sh/lore/cafe-stack) names Cloudflare, Alchemy, Foldkit and
Effect. Kitties already has the Cloudflare/Alchemy/Effect backend; the frontend
uses the published Foldkit packages within the same Vite+ workspace.

The frontend runs in desktop and mobile browser tabs and requires a network
connection. Build standard web pages and browser interactions. The retained
`apps/web/public/sw.js` URL only unregisters clients from earlier releases and
clears their shell cache; the application does not register it. Keep this
retirement endpoint available for returning clients.

| Part | Kitties location and responsibility |
| --- | --- |
| Cloudflare | `apps/gateway/src/worker.ts`, Durable Objects and storage run the backend and serve the built web assets. |
| Alchemy | `apps/gateway/alchemy.run.ts` declares the existing resources and bindings. |
| Foldkit | `apps/web` owns browser Models, Messages, views, Commands and Subscriptions. |
| Effect | Shared schemas in `packages/{api,domain,protocol}` define browser/server boundaries; services and Layers provide dependencies. |

Foldkit 0.170.0, its UI package and Vite plugin are installed. `/library.html`
boots the shared Foldkit library; `/` continues to boot the existing Preact shell.
The shell's Library navigation opens the shared route and retains file uploads.
Both browser entries use the same versioned language/theme preference service;
legacy keys are read-only defaults until an explicit save. Put native Foldkit modules
under `apps/web/src/foldkit/` during migration; the full upstream Foldkit lint
preset applies there. Shared tooling remains in the root Vite+ configuration.

Read [FOLDKIT.md](../FOLDKIT.md), the installed package declarations and the
release-pinned online references linked from the skills. Framework source,
example apps and upstream test suites are not vendored into this repository.
The eight skills in `.agents/skills/` include Foldkit architecture,
generation and auditing guidance plus Ratstack architecture, durability,
investigation, Alchemy and testing guides. See their
[provenance](../.agents/skills/UPSTREAM.md).

DevTools MCP is configured for Claude in `.mcp.json` and Codex in
`.codex/config.toml`, using the installed binary through pnpm. New agent sessions
load the project configuration. Start `pnpm --filter @kitties/web dev` and open
the app in a browser. A Foldkit runtime becomes inspectable when a migrated
page boots it; the current Preact runtime will not appear in Foldkit DevTools.
The plugin's default authenticated loopback discovery handles multiple dev
servers. Keep credentials out of Models and Message history.

The desktop host uses the same `apps/web/dist/library.html`, selected through
the official Tauri runtime API. Native preferences and HTTP/authentication use
device Layers; the leaf has no browser storage or native IPC imports. Build web
assets before `pnpm --filter @kitties/desktop package`. See the
[native host guide](../apps/desktop/src-tauri/README.md) for platform prerequisites
and [staging authentication gate](LIBRARY_STAGING_AUTH.md) for compiled origins.
No configuration means an unavailable Library connection with usable local
preferences. No deployment or production migration runs on application startup.
