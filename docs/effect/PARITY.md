# Feature and API parity

Inventory of the Go baseline at `7f408a1`, audited 2026-11-01. Kept means product behavior;
changed permits a new wire contract. Fresh state means no old endpoint compatibility layer.
Owner confirmation refers to D1–D16 in [DECISIONS.md](DECISIONS.md), not to runtime acceptance.

## Screens and capabilities

| Feature or screen | Disposition | Phase | Owner confirmed |
|---|---|---|---|
| Live desktop, control, clipboard, DesktopCare | changed | 4 | D4, D15 |
| Chats, groups, @name routing, cancel | kept | 5 | D8 |
| Kitty editor, soul, PixelCat avatars, Welcome | kept | 5 | D8 |
| Settings, OpenAI/Anthropic/OpenRouter/compat/Gemini | changed | 5 | D6 |
| ChatGPT subscription via Mac linking helper; inference behind admission gate | changed | 5 | D13; [contract](CHATGPT.md) |
| Copilot/Claude Code/gcloud/Qwen/local Ollama sign-in | dropped | — | D13 |
| Feedback, demand, memory notes/profile/distill | kept | 5 | D8 |
| Library skills/proposals and artifacts | kept | 5 | D8 |
| Spanish and Portuguese UI | kept | 5 | D2 |
| Sleep, resume, recovery points, capacity | changed | 6 | D4 |
| Desktop task, ask_help, Help, vault, type_secret | changed | 7 | D8 |
| GIF replay becomes client slideshow | changed | 7 | D8 |
| Goals, run-now, journal, limits, backup kitty, delegation | changed | 8 | D8 |
| Approval decisions, rules, reminders, trust, expiry | changed | 8 | D8 |
| Notification delivery and digest | backend contracts retained; browser controls retired on 2026-11-04 | 8 | D2 |
| Signed webhook delivery and deduplication | changed | 8 | D8 |
| GitHub, Stripe, Notion, Linear, Atlassian, Slack, Home Assistant via MCP | changed | 5/9 | D6 |
| Google Workspace and Microsoft 365 minimal native tools | changed | 9 | D6 |
| CalDAV/CardDAV | probe required | 9 | D6; Workers PROPFIND gate |
| Generic HTTP, ntfy, webhook presets | changed | 5 | D14 |
| Email/SMTP and long-tail connector catalog | dropped | — | D14 |
| Shell, Apple/Things/OmniFocus, Motita | dropped | — | D1, D14 |
| Backups and Recoveries become PITR/export status | changed | 10 | D5 |
| Updates becomes Health version line | changed | 10 | D1 |
| CLI, self-update, demo, Wails, Android, Docker, Lima | dropped | — | D1, D2 |
| Old state and Boat checkpoint adoption | dropped | — | D5, D16 |

## Registered Go endpoints

Extracted from `internal/gateway/*.go`, excluding tests. New routes may replace these, but each
kept behavior must have an implementation and acceptance evidence before cutover.

