# Encrypted recovery backups

The gateway uses restic to keep seven daily and four weekly recovery snapshots in a separate repository. Set `RESTIC_REPOSITORY` and `RESTIC_PASSWORD`; S3 repositories also use `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_DEFAULT_REGION`. Cloudflare deployment creates a separate R2 backup bucket and passes these as container secrets. The restic password is never placed in the primary state service or inside its own recovery archive. Keep it and repository access credentials in an independent secret manager.

After the first successful backup, automatic attempts run at 03:00 UTC. A new installation or an overdue failed attempt catches up when idle. Active work and viewers defer an automatic attempt. Failures back off from five minutes to several hours; Settings shows the last success, failure, next attempt, and whether recovery is overdue. “Back up now” starts a manual attempt and waits for admitted work to finish. `GET /v1/backups/status` and `POST /v1/backups` expose the same authenticated controls.

During capture, the gateway rejects new work and settings changes, drains admitted tasks and credential refreshes, and sleeps desktops to create permanent checkpoints. It exports each saved `/home/kitty` sequentially, including retained checkpoints for removed computers. All homes stream through one tar archive directly into restic; the gateway does not stage full homes on its disk. Scratch space is needed for one verified Boat snapshot chunk and the gateway state copy. The maintenance window includes home upload. Inventory and backup status stay readable, and prior running availability is restored after capture, including on failure. A failed capture never counts as a successful recovery snapshot. Resume intent is committed before backup suspension, so a hard gateway restart retries the suspension and restores previously running computers. A later explicit stop, sleep, or removal supersedes that recovery intent.

Each encrypted snapshot contains one `recovery.tar` with:

- `gateway/`: committed gateway stores, encrypted vault and backups, runtime ownership, chat history, budgets, goals, journals, credentials, settings, and SSH keys. Cache markers and kernel lock files are excluded.
- `computers/<kitty-id>/home/`: the full saved home, preserving files and links. Retained removed computers use `removed-<runtime-name>`.
- `manifest.json`: capture time, computer checkpoint references, and prior availability.
- `configuration/kitties.yaml`: the active configuration source when it exists.
- `bootstrap-secrets.json`: the configured `BOAT_DEV_API_KEY`, `OPENAI_API_KEY`, `KITTIES_TOKEN`, and `KITTIES_VAULT_KEY`. Other application-specific environment variables must be supplied separately.

Restic initially labels streamed snapshots `kitties-pending`; only a complete capture and successful stream acknowledgement promote the snapshot to `kitties-recovery`. A broken stream can therefore never become the latest selectable recovery. Interrupted pending snapshots can be inspected and removed separately with restic. Retention applies only to the `kitties-recovery` tag and `kitties-gateway` host; a snapshot may satisfy both daily and weekly retention. Do not share this tag/host pair with another independent gateway.

## Restore on a replacement host

Install restic and provide the repository URL, its password, and storage credentials through the environment. Restore into a new empty directory:

```sh
kitties restore /absolute/path/recovered
# Or choose an explicit restic snapshot ID:
kitties restore /absolute/path/recovered 01234567
```

The command streams and safely extracts the archive without overwriting existing data or following archive-created symlinks. It does not start computers, replay tasks, or change the live gateway. Restore failure can leave a partial recovery directory; inspect it and choose another empty destination for a retry.

Stop the old gateway before activating its replacement. Preserve the original runtime owner references and vault key. For a gateway using ordinary persistent storage, copy `gateway/` into its new data directory, restore the configuration and bootstrap secrets into the deployment's secret manager, and set `KITTIES_DATA_DIR` to that directory. The recovery copy retains backup resume receipts: previously running computers resume when the replacement gateway starts its watchdog, while explicitly sleeping or stopped computers remain so. Interrupted user tasks still require manual continuation; recovery does not replay their work. If the existing Boat account and checkpoints are available, the original references can reconnect to them.

For a new Cloudflare primary state service, set `KITTIES_RESTORE_SNAPSHOT` to the recovery ID through the deployment configuration. Startup checks that the authoritative service is empty, streams only gateway metadata and bootstrap secrets into temporary storage, validates the stable secret bindings, and atomically imports the gateway files. Home entries are read through the archive without being staged. Later boots verify the imported snapshot receipt; a restore flag pointed at unrelated existing state is rejected. The archived configuration is imported as `recovered-config.yaml` and becomes the default for this explicit recovery, preserving profiles and goals defined only in YAML. An explicit `-config` argument overrides it; existing environment overrides, including the new data directory, still apply.

Reuse the original Alchemy state and secrets when available. For a new deployment, extract the encrypted `bootstrap-secrets.json` locally first and configure its stable bindings. The vault key must match the original exactly; current Boat/OpenAI keys may be deliberate replacements, and the Worker may use its newly configured gateway bearer token. Recovered keys are never installed only into a first-boot process or copied into plaintext primary state.

Before switching a live gateway to a recovery generation, `kitties verify-recovery <full-snapshot-id>` decrypts the archive, validates its manifest and vault key, and checks Boat ownership against current provider generations using read-only API calls. A stale archive that conflicts with newer computers is rejected before the old writer is retired.

Manual recovery commands are also available:

```sh
kitties restore-gateway /absolute/path/recovered-metadata SNAPSHOT_ID
KITTIES_STATE_URL=https://new-private-state-service kitties import-state /absolute/path/recovered-metadata/gateway
```

Import requires a new, fenced state-service epoch with revision zero and no existing files. It uploads blobs first and commits the entire file manifest in one transaction; it never replaces populated state. An unmarked nonempty cache is intentionally rejected during ordinary startup.

If Boat checkpoints are unavailable, create replacement computers deliberately and copy the matching `computers/<id>/home/` contents into `/home/kitty` while those computers are stopped. Set ownership to their `kitty` user and preserve file modes and links. Rebind runtime identities through a reviewed recovery procedure; do not overwrite an owner ID or silently reuse a foreign computer. The archive provides portable home data even when the original runtime cannot be restored.
