# Kitties documentation

Production is the Cloudflare Effect application at [kitties.rccpr.tech](https://kitties.rccpr.tech).
The web client runs in desktop and mobile browsers, with Boat desktops. The Go, CLI, Wails, Android, Docker and Lima
implementations were retired after production smoke and recovery checks passed.

| Guide | Purpose |
|---|---|
| [First steps](INSTALL.md) | Sign in and create your first kitty |
| [Configuration](CONFIGURATION.md) | Providers, connections, vault and goals |
| [Desktop](DESKTOP.md) | Watch, control, sleep and restore a desktop |
| [Autonomy](AUTONOMY.md) | Approvals, help, goals, webhooks and delegation |
| [Architecture](ARCHITECTURE.md) | Actors, workflows and the guest channel |
| [API](API.md) | Authenticated API and protocol sources |
| [Development](DEVELOPMENT.md) | Install, check, test and build |
| [Deployment](DEPLOY.md) | Infrastructure, application publishing and rollback |
| [Recovery](effect/RECOVERY.md) | PITR, retained exports and Mac key escrow |
| [Effect plan and evidence](effect/README.md) | Ten phases, accepted limits and measured acceptance |

`effect/CURRENT-SYSTEM.md` and the backing research preserve the pre-rewrite design with pinned
source links. Older screenshots are historical examples, not a current screen catalogue.
