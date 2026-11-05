# Strict native HTTP idle-body cancellation gate

This is a **separate failing gate** for published `tauri-plugin-http 2.8.3`.
It is not included in the desktop crate's 19-test baseline. Nothing is skipped
or marked as an expected failure: the two pending-read cases must fail on stock
2.8.3, while the no-pending-read control passes. Keep the nonzero exit status.
A passing baseline or packaged smoke test does not clear this gate.

The application-owned [fixture](idle-body-probe.rs) calls the actual official
plugin through Tauri MockRuntime IPC and uses actual reqwest TCP. It copies no
provider implementation. Inject it only into an isolated copy of the desktop
crate; no application source, registry entry, provider dependency, manifest,
lockfile or shared test module needs changing.

## What it proves

The loopback server flushes HTTP/1.1 NDJSON headers and withholds its body. A
Weak resource observer confirms the body-read handler acquired its response
reference; the observer cannot keep the response or socket alive. Cancellation
must settle that IPC and close the idle peer connection within a 300ms bound,
before the server releases any body bytes. A successful cancel must remove the
resource-table entry. Channel/socket deadlines and a 35s outer process deadline
bound execution; there are no sleeps or retried assertions.

On stock 2.8.3, cancellation succeeds and removes the resource-table entry, but
the pending read retains one reference and the socket stays open. After the
failed deadline observation, the fixture explicitly releases one chunk or EOF
for diagnosis and cleanup:

| Case                              | Stock observation                                                                                                                              | Strict result |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Pending read, then explicit chunk | Returns successful `{"n":1}\n` plus plugin continuation byte `0` after cancellation; only then drops the last reference and closes the socket. | FAIL          |
| Pending read, then explicit EOF   | Returns invalid resource ID after cancellation; only then drops the last reference and closes the socket.                                      | FAIL          |
| No pending read                   | Cancellation drops the last response reference and closes the socket without server body output.                                               | PASS          |

All threads join and response references reach zero before the strict
cancellation assertion reports these failures. Per-case JSON preserves the
resource counts, table membership, IPC outcome, socket state and release
milestone. `readCompletionPhase` distinguishes prompt cancellation from a read
that completed only after server release. Cargo's build receipt identifies the
actual dependency source and enabled features.

This is native plugin/IPC evidence, not packaged WebKit, HTTP/2, macOS/Windows or
Cloudflare Managed OAuth proof. The workerd idle-disconnect failure is a
**different provider gate**; neither failure clears the other.

## Prerequisites

Run on a supported Linux native build environment as a non-root user. The
verified environment was Ubuntu 22.04 userland, Rust/Cargo 1.99.1, Tauri 2.12.5,
plugin 2.8.3, reqwest 0.12.28 and Tokio 1.54.1. The application manifest requires
Rust 1.90 or newer. Use the committed Cargo.lock and existing pinned dependency
features, including `rustls-tls-native-roots`.

Required native development packages include WebKitGTK 4.1, GTK 3, pkg-config,
a C/C++ linker/toolchain, and the libraries required by the pinned Tauri stack.
The crate's build dependencies still require these libraries with MockRuntime;
no display server, WebDriver, browser sign-in or provider credentials are needed
for this probe. Python 3, Bash, GNU coreutils `timeout`, and loopback TCP must be
available. Cargo dependencies must already be cached for the offline command
below. Missing caches fail visibly; do not change pins or edit registry sources.

Install the repository's pinned JavaScript dependencies and build its actual
frontend using the normal repository setup before starting, for example
`pnpm --filter @kitties/web build`. The recipe requires
`apps/web/dist/library.html`; it does not substitute fixture assets.

## Isolated crate-copy invocation

Run this Bash block from the repository root on that supported Linux environment.
It creates fresh output under `.context/` and does not depend on any research
snapshot. The copied Cargo.toml and Cargo.lock remain unchanged. The only source
addition is the owned test module, enabled in the copied `src/lib.rs`.

