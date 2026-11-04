# API

The owner API is served under `/v1` on [kitties.rccpr.tech](https://kitties.rccpr.tech).
Requests require the configured owner's Cloudflare Access identity. Writes also require an Origin
matching the production URL. Credentials stay in the browser; do not put them in command history.

The schema-derived client is in [packages/api](../packages/api/). Additional routes are in
[gateway application](../apps/gateway/src/application.ts), with separate autonomy, OAuth,
workspace, notification and recovery handlers. [Domain schemas](../packages/domain/) define inputs
and stable error codes. Unknown routes return a typed `NOT_FOUND` response.

| Route | Purpose |
|---|---|
| `GET /v1/health`, `GET /v1/session` | Version, stage and authenticated identity |
| `/v1/kitties`, `/v1/chats` | Kitty/chat CRUD, messages, events and replay |
| `/v1/kitties/{id}/computer` | Boat state; POST start/sleep/restore/upgrade with operationId |
| `/v1/kitties/{id}/desktop` | Fenced live/control WebSockets |
| `/v1/providers`, `/v1/connections`, `/v1/vault` | Encrypted configuration |
| `/v1/approvals`, `/v1/help`, `/v1/goals` | Durable decisions, help and autonomy |
| `/v1/recovery` | Registry, export/restore operations and status |

Message POSTs carry a stable `messageId` and return 202; repeats return `{duplicate:true}`.
Lifecycle and restore requests also use stable operation IDs. SSE supports event cursors for
reconnection. Guest and signed webhook protocols use separate public ingress hosts, authenticated
by scoped guest credentials or delivery signatures. Production does not expose test impersonation.
