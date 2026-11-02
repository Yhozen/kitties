# ChatGPT subscription integration

Approved implementation contract, 2026-11-02. This supersedes D13's Codex public-client,
localhost paste-back and `backend-api` design. The owner accepts a one-time Mac helper;
Cloudflare owns renewal and subsequent desktop, MCP and background execution. Limits pause
work for an explicit Continue or Cancel. They never select another billing provider.

## Admission and rollout

Keep `KITTIES_CHATGPT_ENABLED=false` until the owner's registration on **next** discovers its
account-specific catalog and completes a real streamed `POST /v1/responses`. OAuth success,
fixtures and API-key inference do not pass this gate. If admission fails, record its sanitized
HTTP status, provider code and request ID and explain the prerequisite; keep usage disabled.
Production uses a separate registration and must pass its own acceptance before enabling usage.

Implement in this order:

1. Commit this contract, typed account/link/error resources and acceptance plan.
2. Build `pnpm chatgpt:connect --stage next|prod`, encrypted HomeDO linking and renewal, and the
   catalog/minimal streamed admission probe. Pass live admission before the agent cutover.
3. Implement the ChatGPT Effect LanguageModel adapter at the pinned Effect versions. Use full
   history, encrypted reasoning, developer instructions and namespaced client function tools.
   A round commits only on `response.completed`; failed, incomplete and interrupted streams
   cannot dispatch tools. Use the same adapter for distillation and background execution.
4. Finish Settings, account model selection, active-plan labeling and typed resumable pauses.
   Preserve queue ownership and completed rounds/tool results through redeploy and continuation.
   Quota/authorization pauses bypass backup delegation and provider fallback.
5. Validate recovery, browser/CI checks, live desktop/MCP/refresh acceptance and non-model p95
   below one second on next; link production separately, enable only after acceptance, and
   publish credential-free evidence. Rollback disables usage and pauses affected work.

## Account and linking contracts

- `GET /v1/chatgpt/accounts`, `GET /v1/chatgpt/accounts/:id`,
  `DELETE /v1/chatgpt/accounts/:id` (disconnect),
  `GET /v1/chatgpt/accounts/:id/models`, and `POST /v1/chatgpt/accounts/:id/probe`.
- `POST /v1/chatgpt/link-attempts`, `GET /v1/chatgpt/link-attempts/:id`,
  `DELETE /v1/chatgpt/link-attempts/:id`. Supply `accountId` to reconnect a saved registration;
  request explicit renewed consent only when the owner chooses to enable plan usage.
- An authenticated owner starts a pending transaction. The server redirects to OpenAI through
  `GET /v1/chatgpt/link-attempts/:id/authorize`; the URL is never returned as JSON or logged.
- The Mac helper listens on `http://127.0.0.1:<available-port>/auth/callback` before opening
  Kitties. It relays the response by bounded POST to `/oauth/chatgpt/callback` on the existing
  stage OAuth ingress. The callback accepts only a valid, unexpired, single-use transaction
  and returns status/opaque account ID, never credentials. No callback URL copying.
- Pending state, nonce and verifier remain encrypted in HomeDO. A fresh registration starts
  with `dynamic_agent_client`, uses `agent_name_hint=Kitties`, retains the issued client ID and
  validates the signed ID token's issuer, audience, nonce, lifetime and subject. Reconnect
  reuses the registration and rejects identity or client mismatch before replacing credentials.
- Identity is `(issuer, issued client ID, verified subject)`. Email is a label, not a workspace
  identifier. A stable opaque host ID lives outside HomeDO's recovery boundary in RecoveryDO,
  with a separate value for each stage. Recovery preserves that ID and invalidates all links
  and credentials using the external recovery epoch.
- `chatgptAccountId` on provider configurations references one account credential record.
  Providers and kitties never own copies of a rotating refresh token. No migration of legacy
  credentials or callbacks; relink using the helper.
- Account states: connected, consent_required, reauthorize, disconnected. Linking states:
  pending, exchanging, connected, denied, cancelled, expired, failed. Sign-in identity without
  `chatgpt.tokens.use.direct` remains visible but cannot perform inference.

## Credential and error contracts

AES-GCM encrypts token sets, scope/expiry metadata, retained ID tokens and pending PKCE state
using the existing KEK and account-specific AAD. Tokens never enter browser storage, workflow
journals, logs or evidence. Refresh near expiry; replace access/refresh/ID token and expiry/scope
metadata atomically. Serialize refreshes per registration, persist an in-flight marker and fence
all writes by revision and recovery epoch. On an interrupted or ambiguous rotation, require
relinking. Preserve credentials on explicit temporary errors; clear confirmed unusable tokens.
Disconnect fences in-flight operations, attempts remote revocation and clears local tokens even
when revocation cannot be confirmed; report that outcome.

Provider errors carry a typed reason, sanitized provider code, optional HTTP status/request ID
and parameter. Reasons distinguish usage_limit, consent_required, account_ineligible,
authorization_expired, unsupported_request, provider_unavailable, incomplete and interrupted.
Never expose provider diagnostic text or raw bodies. `subscription_sharing_usage_limit_exceeded`
pauses new requests for that account without guessing a reset time. Manage usage opens
<https://chatgpt.com/settings/usage>. Preserve actual error body *shape* (structured/detail/other)
for diagnostics without retaining its potentially sensitive content.

The admission request uses `https://api.openai.com/v1/responses`, `store:false`, `stream:true`
and array input. Only `response.completed` passes. Models come from `models`, filter
`visibility=list`, preserve ordering, display `display_name`, submit the exact `slug`.

## Acceptance matrix

| Area | Required checks |
|---|---|
| Linking | Callback replay; state, nonce, signature, issuer, audience and expiry; cancellation and timeout; wrong account/client; absent subscription permission |
| Credentials | Concurrent refresh single-flight; disconnect/reconnect during refresh; temporary versus terminal failure; lost refresh response; restart with durable marker; PITR invalidation; no secrets in stored plaintext or returned errors |
| Inference | Text/images, namespaced tools, tool-result history, encrypted reasoning continuity; failed/incomplete/missing terminal events never dispatch calls; unsupported fields rejected |
| Durable work | Quota during streaming; redeploy and Continue resume the unfinished round; no repeated completed desktop/MCP action; queue ownership retained; Cancel works; no paid fallback/backup delegation |
| Live next | Owner consent, catalog, minimal Responses admission, streamed chat, tool round, screenshot then reasoning, MCP approval and refresh after expiry |
| Release | Repository checks, browser tests, CI, credential-free evidence, fresh latency measurement; isolated prod linking; flag remains false until gates pass |

## Official documentation checked 2026-11-02

- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)

The published VM guide describes protected credential transfer after local OAuth. Cloudflare
exchanging a loopback authorization relayed by the helper still requires live admission for this
private owner-controlled deployment. The docs do not establish eligibility for this deployment;
a hosted multiuser product needs a separate decision.
