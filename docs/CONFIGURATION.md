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

ChatGPT sign-in is behind the `KITTIES_CHATGPT_ENABLED` deployment flag and defaults to false.
Infrastructure credentials and the encryption/release keys belong to Worker secrets; see
[deployment](DEPLOY.md). A restore fences old work and requires connection reauthorization.
