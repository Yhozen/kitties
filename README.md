# Puppies

A customized, opinionated fork of [Kitties](https://github.com/madkoding/kitties): autonomous AI
agents, each with its own personality, memory and Boat desktop, shown as animated 3D puppies.

Puppies follows its own choices rather than tracking upstream. Internal names (the `kitties`
packages, `/v1/kitties` routes, `KittyDO`, `kittyd`, Cloudflare resources and the deployment
address) keep the upstream spelling so existing state and integrations keep working.

Open **[kitties.rccpr.tech](https://kitties.rccpr.tech)** and sign in through Cloudflare Access.
The installable PWA is the client on desktop and mobile. Production runs TypeScript and Effect
on Cloudflare Workers, SQLite Durable Objects and Alchemy Effect Workflows.

- Streamed chats, group conversations, persistent memory and reusable skills.
- Live desktop viewing and control over a persistent guest WebSocket; DOM and accessibility
  references with pixel fallback.
- Durable approvals, help requests, delegation, scheduled goals and signed webhooks.
- Effect AI providers, remote MCP with OAuth, and native Google/Microsoft file and calendar tools.
  Vendor authorizations require the owner's configuration; see [integration dispositions](docs/effect/PARITY.md#deployed-dispositions-2026-11-01).
- Encrypted credentials, point-in-time recovery and encrypted exports locked for 30 days.
- English, Spanish and Portuguese; at most five active Boat desktops.

Production switched to the Effect application on November 1, 2026. This is fresh state: enter
provider keys and authorize connections in Settings, then create a puppy and chat. The new ChatGPT
[Mac linking helper](docs/effect/CHATGPT.md) is on `next`; subscription inference stays disabled
until live acceptance passes. Old Go state and checkpoints were not migrated.

The accepted performance limitation is **1.421 s p95 non-model overhead** (653 ms median,
50 real actions), above the original 1 s target. Provider latency is excluded. See the
[latency report](docs/effect/LATENCY-BASELINE.md) and [cost report](docs/effect/COST-REPORT.md).
A fresh desktop's first OS installation can take many minutes; subsequent upgrades reuse its
installed packages.

## Development

Use Node 26+, pnpm 12.16.1 and Bun 1.4.4.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

See [development](docs/DEVELOPMENT.md), [deployment](docs/DEPLOY.md),
[recovery](docs/effect/RECOVERY.md) and the [phase evidence](docs/effect/README.md).
Effect and Alchemy are pinned and patched. Automated tests and their setup have been removed.
The phase evidence records historical validation.

## Credits

The guest desktop uses [Lumen](https://github.com/madkoding/lumen-wm), an Openbox fork,
Numix/Greybird themes, [Lucide](https://lucide.dev) icons, Sansation and JetBrains Mono Nerd Fonts.
The original wallpaper is by madkoding, generated with Qwen AI; guest assets and licences live
under `guest/desktop/`. Perception uses [agent-browser](https://github.com/vercel-labs/agent-browser)
and [agent-desktop](https://github.com/vercel-labs/agent-desktop).
The puppy avatars are drawn with [open-bot-avatar](https://github.com/DominikScholz/open-bot-avatar)
(MIT, vendored and extended in `apps/web/src/bot-avatar/`).

[GPL-3.0-or-later](LICENSE) · © 2026 madkoding
