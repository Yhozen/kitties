# Development

Install Node 26+, pnpm 12.16.1 and Bun 1.4.4. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

`pnpm dev` runs Alchemy's local Worker on port 1337 with the configured owner identity and guest
ingress on 1338. Supply the required variables from [deployment](DEPLOY.md) through your shell;
keep credentials out of tracked files.

The workspace contains `apps/gateway`, `apps/web`, `packages/{api,domain,protocol}` and
`guest/{desktop,kittyd}`. The guest build requires Bun and produces the Linux baseline binary.
`pnpm --filter @kitties/kittyd release` creates the content-addressed archive and release manifest.

The root Vite+ commands cover formatting, lint/type checks and task builds. Automated tests,
fixtures, probes and their setup have been removed. Historical validation evidence remains in
`docs/effect/evidence/`; it does not represent a currently runnable suite.
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
