# Real Linux desktop checks

This harness runs the actual packaged shared Library under GTK/WebKitGTK,
private D-Bus and Xvfb. It never substitutes a UI, injects a native global, or
turns off shipped incognito, TLS or WebKit sandboxing. It is a separate runtime
gate requiring native prerequisites; ordinary Vitest is not this proof.

## Environment and immutable inputs

The current cloud VM cannot run distro-native WebKitGTK. An already prepared
official Ubuntu22.04 rootfs lives at `.context/cross-platform-native-env/rootfs`.
Its installation/version recipe is `.context/cross-platform-native-environment.md`.
The VM denies user namespaces. `run-linux-env` uses a private mount/PID namespace
and an ephemeral setuid bwrap copy, preserving WebKit's sandbox. It requires
passwordless sudo, mount/PID namespaces, bwrap, GTK3, WebKitGTK4.1, GCC, libxdo,
AT-SPI client development files, Xvfb, D-Bus, Rust and the pinned Node26/CLI.
No host Docker daemon or broad host mount/process changes are needed.

The harness writes only `.context/library-desktop/` at runtime. Prepare a fresh
snapshot at `inputs/workspace` containing the actual `apps/desktop/package.json`,
`apps/desktop/src-tauri` (exclude generated `gen`/`target`), and full
`apps/web/dist`. Create empty mountpoints for root/desktop node_modules and
`scripts/testing/library-desktop`. Preserve a copy of the input Cargo.toml at
`inputs/candidate-Cargo.toml`; record SHA256 for all source/assets before build.
The currently tested snapshot and inventory are retained under this context.

The wrapper mounts inputs, installed JS dependencies and harness sources read-only.
Official CLI rewrites Cargo feature arrays even with no source feature change;
the approved writable overlay exists only at `target/source-upper/source-work`.
Use `--runtime` for runtime-only commands, avoiding this build overlay. Source
snapshots and tracked application files are never rewritten by the build.

## Build a normal release Debian package

Run from the repository root after the shared web build:

```sh
scripts/testing/library-desktop/run-linux-env /bin/bash \
  /research/inputs/workspace/scripts/testing/library-desktop/package-linux candidate
```

The script uses official CLI2.12.4, `build --bundles deb --ci -- --locked`, jobs2,
and the snapshot's pinned Rust dependency lock. It copies and extracts the
actual `.deb`, records package metadata/binary hashes and the CLI manifest delta.
The smoke target is the binary extracted from that package, not a bare Cargo
target. An existing artifact label or smoke profile is rejected.

## Shared UI and preference persistence

AT-SPI2.44.0 matches the prepared Ubuntu client libraries. Download and extract
the official matching daemon package within the proof directory if needed:

```sh
scripts/testing/library-desktop/run-linux-env --runtime /bin/bash -c \
  'cd /research/downloads && apt-get download at-spi2-core=2.44.0-3 && mkdir -p /research/tools/atspi && dpkg-deb -x at-spi2-core_2.44.0-3_amd64.deb /research/tools/atspi'

scripts/testing/library-desktop/run-linux-env --runtime /bin/bash \
  /research/inputs/workspace/scripts/testing/library-desktop/smoke-atspi \
  /research/artifacts/candidate-extracted/usr/bin/kitties-desktop \
  /research/logs/candidate-atspi candidate-atspi-01
```

The daemon runs on private session/accessibility buses, never the host user bus.
The helper is compiled with `-Wall -Wextra -Werror`. It reads actual accessibility
roles/text/selected states, focuses real controls and sends real X11 key events.
Save is an accessibility action on the actual shared form. The controller checks
independent on-disk version1/es/light JSON, terminates and relaunches the actual
package, and verifies restored UI values. Neither load nor preview writes defaults.
Screenshots await actual painted controls. Any assertion, deadline or cleanup
failure retains FAIL and a nonzero exit. Private namespace teardown bounds child
cleanup, including WebKit's descendants. Only owned process groups are signalled.

