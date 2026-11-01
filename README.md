# Kitties

Autonomous AI agents, each with its own personality, memory and Boat desktop.

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
provider keys and authorize connections in Settings, then create a kitty and chat. ChatGPT sign-in
is disabled unless explicitly enabled. Old Go state and checkpoints were not migrated.

The accepted performance limitation is **1.421 s p95 non-model overhead** (653 ms median,
50 real actions), above the original 1 s target. Provider latency is excluded. See the
[latency report](docs/effect/LATENCY-BASELINE.md) and [cost report](docs/effect/COST-REPORT.md).
A fresh desktop's first OS installation can take many minutes; subsequent upgrades reuse its
installed packages.

## Development

Use Node 26+, pnpm 12.16.1 and Bun 1.4.4. Chrome is needed for browser checks.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

See [development](docs/DEVELOPMENT.md), [deployment](docs/DEPLOY.md),
[recovery](docs/effect/RECOVERY.md) and the [phase evidence](docs/effect/README.md).
Effect and Alchemy are pinned and patched; upgrades must rerun the workflow acceptance suite.

## Credits

The guest desktop uses [Lumen](https://github.com/madkoding/lumen-wm), an Openbox fork,
Numix/Greybird themes, [Lucide](https://lucide.dev) icons, Sansation and JetBrains Mono Nerd Fonts.
The original wallpaper is by madkoding, generated with Qwen AI; guest assets and licences live
under `guest/desktop/`. Perception uses [agent-browser](https://github.com/vercel-labs/agent-browser)
and [agent-desktop](https://github.com/vercel-labs/agent-desktop).

[GPL-3.0-or-later](LICENSE) · © 2026 madkoding
