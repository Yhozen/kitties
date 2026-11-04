# Configuration

The owner configures Kitties in the PWA. There is no local YAML gateway configuration.

- **Settings:** provider/model profiles, API keys and remote MCP connections. Supported providers
  are OpenAI, Anthropic, OpenRouter and OpenAI-compatible endpoints (including compatible Gemini).
- **Connections:** OAuth discovery, DCR/CIMD where supported, Google and Microsoft file/calendar
  tools. Real vendor accounts require the owner's app registration and authorization. See
  [server dispositions](effect/PARITY.md#deployed-dispositions-2026-11-01).
- **Kitties:** soul, provider, memory, budget and skills. Create a chat with one or several members.
- **Help and vault:** named encrypted credentials. `type_secret` supplies a reference without
  exposing the plaintext to the model or workflow journal.
- **Goals and approvals:** schedules, webhook triggers, rules and notifications. See [autonomy](AUTONOMY.md).
- **Health:** deployment version, parked workflows, exports and recovery.

ChatGPT account linking is deployed to `next` and uses the one-time Mac helper. Production
linking is a later, separate acceptance step:

```sh
pnpm chatgpt:connect --stage next
# Production is a separate registration: --stage prod
```

Run this in a checkout with Node 26+ and pnpm on the Mac where the browser opens. The helper
listens on `127.0.0.1`, opens Settings behind Cloudflare Access and relays the callback without
copying URLs or handling tokens. Choose **Continue with ChatGPT**, or choose a saved registration
to reconnect. Cloudflare stores the encrypted credentials and owns renewal. After linking, the
PWA automatically attempts account model discovery and one minimal streamed Responses request.
The helper exits after relaying the callback; read the actual admission result in Settings.

Manage access and limits at [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage).
Disconnect clears local tokens and attempts remote session revocation. If remote revocation is
not confirmed, also disconnect Kitties in ChatGPT Settings. Never share authorization URLs,
callback URLs or raw provider responses in support transcripts.

Linking and verification are available while inference is disabled. `KITTIES_CHATGPT_ENABLED`
defaults to false and must remain false until [the admission and agent acceptance gates](effect/CHATGPT.md)
pass. The legacy Codex-client callback and provider-owned tokens are not migrated; relink with
the helper. The subscription adapter, model selection and durable usage-limit pauses follow
successful live admission. API-key providers continue to use their existing configuration.
Infrastructure credentials and the encryption/release keys belong to Worker secrets; see
[deployment](DEPLOY.md). A restore fences old work and requires connection reauthorization.
