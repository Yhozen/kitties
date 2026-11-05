# Shared library browser check

Build the actual web assets, then run the maintained browser task:

```sh
pnpm --filter @kitties/web build
pnpm test:library-browser
pnpm test:library-browser development
```

Requirements: the pinned Node 26/pnpm toolchain, Linux workerd, OpenSSL and a
Chromium installation. The controller defaults to `/opt/google/chrome/chrome`;
set `KITTIES_BROWSER` to another compatible executable and `KITTIES_OPENSSL` to
an OpenSSL executable when needed. These overrides select local tools, not
application endpoints. The script creates its own short-lived TLS certificate.

The default check serves `apps/web/dist` over local HTTPS and proxies only library calls
to the maintained local native HTTP fixture. It uses the production Foldkit
entry, official Domain client and real local Durable Objects. Authentication is
the fixture's explicit loopback session, not Cloudflare Access. It does not
claim a deployed provider login or packaged WebKit proof.

The development mode loads the application's actual Vite configuration in
middleware mode on that local HTTPS listener, including the Foldkit plugin and
HMR. It serves source modules rather than dist. Assertions require the real
`/@vite/client` and Library TypeScript entry; production requires the Vite client
to be absent. Both modes run the same behavior cases. The short-lived test
credential is issued when the first session handshake is requested, so module
startup cannot consume its lifetime before the session under test exists.

Assertions cover startup without a preference write; proposal, acceptance,
receipt-gated detail and removal; a second tab observing changes; saved language
and theme across reload and Preact navigation; a narrow mobile viewport and
keyboard focus; and expiry/reconnect preserving an existing draft. Network
milestones have deadlines. Failed assertions are never retried.

Results, screenshots and host diagnostics are written under
`.context/library-browser-check/`; corresponding durable fixture state is under
`.context/library-http-check/browser-*`. Shutdown must exit normally, preserve
installed engine bytes, and leave no owned process group. Failure cleanup kills
only that fixture's process group. The separate `test:library-http` command
retains the currently failing idle-disconnect cleanup gates; a passing browser
check does not replace those assertions.
Development mode also closes its Vite server and Foldkit DevTools relay. A
targeted mutation that serves dist while claiming development fails the Vite
client assertion; original source bytes are restored before baseline checks.
