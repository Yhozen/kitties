# Native Access boundary

`NativeRuntime` re-exports official `isTauri`; use it only at runtime composition.
`NativeAccess.tauri.layerTauriNativeAccess` provides `effect/http`'s `HttpClient`
and `NativeAccessAuthentication`. Construction can fail with `NativeAccessError`;
missing compiled configuration is `Configuration`. Compose preferences separately
and catch this layer error into a disabled Library transport. There is no browser
network fallback.

`NativeAccessAuthentication` exposes validated public `configuration`, `authenticate`
and `clear`. Its failure reasons are exactly `Denied`, `Unavailable`, `Cancelled`
and `Configuration`. An HTTP refusal is a normal `HttpClientError` whose transport
cause is this safe error; raw provider/IPC errors are discarded. Authentication
opens the system browser through Rust, receives a single-use loopback callback,
and keeps the resulting access token only in a private Redacted service closure.
No token getter, refresh token, cookie, Store record or feature Model is involved.
Closing the Layer scope, clearing, replacement, denial or expiry aborts existing
request signals. A late HTTP/token response cannot revive cleared credentials.

The official HTTP plugin supplies response streaming. The adapter forwards
cancellation, but plugin 2.8.3 retains a pending post-header body read/socket
until output or EOF. The separate desktop idle-body probe keeps this failing
cleanup gate visible; local AbortSignal tests do not prove native teardown. Bearer
injection happens inside the private Fetch boundary, after Effect's request and
tracing objects are built. The service permits exactly GET `/v1/library/session`
and POST `/v1/library/rpc` or `/v1/library/rpc/` at its configured HTTPS origin.
It rejects caller credentials, queries, fragments, redirects and endpoint
substitution. The native ACL independently permits those exact three paths and
denies nonempty queries/fragments. Plugin cookies and tracing are disabled at
Cargo feature selection; redirect scope checks are enabled. `NativeAccessTimeouts`
is a Context reference for connection and cancellation acknowledgement budgets.

Root composition owns Domain HTTP clients and Library session lifetime. After
`authenticate`, verify the new session's owner/epoch against the previous scope,
then replace the scoped Domain client and watches. A fresh token alone does not
restart a terminated watch. No authenticated owner/epoch/session is inferred from
OAuth's opaque token. Pending command identities remain the feature's concern.

`NativeAccess.native` contains narrow OAuth/HTTP ports for deterministic tests.
`NativeAccess.test.ts` runs under the root device project with the repository's
assertion policies. Tests use Deferred gates and TestClock, with no module mocks,
provider calls or sleeps. Native IPC tests in the desktop crate prove the official
plugin and ACL separately. Their local OAuth provider port and synthetic tokens
are fixtures; they do not establish Cloudflare Managed OAuth compatibility.
