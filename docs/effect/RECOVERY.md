# Recovery operations

The rewrite uses Cloudflare SQLite point-in-time recovery (30 days) and encrypted row exports.
The Backups and recovery panel is under Health. The old Go buckets are outside this system and
remain retained. The owner authorized deletion of old Boat checkpoints on 2026-11-02, so legacy
desktop checkpoints are no longer available.

## Restore an object

Choose a registered HomeDO, ChatDO, KittyDO or application workflow and a time/bookmark. Restore
advances an epoch in RecoveryDO, which is deliberately outside the restore scope. Older workflows
stop for owner review; resuming them does not authorize their old effects. Start a new request
after checking what happened. Owner writes pause while recovery is running.

The restore workflow saves the undo bookmark outside the target, prepares PITR, evicts the target,
and confirms reactivation through a fresh stub after a durable wait. The evicted stub must not
be reused. It fences desktop credentials before and after restore, disconnects
OAuth credentials and writes the restored epoch to HomeDO. Reauthorize connections and use the
desktop upgrade action to issue fresh guest credentials. A repeated operation ID must have the
same payload. A suspended operation has a Continue action in the recovery panel.

Workflow recovery permits are cached for up to five seconds. Restore waits six seconds after
fencing before restoring the target so permits from the previous epoch have expired.

Cloudflare bookmarks are opaque and only apply to the same object. Export manifests include
bookmarks, but row captures across actors are not one global transaction.

## Repair a desktop lifecycle operation

Boat billing refusals (`credit_required`, `subscription_required`, `card_required` or HTTP 402)
suspend lifecycle work as `BOAT_BILLING`. Resolve the billing or saved-snapshot allowance problem
before resuming the operation through `POST /v1/kitties/:id/computer/resume`, with its original
`operationId` in the JSON body.

An older run may have journaled the refusal as a permanent failure and left the desktop in
`archiving`. Use `POST /v1/kitties/:id/computer/repair` with a fresh `operationId` to replace that
run with a new operation of the same kind. Repair requires the existing run's health record to
be suspended; it refuses a live run. Updates from the replaced operation remain fenced by its
operation ID. Check the returned `executionId` through `/v1/computer-runs/:executionId` and the
desktop state through `/v1/kitties/:id/computer`.

## Exports and retention

An export freezes row snapshots in each actor, then encrypts bounded JSONL parts using AES-GCM.
The part's R2 path is authenticated as AAD. Workflow journals and actor rows are included; raw
credentials and screenshot bytes do not enter workflow journals. Exports live in the rewrite's
RetainedExports bucket. The `exports/` prefix has a 30-day lock and 90-day expiry. Retries check
for an existing part before uploading it. A manifest is written after all parts complete.

A daily 03:00 UTC job starts an export and purges activity/deferred/clock rows for completed
workflows older than 30 days. Request/result tombstones remain so an old request cannot repeat
side effects. The retention job can also be started from Health.

## Key escrow

The `v1` KEK is a Worker secret. Its escrow copy is on the owner's Mac:

- `~/.kitties/effect-recovery/kitties-next-kek-v1.json`: RSA-OAEP-SHA256 wrapped key.
- `~/.kitties/effect-recovery/escrow-private.pem`: the Mac's private unwrap key, mode 0600.

The live escrow drill decrypted 32 bytes and checked their hash without logging or writing the
plaintext key. See [evidence](evidence/key-escrow-mac.json). The envelope contains the key's hash,
algorithm and encoding. Alchemy expects the 32 bytes encoded as 64 lowercase hexadecimal digits.
Rotate and verify this escrow whenever the KEK changes.

## Deployment separation

`scripts/configure-hooks-rate.mjs` configures only the signed hook hosts' WAF rate rule. Bucket
locks/lifecycle are infrastructure settings managed by the owner's Alchemy deployment. Application
CI must not receive bucket-configuration permissions. `scripts/publish-app.mjs next|prod` publishes application code and frontend assets to an existing
Alchemy stage. It requires only Workers Scripts Write and Account Settings Read, preserves secret
bindings and checks the committed DO class manifest. A live publish of all four Workers passed;
the same token received 403 when attempting a bucket-lock mutation.

The manual `effect-deploy.yml` Actions workflow needs the repository secret
`CLOUDFLARE_WORKER_DEPLOY_TOKEN` and variable `CLOUDFLARE_ACCOUNT_ID`. Both were configured and verified using the owner’s Mac GitHub login. The Effect validation
workflow has passed on GitHub. The manual deployment workflow becomes dispatchable after its
file reaches the default branch; direct restricted-token publishing is already verified. ChatDO
PITR, full encrypted export authentication, purge/tombstones and actual R2 error recovery passed.
Production cutover, authenticated Health/session, ChatDO PITR, guest fencing/rotation and a fresh desktop screenshot passed. See [production evidence](evidence/production-cutover-cloud.json). The old Worker and legacy storage remain retained; [rollback instructions](../DEPLOY.md#production-verification-and-rollback) use the tested custom-domain override.
