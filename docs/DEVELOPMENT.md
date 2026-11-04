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
