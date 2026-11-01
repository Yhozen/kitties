# Recovery operations

The rewrite uses Cloudflare SQLite point-in-time recovery (30 days) and encrypted row exports.
The Backups and recovery panel is under Health. The old Go buckets and Boat checkpoints are
outside this system and must be retained.

## Restore an object

Choose a registered HomeDO, ChatDO, KittyDO or application workflow and a time/bookmark. Restore
advances an epoch in RecoveryDO, which is deliberately outside the restore scope. Older workflows
stop for owner review; resuming them does not authorize their old effects. Start a new request
after checking what happened. Owner writes pause while recovery is running.

The restore workflow saves the undo bookmark outside the target, prepares PITR, evicts the target,
and confirms reactivation. It fences desktop credentials before and after restore, disconnects
OAuth credentials and writes the restored epoch to HomeDO. Reauthorize connections and use the
desktop upgrade action to issue fresh guest credentials. A repeated operation ID must have the
same payload. A suspended operation has a Continue action in the recovery panel.

Cloudflare bookmarks are opaque and only apply to the same object. Export manifests include
bookmarks, but row captures across actors are not one global transaction.

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
CI must not receive bucket-configuration permissions. Restricted CI credentials and the live
export/PITR drill are still being verified; production cutover remains gated on those results.
