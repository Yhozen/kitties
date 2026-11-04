# Boat runtime

Boat runs each desktop in a separate Ubuntu VM. The gateway uses the authenticated
REST API for lifecycle and host-key discovery, and OpenSSH for binary desktop
frames, commands and stdin. The shared guest installer runs as root; ordinary
commands run as `kitty` in `/home/kitty/work`.

`New(Options)` takes a dedicated absolute state directory and an API key. Call
`Initialize` during normal startup, and `Close` at gateway shutdown. A file
lock prevents two gateway processes from using the same runtime state. Back up the
entire directory: it contains deployment identity, computer aliases, pending
requests, checkpoint references, the private SSH key and pinned host keys.
`CheckAccess` is the strictly read-only recovery preflight: it rejects unresolved
operations and reads each recorded machine identity and every retained saved
checkpoint from the authenticated account. Foreign or inaccessible machines fail
preflight. A deleted or expired current machine is recoverable only through its
exact ready checkpoint; previously purged tombstones need no recovery object.
Normal startup uses `Initialize` to finish a journaled checkpoint promotion first.
It verifies the archived source and its ownership, accepts only the exact named
new artifact from that source, or retries an unfinished save from its verified
archived disk. It then runs the identity audit. Recovery preflight never performs
that reconciliation or changes provider state.

The existing runtime methods accept logical names and every recorded remote ID.
`Resolve` returns the current remote ID after restoration changes it. Creates
persist the exact body and idempotency key before calling Boat; a lost response is
reconciled by deployment, computer and generation labels. An unknown create older
than Boat's 24-hour deduplication window requires operator reconciliation.
Inventory errors never authorize creating a replacement computer.

A live check on 2026-10-27 found that Boat drops `labels` when creating from a
saved snapshot, and its update endpoint rejects label changes. Those restored
computers are bound instead to the exact authenticated create receipt (remote
ID, generation and source checkpoint), persisted before SSH access. Every API
read must still report `access: owner`. No other unlabeled computer is accepted.
Inventory and capacity checks explicitly fetch those recorded IDs. The same
request body and idempotency key were verified against the real restore endpoint
to return the same VM. A lost response beyond the 24-hour window still fails
closed; receiptless legacy computers require explicit operator reconciliation.

The runtime also scans the unfiltered account inventory before starting a computer.
A newer generation or an unknown owned computer with the same unlabeled logical
name blocks startup and lifecycle mutations. Purge verifies the saved checkpoint
ID again before deletion. Names detect stale restored gateway state; they never
grant access to a machine.

A fresh computer comes from a clean permanent template, keyed by the shared guest
installer hash, Linux amd64 and machine size. The template is built with no kitty
environment, its browser profile is removed after quiescing, and its source VM is
deleted after its checkpoint is ready. Template bootstrap, checkpoint and deletion
use the same durable retry journal. Old template versions are pruned only after
no pending create references them. Personal recovery always uses the kitty’s own
checkpoint.

`Stop` closes the kitty browser, flushes writes, requests a non-forced stop, waits
for archival, and saves the completed state under one permanent snapshot name.
A checkpoint failure returns an error and retains its retry intent and the last
verified recovery reference. `Start` resumes the computer or, when the ordinary
14-day snapshot expired, creates a new machine from its permanent snapshot.
`Remove` checkpoints first and deletes the machine, retaining the saved snapshot.
If the deletion receipt is lost, a retry reconciles only authenticated machine
absence plus the exact retained checkpoint and source identity. This establishes
logical removal; without the operation ID it cannot attest to completion of the
provider's asynchronous byte purge.
`PurgeCheckpoint` is a separate irreversible deletion available after removal.
`ExportHome` streams `/home/kitty` from the verified saved snapshot as a tar archive
for independent encrypted backups. It does not copy a changing live filesystem.
Boat's file endpoint was observed to lose inherited file references after the
source VM was deleted. In that case, the runtime downloads the immutable snapshot
chain, verifies each chunk's size and SHA-256, and reconstructs the final home from
the inventory and newest versions of its files. Deleted files stay deleted. No
backup VM boots, and signed chunk URLs never receive the gateway API key.

