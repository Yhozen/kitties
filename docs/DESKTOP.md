# A kitty's desktop

Each active kitty has a persistent Boat VM. The `kittyd` daemon connects outbound to Cloudflare
over a scoped WebSocket. The PWA can watch live frames, take control, send input and use the
clipboard. The model uses DOM/accessibility references when possible and screenshots otherwise.

Start, sleep, restore and upgrade are durable operations visible in the desktop panel. Sleep
quiesces the guest before checkpointing; a quiesce failure parks for repair. Restore creates a new
generation from the checkpoint and reconnects with fresh credentials. Capacity is limited to five
active desktops. First installation may take many minutes; retries reuse installed steps.

Tool intents and receipts prevent duplicate effects across disconnects or redeployments. An
unknown outcome needs an owner decision. A vault reference can type a secret without putting the
plaintext into the model context. Never resend an unknown action without checking its outcome.

Measured 200-input latency: ack p95 242.6 ms; click-to-visible p95 359.6 ms. Non-model agent step
overhead p95 is 525 ms (453 ms on a second run), below its 1 s target; see [latency](effect/LATENCY-BASELINE.md).

Accessibility calls use a persistent agent-desktop 1.1.0 adapter through its pinned ABI 7 library.
A separate helper runs as the desktop user with no channel credentials. Requests are bounded,
serialized, and never queued beyond the active call. Native errors preserve delivery disposition;
a crash or timeout during a mutation records an unknown outcome. A helper restart creates a new
reference namespace, so an agent must take a fresh snapshot before acting.

The guest release verifies both upstream CLI and FFI archive checksums and includes the Apache
license. `guest/kittyd/tests/perception-native.py` exercises real GTK/AT-SPI and compares same-version
CLI snapshots with persistent calls. The local fixture measured p95 14.24 ms → 11.89 ms; this excludes
network and model time and does not predict a proportional end-to-end improvement.

The video transport uses voxl 0.3.2 on a password-protected loopback listener, started only while
video viewers are connected. The guest forwards only single-stripe H.264 video. Audio, microphone,
clipboard, file transfer and resizing are disabled; all input still uses the existing control grant
and intent ledger. `/video` uses the same owner identity/Origin and guest token/generation/epoch
checks as the other desktop sockets. Credential rotation or epoch change closes video peers.

Each viewer can have at most eight unacknowledged video frames and 2 MiB queued. A dropped delta
puts only that viewer into keyframe recovery; a slow viewer cannot break the decode chain of a
fast one. The existing `/frames` JPEG path stays available for compatibility. No encoded frames
are retained in durable storage.

Build the voxl artifact on Ubuntu 24.04 x86_64 using `pnpm --filter @kitties/kittyd build:voxl`
before `pnpm --filter @kitties/kittyd release`; see the dependency list in the build script. The
source archive hash, Rust/esbuild versions, Cargo lockfile, and native package versions are recorded.
The guest bundle includes voxl source, vendored Rust dependencies, build instructions and licenses.
The native test exercises actual capture/authentication/keyframe recovery. With local workerd
running on ports 1337/1338, `bun guest/kittyd/probes/video-channel.ts` verifies slow-viewer isolation,
video/input separation, grant release, epoch changes and rejection of stale guest connections.
