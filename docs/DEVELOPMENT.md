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

The workspace contains `apps/gateway`, `apps/web`, `packages/{api,domain,protocol}` and
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

## Foldkit preparation

Foldkit 0.170.0, its UI package and Vite plugin are installed. The application
continues to boot Preact until its UI migration. Put native Foldkit modules
under `apps/web/src/foldkit/` during migration; the full upstream Foldkit lint
preset applies there. Shared tooling remains in the root Vite+ configuration.

Read [FOLDKIT.md](../FOLDKIT.md) and the pinned source in `repos/foldkit/`.
The eight skills in `.agents/skills/` include official Foldkit architecture,
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
