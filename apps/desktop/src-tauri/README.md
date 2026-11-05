# Minimal shared desktop host

One local `main` window targets `library.html` from `../../web/dist`; development
uses localhost:5173. The host contains no second UI or library business logic.
The incognito webview avoids persistent HTTP cookies/web storage; explicit native
preferences remain in the dedicated Store file. Production CSP allows local
assets and IPC only; dev CSP separately permits Vite injection/HMR on the fixed
local origin. The shared Foldkit entry selects native preferences and HTTP/auth
Layers through official Tauri runtime detection.

`build.rs` enumerates the preference and authentication application commands to
enable custom-command ACL checks. `main-preferences` grants only the fixed
read/write permissions to local `main`; authentication has its own capability.
There is no remote capability, broad core permission or direct Store grant.
Generated permissions/schemas are ignored and regenerated on every clean build.

Rust pins: tauri2.12.5, tauri-build2.7.4, Store2.5.0, serde1.0.228,
serde_json1.0.145. Cargo.lock pins the resolved closure. Minimum Rust1.90 follows
the actual Tauri crate manifests; Linux checks used Rust/Cargo1.99.1 on Ubuntu
22.04 with WebKitGTK4.1/GTK3, not the Amazon Linux host's libraries.

## Preferences boundary

The only file is `device-preferences.v1.json` in app data, containing only the
fixed preferences key. Language/theme/version and the 512-byte deserialization
bound are validated. No frontend path/key API or auth/pending-operation storage
exists. Operations serialize through PreferencesGate and offload blocking disk
work. Corruption remains an explicit error and never silently resets defaults.

Store2.5.0 ignores its first load error; commands perform a checked replacement
reload (`reload_ignore_defaults`). Autosave is disabled and success requires
explicit save. Every command path calls `close_resource`, including failures:
the official Store plugin would otherwise save registered caches on app exit.
A failed write discards unsaved cache instead of scheduling an exit-time retry.
Store uses ordinary `fs::write`; acknowledgement is not fsync/atomic replacement
or power-loss durability. A corrupt file requires an explicit future repair
flow. The official plugin reads a whole file before the deserializer's bound;
this is not a sandbox against a local user replacing their own app-data file.

## Verification

Normal supported-platform commands from this directory:

```sh
cargo check --locked --tests
cargo test --locked
```

Run filesystem permission tests as a non-root user. The cloud VM's prepared
Ubuntu environment supports the actual crate through private namespaces:

```sh
.context/cross-platform-device/native/run-desktop-cargo /bin/bash /research/native/test-desktop-native
```

The wrapper binds only this crate writable, built web assets read-only and the
existing task cache writable; its Ubuntu rootfs remains read-only. It uses two
Cargo jobs and no development debug symbols. Eight native tests pass: strict
codec, real Store/filesystem absence/roundtrip/corruption/I/O/save-denial/cache
cleanup, plus actual IPC through the generated host ACL. The IPC tests use
Tauri's official MockRuntime and the same builder registration as the host.
They prove main-window allow and remote/ungranted/direct-Store denial without
an allow-all fixture ACL.

These eight preference tests are part of the current 19-test native executable.
Compile/in-process evidence is separate from packaged verification. The maintained
[Linux harness](../../../scripts/testing/library-desktop/README.md) exercises an
actual release Debian package with the shared frontend, incognito WebKit and OS
accessibility controls. Its no-configuration, save and process-relaunch cases pass.
Provider login, signing and macOS/Windows runtime require their own evidence.

Three promoted native mutants are rejected by runtime assertions: removing the
explicit Store save leaves the independently read file absent; omitting
close_resource leaves the Store registered; broadening the capability window
to `*` makes the ungranted-window denial test receive a successful absent reply.
Original files were restored exactly in finally blocks (SHA256 recorded in
`.context/cross-platform-device/evidence/promoted-mutations-rust.json`). The
full eight-test baseline is rerun after restoration. No dependency/framework
source is a mutation target.

The existing web icon SVG is the source for desktop icons. PNG was rasterized
with distribution librsvg; ICO/ICNS were generated with the installed official
Tauri CLI2.12.4. These formats enable host packaging inputs, not a claim that
Windows/macOS were built or run.

## Native managed Access boundary

`native_access.rs` owns public-client OAuth only: application discovery, exact
expected issuer, HTTPS endpoint trust, public dynamic registration, S256 PKCE,
state and RFC8707 resource binding, one-use `127.0.0.1` callback, and cancellation.
It does not create a client secret or retain refresh tokens. The listener and
pending provider work have a 180-second deadline; each provider HTTP request has
a 10-second deadline and a 32KiB response limit. Callback reads are bounded to
8KiB/3seconds. All failures serialize only the four safe reason names; callback
pages never echo query/provider content. No OAuth data is logged or persisted.

Build with BOTH `KITTIES_DESKTOP_APPLICATION` and `KITTIES_DESKTOP_ISSUER` set to
canonical HTTPS origins (no slash/path/query/credentials/wildcards). There are no
production endpoint defaults. Without configuration, preferences still work and
authentication returns `Configuration`. The frontend must present a disabled
Library connection in that case. Changing either variable requires rebuilding.
The rootfs wrapper clears inherited environment; pass explicit build variables
inside the chroot command when an approved test configuration is available.

HTTP plugin2.8.3 is pinned with default features disabled and only `rustls-tls-native-roots`,
`http2`, `json`; its default cookie persistence and request tracing are absent.
TLS uses the operating system's trusted roots. The local HTTPS runtime proof
adds its temporary CA only to a private namespace, without disabling validation.
`plugins.http.scopeRedirects` is true. The TS adapter sets maxRedirections0.
The runtime adds an official Tauri HTTP capability for only the configured
application's `/v1/library/session`, `/v1/library/rpc`, `/v1/library/rpc/` paths.
Plugin2.8.3 otherwise treats absent search/hash scopes as wildcard, so explicit
nonempty query/fragment deny patterns are also required and tested by raw IPC.
The main local window alone has auth commands. The pinned opener2.7.2 has no
public JS grants and no automatic link-opening script; Rust opens only the
validated, internally constructed authorization URL. Remote/ungranted windows,
arbitrary opener targets and Store operations remain denied.

Native tests now include real generated-ACL HTTP IPC, loopback NDJSON, refusal of
redirects, non-replay of Set-Cookie, and cancellation with withheld headers. The
OAuth protocol test exercises a real one-use callback listener against a local
provider port, with real random state/verifier, S256 and form validation. Other
tests cover substitution, denied state, confidential clients, expiry metadata,
cancellation/duplicate claims and a virtual-clock deadline. All earlier
preference persistence/error/cleanup tests remain in the same executable.

These are native crate/IPC tests, not packaged WebView verification. Withheld-header
cancellation passes, but the stock plugin's pending body read retains the response
and socket after cancellation. The separate
[strict idle-body probe](../../../scripts/testing/library-desktop/idle-body-probe.md)
records one control pass and two regression failures; it is not part of the
19-test passing baseline. No candidate provider patch is installed.
Live Cloudflare Managed OAuth additionally needs authorized staging application
configuration (Managed OAuth enabled, dynamic public registration, loopback
redirect scope, short access-token lifetime), exact issuer confirmation and an
interactive owner sign-in. The public staging metadata currently redirects to
Access login. No provider settings, deployment or production state were changed.
