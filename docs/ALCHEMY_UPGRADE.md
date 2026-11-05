# Alchemy beta.85 upgrade

This upgrade enables the published `@alchemy.run/domain` integration while
preserving Effect 4.1.1, Foldkit 0.170.0 and the Vite+ workspace. It does not
deploy a Domain model or migrate the existing skill library.

## Dependency and runtime boundaries

Pin `alchemy`, `@alchemy.run/cloudflare` and `@alchemy.run/domain` together at
`2.0.0-beta.85`. Domain's Alchemy peer is exact. Keep the single Effect 4.1.1
override and existing platform package pins. The Domain guide is installed at
`packages/domain/node_modules/@alchemy.run/domain/skills/alchemy-domain/SKILL.md`;
no separate skill distribution tool is required.

Beta.85 replaces `Cloudflare.Workflows.DurableObjectEngine` with the memoized
`Cloudflare.Workflows.layerDurableObjectEngine()` factory. The gateway uses the
factory without a jurisdiction option. Adding a jurisdiction would change
Durable Object identity, not relocate existing executions. The Domain host uses
the same factory, so later composition must share this engine instead of creating
another recovery authority.

The old core Alchemy patch addresses removed Effect crypto imports. Beta.85
already uses `effect/crypto/Digest`, `effect/crypto/SecureRandom` and their
platform Layers in the affected OAuth/Stack paths. The Cloudflare patch has a
different purpose: it preserves application workflow recovery contracts and
must be ported and verified before the upgrade is deployable. See
[patch documentation](../patches/README.md).

## Deployment state is a separate migration

The Cloudflare deployment-state contract changes from version 7 to version 8.
Initializing the remote state provider can bootstrap or upgrade its Worker,
including during a command that appears to be a plan. Treat that initialization
as a remote mutation. Local implementation and tests use isolated local state;
they must not initialize the application's production `Cloudflare.state()`.

Before an authorized remote upgrade:

1. Record the intended account, profile, state-store Worker and `Store` Durable
   Object identity. Use the existing secure inventory/export process; never
   print or commit encryption keys, auth tokens or profile contents.
2. Preserve `KittiesNext`, stage names, existing resources and secret bindings.
   All deployers must use the same reviewed beta.85 pins and patches.
3. Review the state-store bootstrap changes and retain its secure backup. The
   new bootstrap imports legacy account-aware cache information and preserves
   existing secrets; that is not permission to rotate or reconstruct them.
4. Inspect the application resource plan after the state-store upgrade is
   authorized and prepared. Unexpected deletion, replacement, jurisdiction or
   Durable Object class changes must be resolved before deployment.
5. Validate an isolated staging deployment and the application's workflow
   recovery behavior before a production application rollout.

Version 8 refuses the legacy `CloudflareStateStore` bootstrap-stack operations
used by older clients to prevent accidental secret replacement. It also adds
state encoding behavior older clients do not fully understand. Reinstalling
beta.84 is therefore not a safe state-store rollback procedure. A production
rollback needs the preserved store, a compatible CLI and an explicitly reviewed
resource/application recovery plan.

No remote initialization, deployment or state migration is authorized merely
by opening or merging this dependency PR.

## Application migration remains separate

The Domain Cloudflare host creates separate aggregate/view objects. Its layout
migration does not import HomeDO's SQL records, and `legacyData: true` is not an
application-data import tool. Existing export/PITR/purge paths do not
automatically cover Domain events, receipts, allocator state, pending deliveries
or derived-view checkpoints.

Follow the [cross-platform plan](CROSS_PLATFORM_PLAN.md) before enabling the new
library. Keep authority cutover disabled until its import, server-side turn
consistency, coherent recovery and erasure behavior are implemented and exercised
against actual durable storage. A business-state snapshot or an in-memory Story
cannot establish these storage guarantees.

## Validation requirements

Use Node 26+ and the frozen pnpm lockfile. Keep normal commands in the root Vite+
configuration:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:coverage
pnpm test:workflows # Linux; isolated real workerd persistence/restart fixture
pnpm build
pnpm --filter @kitties/kittyd check
```

Workflow patch validation must exercise the installed package under local
workerd with isolated persistent storage, covering activity failures, callback
progress/retry behavior, duplicate execution after purge, durable timestamps,
bounded immutable export and process restart. Check both TypeScript/Bun source
and emitted JavaScript/declarations. Document local runtime limitations such as
unemulated jurisdictions or cloud PITR; do not call them verified by a type check.

Record actual commands and results in the PR. Staging and production validation
are separate from local verification and require their own authorization.