Outputs include result JSON, app/registry logs, accessible trees and screenshots.
This route proves no-config visible failure and preferences persistence. Raw
forbidden IPC coverage is the separate actual native Rust IPC suite.

## Actual development runtime

Start the normal web Vite server on localhost:5173 using the app configuration,
then run against the same immutable inputs and context-only build overlay:

```sh
scripts/testing/library-desktop/run-linux-env /bin/bash \
  /research/inputs/workspace/scripts/testing/library-desktop/smoke-dev \
  /research/logs/development-atspi development-atspi-01
```

This invokes official `tauri dev --no-watch -- --locked` twice. The controller
requires the live `/library.html`, `/@vite/client` and shared source entry, then
checks the actual window, fail-closed unconfigured sign-in, explicit preference
save and a new process reloading the saved record. It stops its dedicated CLI
process group, including the native child. Development and packaged results stay
separate; neither mode substitutes static assets for the development server.

## Local issuer gate and remaining limits

The accepted local HTTPS fixture uses explicit compiled origins
`https://app.kitties.test:9443` and `https://issuer.kitties.test:9443`; no release
endpoint defaults or production fixture flags exist. `run-linux-env --fixture`
binds only a private hosts file and normal CA bundle plus the temporary fixture
CA into its private namespace. It never modifies on-disk rootfs/host trust.
Official HTTP native-roots trust stays enabled; no TLS bypass is allowed.

`smoke-atspi ... <fresh-profile> auth` registers a real private MiniBrowser as
the session's default HTTP/HTTPS handler. Official native opener must launch it;
the browser performs the actual one-use loopback callback. No harness callback
injection is permitted. Accessible URL queries/fragments are redacted. Screenshots
must exclude browser authorization/callback address-bar queries. See the fixture
owner's handoff and `.context/library-desktop/LOCAL_HTTPS_FIXTURE.md` for its
control/evidence protocol; this gate is still local issuer evidence.

The auth route runs eleven cases, including a real committed response loss and
retry. Start a fresh fixture with Node 26 (`node
scripts/testing/library-desktop/fixture.mjs`) before running the auth route; its
ready event supplies public origins, control URL and CA path. The separate
loopback control listener accepts strict JSON without Origin or Fetch Metadata.
`dropNextCommandReply` accepts one public command tag and an `armMs` from 1 to
30000; it consumes one matching command and drops only a complete successful
receipt from the real backend. It buffers at most 32 KiB for at most ten seconds;
nonmatching, rejected and oversized responses pass through. Watches keep streaming.
The bounded evidence log records command IDs, input hashes and receipts, never
credentials or skill bodies. Numeric and string RPC IDs remain distinct.

The actual OS UI must show Unknown, retry the original intent despite a newly
edited draft, and receive the same receipt without another aggregate allocation.
The final `freeze` control invokes real RecoveryDO authority; a still-valid-token
command must receive correlated LibraryUnauthorized before aggregate send, with
its draft retained and mutation controls fenced. Consent denial does not prove
this command outcome. Freeze is terminal; use a fresh fixture for another run.
The controller records independent backend reads, receipts, screenshots and
cleanup. Stop only the identified fixture process with SIGTERM and retain its
engine/process-group finalizer evidence.

Official WebDriver is retained as an optional diagnostic (`smoke-linux`/`run.mjs`).
Pinned Wry0.57.1 drops Tauri's automation context on the incognito branch;
session creation fails in this environment. No Wry patch or non-incognito package
is required for the OS route. Diagnostic failure must never count as a passed
package gate. Details and pinned upstream responses are in the context notebook.

Linux packaged behavior does not prove real Cloudflare Access, external provider
settings/approval, Windows/macOS bundles or their default browser/trust behavior.
An idle-after-headers cancellation regression probe, when present, is maintained
separately and is not folded into the19-case native baseline or silently waived.
See [the strict stock-plugin probe](idle-body-probe.md) for the independent
reproduction and its intentionally failing cases.
