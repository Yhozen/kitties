# Backups and recovery

Use Health → Backups and recovery for encrypted exports and per-object Cloudflare PITR.
See [recovery operations](effect/RECOVERY.md) for fencing, key escrow and retention.

The legacy Go state/backup buckets and Boat checkpoints remain retained. They are not imported
into Effect and must not be deleted without the owner's instruction.