| Existing endpoint | Disposition | Phase | Baseline source | Owner confirmed |
|---|---|---|---|---|
| `POST /v1/settings/accounts/{kind}/login` | changed | 5 | [internal/gateway/accounts.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/accounts.go) | D8 |
| `DELETE /v1/settings/accounts/{kind}` | changed | 5 | [internal/gateway/accounts.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/accounts.go) | D8 |
| `GET /v1/settings/logins/{id}` | changed | 5 | [internal/gateway/accounts.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/accounts.go) | D8 |
| `POST /v1/settings/logins/{id}/paste` | changed | 5 | [internal/gateway/accounts.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/accounts.go) | D8 |
| `DELETE /v1/settings/logins/{id}` | changed | 5 | [internal/gateway/accounts.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/accounts.go) | D8 |
| `GET /v1/goals` | changed | 8 | [internal/gateway/agenda.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/agenda.go) | D8 |
| `POST /v1/goals` | changed | 8 | [internal/gateway/agenda.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/agenda.go) | D8 |
| `GET /v1/goals/{id}` | changed | 8 | [internal/gateway/agenda.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/agenda.go) | D8 |
| `PUT /v1/goals/{id}` | changed | 8 | [internal/gateway/agenda.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/agenda.go) | D8 |
| `DELETE /v1/goals/{id}` | changed | 8 | [internal/gateway/agenda.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/agenda.go) | D8 |
| `POST /v1/goals/{id}/run` | changed | 8 | [internal/gateway/agenda.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/agenda.go) | D8 |
| `GET /v1/kitties/{ref}/journal` | changed | 8 | [internal/gateway/agenda.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/agenda.go) | D8 |
| `POST /v1/hooks/{connector}` | changed | 8 | [internal/gateway/agenda.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/agenda.go) | D8 |
| `GET /v1/approvals` | changed | 8 | [internal/gateway/approvals.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/approvals.go) | D8 |
| `GET /v1/approvals/rules` | changed | 8 | [internal/gateway/approvals.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/approvals.go) | D8 |
| `POST /v1/approvals/rules` | changed | 8 | [internal/gateway/approvals.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/approvals.go) | D8 |
| `DELETE /v1/approvals/rules/{id}` | changed | 8 | [internal/gateway/approvals.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/approvals.go) | D8 |
| `POST /v1/approvals/{id}/approve` | changed | 8 | [internal/gateway/approvals.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/approvals.go) | D8 |
| `POST /v1/approvals/{id}/reject` | changed | 8 | [internal/gateway/approvals.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/approvals.go) | D8 |
| `GET /v1/backups/status` | changed | 10 | [internal/gateway/backups.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/backups.go) | D5 |
| `POST /v1/backups` | changed | 10 | [internal/gateway/backups.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/backups.go) | D5 |
| `GET /v1/kitties/{ref}/desktop` | changed | 4 | [internal/gateway/desktop.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/desktop.go) | D8 |
| `POST /v1/kitties/{ref}/backup` | changed | 6 | [internal/gateway/desktop.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/desktop.go) | D8 |
| `POST /v1/kitties/{ref}/update` | changed | 5 | [internal/gateway/desktop.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/desktop.go) | D8 |
| `GET /` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `GET /v1/health` | changed | 3 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `GET /v1/session` | changed | 3 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `POST /v1/login` | dropped | — | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D1, D2 |
| `POST /v1/logout` | dropped | — | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D1, D2 |
| `GET /v1/providers` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `GET /v1/connectors` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `GET /v1/kitties` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `POST /v1/kitties` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `GET /v1/kitties/{ref}` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `DELETE /v1/kitties/{ref}` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `PATCH /v1/kitties/{ref}` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `GET /v1/avatars` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `POST /v1/kitties/{ref}/start` | changed | 4 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `POST /v1/kitties/{ref}/stop` | changed | 6 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `POST /v1/kitties/{ref}/exec` | dropped | — | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D1, D2 |
| `GET /v1/kitties/{ref}/screenshot` | changed | 4 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `POST /v1/kitties/{ref}/control` | changed | 4 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `POST /v1/kitties/{ref}/input` | changed | 4 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `POST /v1/scale/{name}` | dropped | — | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D1, D2 |
| `GET /v1/chats` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `POST /v1/chats` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `GET /v1/chats/{id}` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `DELETE /v1/chats/{id}` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `POST /v1/chats/{id}/members` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `DELETE /v1/chats/{id}/members/{ref}` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `POST /v1/chats/{id}/messages` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `POST /v1/chats/{id}/cancel` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `GET /v1/chats/{id}/shots/{name}` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `GET /v1/chats/{id}/turns/{turn}/replay.gif` | changed | 7 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `POST /v1/chats/{id}/turns/{turn}/help` | changed | 7 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `GET /v1/settings` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `PUT /v1/settings/providers/{name}` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `DELETE /v1/settings/providers/{name}` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `POST /v1/settings/providers/{name}/test` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `POST /v1/settings/provider-models` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `PUT /v1/settings/default-provider` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `PUT /v1/settings/connectors/{name}` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `DELETE /v1/settings/connectors/{name}` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `POST /v1/settings/connectors/{name}/test` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `GET /v1/local-token` | dropped | — | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D1, D2 |
| `GET /v1/chats/{id}/events` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `POST /v1/oauth/{name}/start` | changed | 9 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `GET /v1/oauth/callback` | changed | 9 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `GET /v1/skills` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `GET /v1/skills/{name}` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `PUT /v1/skills/{name}` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `DELETE /v1/skills/{name}` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `POST /v1/skills/{name}/accept` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `GET /v1/artifacts` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `GET /v1/artifacts/{name}` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `PUT /v1/artifacts/{name}` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `DELETE /v1/artifacts/{name}` | changed | 5 | [internal/gateway/gateway.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/gateway.go) | D8 |
| `POST /v1/kitties/{ref}/sleep` | changed | 6 | [internal/gateway/lifecycle.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/lifecycle.go) | D8 |
| `GET /v1/recoveries` | changed | 6 | [internal/gateway/lifecycle.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/lifecycle.go) | D8 |
| `POST /v1/recoveries/{ref}/purge` | changed | 6 | [internal/gateway/lifecycle.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/lifecycle.go) | D8 |
| `GET /v1/kitties/{ref}/stream` | changed | 4 | [internal/gateway/live.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/live.go) | D8 |
| `GET /v1/kitties/{ref}/rects` | changed | 4 | [internal/gateway/live.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/live.go) | D8 |
| `GET /v1/kitties/{ref}/clipboard` | changed | 4 | [internal/gateway/live.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/live.go) | D8 |
| `PUT /v1/kitties/{ref}/clipboard` | changed | 4 | [internal/gateway/live.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/live.go) | D8 |
| `GET /v1/kitties/{ref}/memory` | changed | 5 | [internal/gateway/memory.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/memory.go) | D8 |
| `POST /v1/kitties/{ref}/memory` | changed | 5 | [internal/gateway/memory.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/memory.go) | D8 |
| `DELETE /v1/kitties/{ref}/memory/{id}` | changed | 5 | [internal/gateway/memory.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/memory.go) | D8 |
| `PUT /v1/kitties/{ref}/memory/profile` | changed | 5 | [internal/gateway/memory.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/memory.go) | D8 |
| `POST /v1/kitties/{ref}/memory/distill` | changed | 5 | [internal/gateway/memory.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/memory.go) | D8 |
| `POST /v1/chats/{id}/turns/{index}/feedback` | changed | 5 | [internal/gateway/memory.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/memory.go) | D8 |
| `PUT /v1/settings/notify` | changed | 8 | [internal/gateway/memory.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/memory.go) | D8 |
| `POST /v1/settings/notify/test` | changed | 8 | [internal/gateway/memory.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/memory.go) | D8 |
| `POST /v1/settings/notify/digest` | changed | 8 | [internal/gateway/memory.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/memory.go) | D8 |
| `POST /v1/operator/recovery/prepare` | changed | 10 | [internal/gateway/recovery_operator.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/recovery_operator.go) | D5 |
| `POST /v1/operator/recovery/release` | changed | 10 | [internal/gateway/recovery_operator.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/recovery_operator.go) | D5 |
| `GET /v1/update` | dropped | — | [internal/gateway/update.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/update.go) | D1, D2 |
| `POST /v1/update/apply` | dropped | — | [internal/gateway/update.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/update.go) | D1, D2 |
| `GET /v1/vault` | changed | 7 | [internal/gateway/vault.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/vault.go) | D8 |
| `PUT /v1/vault/{name}` | changed | 7 | [internal/gateway/vault.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/vault.go) | D8 |
| `DELETE /v1/vault/{name}` | changed | 7 | [internal/gateway/vault.go](https://github.com/Yhozen/kitties/blob/7f408a17a33e87c29701dc0ec0ca89df3b75947a/internal/gateway/vault.go) | D8 |

## MCP acceptance

All seven servers require a deployed initialize/listTools probe. A server that needs an owner
OAuth app or token remains pending rather than being reported as supported. Record negotiated
protocol, transport, authentication, tool risk and any vendor restriction in RESEARCH.md.

### Deployed dispositions (2026-11-01)

[Cloud probes](evidence/mcp-cloud.json) exercised the deployed Effect MCP client. The authenticated
fixture negotiated protocol `2025-11-25`, discovered tools, enforced an approval and made one
external call across duplicate messages and decisions. [OAuth acceptance](evidence/oauth-cloud.json)
verified PKCE, single-use callbacks, CIMD, bypass isolation and one refresh for 20 concurrent calls.

| Server | Transport / authentication | Disposition |
|---|---|---|
| GitHub | Streamable HTTP; owner OAuth or scoped token | Anonymous probe did not establish a session. Configure owner authorization; authenticated vendor tools remain unverified. |
| Stripe | Streamable HTTP; owner OAuth | Owner authorization required before use; payment actions always require approval. Authenticated vendor tools remain unverified. |
| Notion | Streamable HTTP; owner OAuth | Configure an owner app/session; authenticated vendor tools remain unverified. |
| Linear | Streamable HTTP; owner OAuth | Configure an owner app/session; authenticated vendor tools remain unverified. |
| Atlassian | Streamable HTTP; owner OAuth | Configure an owner app/session; authenticated vendor tools remain unverified. |
| Slack | Streamable HTTP; owner OAuth | Configure an owner app/session and workspace scopes; authenticated vendor tools remain unverified. |
| Home Assistant | Owner-selected HTTPS endpoint and token | No owner instance was supplied. Generic MCP configuration is available; no live instance is claimed. |
| Google Workspace / Microsoft 365 | Native file/calendar tools; owner OAuth or token | Minimal tool implementations and fixtures exist. Real owner-account calls remain unverified until configured. |
| CalDAV / CardDAV | PROPFIND from Workers | Deferred: no owner endpoint supplied or deployed PROPFIND acceptance evidence. |

MCP metadata does not grant permission. Read access names must be explicitly selected; all other
tools go through the approval ledger. ChatGPT inference remains disabled by default and requires
an owner login before real inference can be verified.