The gateway needs `zstd`. Export uses one compressed chunk of scratch disk (at most
512 MiB), a zstd window capped at 128 MiB and in-place AES-GCM frames capped at
64 MiB. Larger chunks/frames or a truncated inventory fail explicitly. There is no
home-size cap and no full-home staging inside this runtime. A failed export may
have written partial bytes: the backup coordinator must abort its destination and
must not accept that stream as a recovery point.

On 2026-10-27, a separate-process resource probe decoded an exact 512 MiB encrypted
chunk with maximum-sized frames at 81.6 MiB peak RSS. A separate 512 MiB tar with a
128 MiB zstd window used 130.3 MiB peak RSS. Their conservative sum is 211.9 MiB;
this excludes inventory metadata, the gateway's other work and restic. These were
macOS measurements, not a claim about total production-container memory.

The provider deadline is one hour by default. Call `Renew` only while the gateway
holds an activity lease. Five simultaneously active computers is the maximum.
The runtime does not enforce network egress policy, provide RAM snapshots, or
move machine disks between local Lima and Boat architectures.

## Verification

`go test -race ./internal/boat` covers recovery, ownership, failure contracts and
SSH transport. The paid live canary is opt-in:

```sh
KITTIES_BOAT_LIVE=1 \
KITTIES_BOAT_LIVE_STATE="$PWD/.kitties/boat-canary" \
go test -v ./internal/boat -run '^TestLiveBoatDesktopRecovery$' -count=1 -timeout 35m
```

Provide `BOAT_DEV_API_KEY` through the process environment, never a command-line
argument. The canary uses one small VM at a time. It checks screenshots, framed
streaming, stream cleanup, keyboard/mouse, clipboard, absence of gateway keys,
and a file, installed package and browser cookie surviving restoration onto a
new remote ID. Its final computer is stopped and retains a permanent checkpoint.
Do not delete the state directory until the remote resources are intentionally
removed and the recovery checkpoint's retention has been decided.

API contracts were checked against Boat's official documentation:

- [Creation and idempotency](https://docs.boat.dev/api/reference/sandboxes/create-sandbox)
- [SSH host-key pinning](https://docs.boat.dev/ssh-access)
- [Permanent snapshots](https://docs.boat.dev/api/reference/snapshots/save-saved-snapshot)
- [Snapshot file export](https://docs.boat.dev/api/reference/snapshots/get-snapshot-file)
- [Immutable snapshot download](https://docs.boat.dev/api/reference/snapshots/get-snapshot-download)
- [Deletion and retained saved snapshots](https://docs.boat.dev/api/reference/sandboxes/permanently-delete-sandbox-data)

The separate fleet acceptance uses `KITTIES_BOAT_FLEET_LIVE=1` and a dedicated
`KITTIES_BOAT_LIVE_STATE`, with `-run '^TestLiveBoatTemplateFleet$'`. It creates a
clean template, starts five small desktops, verifies independent workspaces,
clipboards, controls and screenshots, rejects a sixth, and stops all five with
permanent checkpoints. The 2026-10-27 run passed in 5m45s; template creation plus
the first desktop took 2m14s, subsequent desktops took 17–27 seconds, and stops
took 11–30 seconds. Each small VM reported two logical CPUs and about 3.8 GiB RAM.
The five surviving VMs reported $0.00327 combined list-price usage; that excludes
the deleted template builder. Account-wide inventory confirmed zero active VMs.

A follow-up hydration acceptance found that Boat can start the desktop before
replacing its filesystem. The shared guest now compares the service's working
directory inode with the current home and restarts only a stale service. The
follow-up passed: an actual Xterm-created file survived deletion and restoration
onto another VM, while an ordinary repeated Start preserved the running service.
