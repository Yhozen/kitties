# Development

Install Node 26+, pnpm 12.16.1, Bun 1.4.4 and Google Chrome. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

`pnpm dev` runs Alchemy's local Worker on port 1337 with the configured owner identity and guest
ingress on 1338. Supply the required variables from [deployment](DEPLOY.md) through your shell;
keep credentials out of tracked files. Local browser tests use a scripted model.

With the local server running, run `pnpm --filter @kitties/web e2e`. The current suite is under
`apps/web/e2e-next/` and checks desktop/mobile PWA behavior, languages, approvals, vault and chats.
Set `CHROME_BIN` if Chrome is elsewhere. Tests create local sample records.

The workspace contains `apps/gateway`, `apps/web`, `packages/{api,domain,protocol,testing}` and
`guest/{desktop,kittyd}`. The guest build requires Bun and produces the Linux baseline binary.
`pnpm --filter @kitties/kittyd release` creates the content-addressed archive and release manifest.

The root Vite+ commands cover formatting, lint/type checks, tests and task builds. There is no
coverage threshold. Keep the exact Effect/Alchemy versions and pnpm patches together. A version
change requires the 3/50/200/500-activity engine suite and recovery/replay tests in
[patches/README.md](../patches/README.md). Cloud evidence is in `docs/effect/evidence/`.
