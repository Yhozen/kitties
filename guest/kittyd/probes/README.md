# Guest channel probes

Run from the repository root with Bun. Start local workerd with `pnpm dev`.

- `bun guest/kittyd/probes/channel-local.ts`: configures an isolated fake guest, sends 200 owner inputs, checks release and ingress isolation, and writes `docs/effect/evidence/channel-local.json`.
- `bun guest/kittyd/probes/channel-cloud.ts`: requires a configured real guest on `next` and the temporary acceptance Worker. Set `KITTIES_TEST_TOKEN_FILE` to its private credential file. If the sandbox resolver still caches the hostname's pre-deploy NXDOMAIN, set `KITTIES_TEST_IP` to a current Cloudflare anycast address; TLS verification and SNI remain enabled. Writes `channel-boat.json`.

The US-workspace and EU-guest measurements must stay separately labeled. These fixtures use a real persistent channel, not Boat `/commands` per input. Their temporary acceptance Worker is excluded from production and removed after acceptance.
