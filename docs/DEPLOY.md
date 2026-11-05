# Cloudflare deployment

Production is `https://kitties.rccpr.tech`, Alchemy stack **KittiesNext**, stage **prod**.
`next.kitties.rccpr.tech` is an isolated test stage. Boat hosts guest desktops. Infrastructure
is declared in `apps/gateway/alchemy.run.ts`; the old Go resources are outside this stack.

## Infrastructure deployment

The owner's infrastructure environment needs `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`,
`BOAT_DEV_API_KEY`, `KITTIES_KEK` (32 bytes as 64 hex digits), `KITTIES_RELEASE_KEY` and a stable
`KITTIES_DEPLOYMENT`. Do not regenerate the KEK or deployment identity on redeploy.
Optional settings: `KITTIES_NEXT_DOMAIN`, `KITTIES_ACCESS_EMAIL`, `KITTIES_ACCESS_ISSUER`,
`KITTIES_ACCESS_AUDIENCE`, `KITTIES_CHATGPT_ENABLED`. Production domain and audience have defaults
for the existing deployment. A new Access application needs its own audience.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm --filter @kitties/gateway exec alchemy deploy --stage prod --no-input --yes
```

Infrastructure permissions reconcile Worker bindings, DOs, domains, Access and R2 locks/lifecycle.
Escrow the KEK outside Cloudflare and verify decryption before entrusting production data to it.
Do not edit application source during a deployment build.

Guest releases are immutable SHA-256 archives built from `guest/kittyd`. Upload the archive to
the stage's GuestAssets bucket, then register its `{key, sha256}` through `PUT /v1/releases/kittyd`.
Use the desktop Upgrade action to install the registered release and rotate credentials.
See [releasing](RELEASING.md).

## Application publishing

The cross-platform Library candidate adds four Domain Durable Object classes and
the native `LibraryModel.DomainBackfill` Workflow. Its application-only publisher
now refuses the manifest before reading credentials or making requests: the full
Alchemy infrastructure/binding plan must be reviewed first. The instructions below
describe the earlier release; they must not be used to bypass that guard.

`KITTIES_LIBRARY_CUTOVER_ENABLED` defaults to `false`. Keep it disabled while
the Library export/retention/reset/purge and idle-stream teardown gates remain
incomplete. Local sealed-set restore does not establish arbitrary cross-object
PITR. Rolling back to an older Worker that writes legacy skill rows after Domain
writes is unsafe. See [the cross-platform plan](CROSS_PLATFORM_PLAN.md) and
[staging auth preparation](LIBRARY_STAGING_AUTH.md). No remote deployment or
migration is authorized by the implementation or CI checks.

After infrastructure exists, use a separate token with Workers Scripts Write and Account Settings
Read, without bucket-configuration permissions:

```sh
pnpm build
node scripts/publish-app.mjs prod
```

This command needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_WORKER_DEPLOY_TOKEN`, checks the DO class
manifest, builds every bundle first and preserves existing secret bindings. Infrastructure or DO
class changes require Alchemy instead. The manual `effect-deploy.yml` workflow uses the same
restricted publisher. Its secret and account variable are configured; GitHub only permits dispatch
after that workflow is on the default branch. A direct restricted-token publish has been verified.

## Beta.85 production deployment (2026-11-05)

The owner authorized the state-store upgrade and deployment. `alchemy state bootstrap
--backend cloudflare` adopted `alchemy-state-store` at contract v8 with every existing
stack preserved. `alchemy deploy --stage prod` then created the four Library Domain
classes and their backfill Workflow, unbound the retired probe classes and updated
all four Workers. Use Node 26 and map `KITTIES_DEPLOYMENT_PROD` to `KITTIES_DEPLOYMENT`.

Beta.85 evaluates Worker and Durable Object constructors during plan with storage-less
state and no bindings. Constructors must defer storage access and binding decoding to
runtime. Plan-only branches check `!globalThis.__ALCHEMY_RUNTIME__`, which bundling
folds away.

`LibraryModel.DomainBackfillRun` intentionally fails with `LibraryRecoveryError` until
the Library recovery authority exists. Every deploy reports that failure after the
Workers update. To initialize the authority, set `KITTIES_LIBRARY_CUTOVER_ENABLED=true`
and a `KITTIES_LIBRARY_CODE_DIGEST`. Redeploy, then POST `{ "inventoryId": ... }` to
`/v1/recovery/library/import` as the Access-authenticated owner. Redeploy again so the
backfill completes.

## Production verification and rollback

After deploy, authenticate through Access and verify `/v1/health`, `/v1/session`, the web app, a
completed desktop screenshot, duplicate message receipt and replay. The completed cutover also
ran an actual ChatDO PITR and guest credential rotation; see [cutover evidence](effect/evidence/production-cutover-cloud.json).

The old Worker `kitties-gateway-prod-qqaqe4nm4n2wdzo2` remains deployed. To roll back, PUT the
following JSON to Cloudflare's `/accounts/{account}/workers/domains` with an infrastructure token:

```json
{
  "hostname": "kitties.rccpr.tech",
  "zone_id": "66cde0ef43d9c035cb2eb9d41521d049",
  "service": "kitties-gateway-prod-qqaqe4nm4n2wdzo2",
  "environment": "production",
  "override_existing_origin": true
}
```

The rollback uses the legacy Access application and legacy state. Verify its login/health after
the switch. This restores the old service; it does not migrate new records into Go. The real route
rollback rehearsal completed in 1.44 s on the candidate hostname. To return to Effect use service
`kittiesnext-gateway-prod-ngmlf4varln5eane` and verify owner APIs again.

Retain `kitties-state-prod-enfwxu7njxoaon5i` and `kitties-backups-prod-fq4h6qbjfkfhxbsp`. The owner
authorized deletion of old Boat checkpoints on 2026-11-02; legacy desktop checkpoints are no
longer available for rollback. Never destroy the legacy stack without owner approval.
