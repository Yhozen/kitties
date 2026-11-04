# Releases

Kitties ships as Cloudflare application bundles, web assets and an immutable Boat guest archive.
The old binary/native release workflow is retired. Application version is visible on Health.

Run the checks and publish as described in [deployment](DEPLOY.md). Application CI cannot alter
R2 retention rules; infrastructure changes use the owner's Alchemy environment.

For a new guest release, run `pnpm --filter @kitties/kittyd release`, upload the resulting
`guest/kittyd/dist/kittyd.tgz` under the manifest's SHA-256 key in GuestAssets, and PUT the manifest
to `/v1/releases/kittyd` through an owner-authenticated session. The gateway authenticates guest downloads
with the release key. Upgrade existing desktops from the web app; bootstrap runs in a detached,
idempotent systemd service and reports readiness through the guest channel.

Changes to Effect or Alchemy pins/patches require the cloud workflow, replay and recovery suite.
See [patch notes](../patches/README.md) and [evidence](effect/evidence/README.md).