```bash
bash <<'SH'
set -euo pipefail
repo_dir=$PWD
test -f "$repo_dir/apps/desktop/src-tauri/Cargo.lock"
test -f "$repo_dir/apps/web/dist/library.html"
mkdir -p "$repo_dir/.context"
probe_dir=$(mktemp -d "$repo_dir/.context/library-desktop-idle.XXXXXX")
mkdir -p "$probe_dir/workspace/apps/desktop" "$probe_dir/workspace/apps/web"
mkdir -p "$probe_dir/evidence" "$probe_dir/tmp"
cp -a "$repo_dir/apps/desktop/src-tauri" "$probe_dir/workspace/apps/desktop/"
cp -a "$repo_dir/apps/web/dist" "$probe_dir/workspace/apps/web/"
probe_crate="$probe_dir/workspace/apps/desktop/src-tauri"
cp "$repo_dir/scripts/testing/library-desktop/idle-body-probe.rs" \
  "$probe_crate/src/idle-body-probe.rs"
cat >> "$probe_crate/src/lib.rs" <<'RS'

#[cfg(test)]
#[path = "idle-body-probe.rs"]
mod idle_body_probe;
RS

(
  cd "$probe_crate"
  env -u KITTIES_DESKTOP_APPLICATION -u KITTIES_DESKTOP_ISSUER \
    CARGO_TARGET_DIR="$probe_dir/target" CARGO_BUILD_JOBS=2 \
    CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_PROFILE_DEV_DEBUG=0 \
    cargo test --offline --locked --no-run --message-format=json \
    > "$probe_dir/evidence/build.jsonl" \
    2> "$probe_dir/evidence/build.stderr.log"
)
probe_binary=$(python3 - "$probe_dir/evidence/build.jsonl" <<'PY'
import json, sys
rows = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8")]
artifact = next(row for row in rows
    if row.get("reason") == "compiler-artifact"
    and row["target"]["name"] == "kitties_desktop"
    and row["profile"]["test"] and row.get("executable"))
print(artifact["executable"])
PY
)
set +e
env -u KITTIES_DESKTOP_APPLICATION -u KITTIES_DESKTOP_ISSUER \
  TMPDIR="$probe_dir/tmp" KITTIES_IDLE_BODY_PROBE_OUTPUT="$probe_dir/evidence" \
  timeout --signal=TERM --kill-after=3s 35s \
  "$probe_binary" --test-threads=1 --nocapture idle_body_probe:: \
  > "$probe_dir/evidence/runtime.stdout.log" \
  2> "$probe_dir/evidence/runtime.stderr.log"
probe_status=$?
set -e
printf '%s\n' "$probe_status" > "$probe_dir/evidence/runtime.exit-status"
cat "$probe_dir/evidence/runtime.stdout.log"
cat "$probe_dir/evidence/runtime.stderr.log" >&2
printf 'Evidence: %s\n' "$probe_dir/evidence"
exit "$probe_status"
SH
```

Expected stock output: **1 passed, 2 failed, 19 filtered out**, exit **101**.
The filter selects every owned probe case and leaves the baseline separate; it
is not an ignored test. Timeout exit 124/137 or a build/fixture error is a
separate harness failure, not evidence of the plugin cancellation defect.

The intentionally disabled native configuration avoids browser opening and
external authentication. The only HTTP requests are to the test's ephemeral
`127.0.0.1` listener. Fixture app state uses the isolated `TMPDIR` and is cleaned
up; diagnostic logs and JSON remain under the printed evidence directory.

## Cloud VM / rootfs execution

Amazon Linux's host libraries are not a compatible substitute for the tested
WebKitGTK 4.1 environment. A fresh clone on that host needs an explicitly
prepared Ubuntu/Debian VM, container or rootfs with the prerequisites above.
Use its real compiler, linker and GTK/WebKit runtime together; setting only
`PKG_CONFIG_PATH` to another distribution's libraries is insufficient.

Run the same crate-copy block **inside** that supported userland. Make the
checkout and built assets available there, and provide a writable `.context`
output location plus writable test temp directory. If using a chroot/private
namespace, provide `/proc`, `/dev/null`, `/dev/urandom`, loopback networking, the
Rust toolchain and cached Cargo dependencies; keep the base rootfs read-only
and bind only the unique proof output writable. A private network namespace
may restrict networking to loopback; bring its loopback interface up first.
Run the test binary as an unprivileged user owning its output/temp directories.
GNU `timeout` must remain outside the test binary with process-group cleanup
intact. Namespace/chroot setup requires privileges supported by the host.

No VM/rootfs download, package install, registry edit, trust-store change,
provider patch, cloud deployment or auth setup is performed by this fixture.
The prepared cloud research rootfs is optional task infrastructure, not a
repository dependency or a requirement to obtain the original `.context`
snapshot.

## Dependency-policy boundary

The isolated candidate provider diff remains a review artifact under `.context`;
this fixture does not apply it. At investigation time, 2.8.3 was the latest
published stable crate. The inspected 3.0.0-alpha.3 retained the same broken
cancellation ownership and required Tauri 3. An official compatible fixed
publication is the preferred dependency route. Any fork/vendor/source-override
exception requires separate review; no such exception is encoded here.

Retest this strict gate against the approved published dependency when it
changes. The current structural milestone uses public Tauri ResourceTable and
Weak-reference APIs against the pinned response ownership; review that milestone
alongside future provider ownership changes. Packaged native cancellation stays
failed until the actual approved application dependency passes its own proof.
