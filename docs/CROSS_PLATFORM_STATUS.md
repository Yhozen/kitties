# Cross-platform Library implementation evidence

The real skill-library slice runs through Alchemy Domain and the shared Foldkit
assets in Chromium and a normal release Tauri Debian package. Native preferences
survive process restart. A local HTTPS issuer proves the packaged system-browser
OAuth flow, commands, live views, expiry and reconnection. **The overall release
gate is incomplete:** live Cloudflare Access, prompt idle cancellation, complete
backup/reset/purge integration and other desktop platforms remain open. No merge,
deployment, production migration or provider configuration was performed.

## Review stack

Each draft targets the preceding branch; none is merged.

| PR | Change |
| --- | --- |
| [46](https://github.com/Yhozen/kitties/pull/46) | Concrete product, migration, security and verification plan |
| [47](https://github.com/Yhozen/kitties/pull/47) | Coordinated beta.85 dependencies and retained workflow patch |
| [49](https://github.com/Yhozen/kitties/pull/49) | Domain Library commands, invariants, projection and import lifecycle |
| [50](https://github.com/Yhozen/kitties/pull/50) | Narrow provider recovery hooks and strict request decoding |
| [51](https://github.com/Yhozen/kitties/pull/51) | Migration, turn snapshots and durable recovery journal |
| [52](https://github.com/Yhozen/kitties/pull/52) | Production native host, recovery coordinator and authenticated HTTP |
| [53](https://github.com/Yhozen/kitties/pull/53) | Shared Foldkit screen, connection lifecycle and device services |
| [54](https://github.com/Yhozen/kitties/pull/54) | Native host, packaged local-issuer proof, strict cancellation probe and operational gates |

The plan's real-provider proof has not passed; draft UI work
must not be interpreted as permission to release or enable cutover.

## Reproducible checks

Use Node 26, pnpm 12.16.1, Effect 4.1.1, Alchemy beta.85, Foldkit/UI 0.170.0
and the committed locks/patches. The Linux proof used Node 26.13.0, Rust 1.99.1,
Ubuntu 22.04 userland with WebKitGTK 4.1, official CLI/API 2.12.4, Tauri 2.12.5,
HTTP plugin 2.8.3 and opener 2.7.2. Rust MSRV is 1.90.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:coverage
pnpm build
pnpm --filter @kitties/kittyd check
pnpm test:library
pnpm test:library-bundle
pnpm test:library-browser
pnpm test:library-browser development
# Separate strict gates: currently nonzero on the pinned runtime/plugin.
pnpm test:library-http
```

The [desktop harness](../scripts/testing/library-desktop/README.md) documents the
actual package build and OS accessibility controls. The [idle-body probe](../scripts/testing/library-desktop/idle-body-probe.md)
has a fresh-copy Cargo recipe preserving its nonzero exit. A supported native
environment can run `cargo check --locked --tests` and `cargo test --locked` in
`apps/desktop/src-tauri`; the Linux filesystem tests run as a non-root user.

Runtime fixtures bind loopback, use isolated state and ephemeral local credentials,
and preserve production protocol/module behavior. The issuer's consent page uses
origin-only referrers so WebKit submits the exact issuer Origin without leaking
query parameters; other pages use no-referrer. Strict Origin, one-use code,
resource, state and PKCE checks remain. Fixtures do not mount in the application.

## Evidence matrix

| Boundary | Observed result and scope |
| --- | --- |
| Exact backend snapshot | Frozen install, Vite+ check, 225 tests in 20 files; 12 native recovery/Home cases and four local Worker bundles pass. |
| Exact shared-client snapshot | Frozen install, Vite+ check, 324 tests in 31 files with coverage floors; all three recursive builds pass. |
| Complete repository | Frozen install and Vite+ formatting/lint/types pass with 0 errors and 629 advisory warnings; all 329 tests in 32 files pass with coverage floors intact; all three recursive builds and guest typecheck pass. |
| Native crate | 19 actual tests pass: fixed Store/ACL, public OAuth callback protocol, exact HTTP scopes, redirects/cookies and cancellation before headers. |
| Browser production and development | Five cases pass in each mode; development requires the actual Vite client and source entry. Cases cover commands and source barriers, another tab's live view, acknowledged Preact/Foldkit preferences, mobile/keyboard and expiry/reconnect. |
| Packaged Linux, no configuration | Four cases pass: shared UI, fail-closed sign-in, es/light native save and a new process loading the record. |
| Tauri development | Five cases pass using official CLI `dev --no-watch`, real Vite, stock incognito/CSP, native preferences and a new process. |
| Packaged Linux, local issuer | Eleven cases pass: real external browser Deny/Allow and loopback callback, native trust/handshake, proposal/review/accept/remove, peer catalogue and selected-detail updates, expiry, same-authority reauthentication, credentials absent after relaunch, committed response loss with stable-intent retry, and valid-token Domain command denial. |
| Workerd prompt idle abort | Two strict failures remain. A plain-JS control sees no abort/cancel until a body chunk is written. Absolute expiry passes separately. |
| Native plugin prompt idle-body cancel | Stock 2.8.3: one control passes, two strict regressions fail. Resource-table removal does not settle a pending read or close its socket until output/EOF. |
| Platform CI | The original macOS, Windows and Linux `cargo check --locked --tests` matrix passed; Linux also ran native tests. The expanded executable-build and native-test matrix for all three is pending. |
| Real Access / other OS GUI runtime | Not proven; Linux runtime evidence does not establish macOS/Windows runtime or signing. |

The package proof uses the actual extracted Debian binary, shipped incognito
configuration and unchanged built assets. Pinned Wry loses WebDriver automation
when creating the ephemeral context; the official WebDriver attempt failed and
remains recorded. OS accessibility/keyboard input proves the real app instead.
No framework patch, alternate UI, injected Tauri global or disabled sandbox is used.

The packaged continuation observes the actual official client's numeric RPC IDs
and nullable command replies. A one-shot fixture drops a response only after its
real successful receipt is recorded. The UI reports Unknown; retry preserves the
original command ID and input digest, returns the same version 7 receipt, and
leaves independently inspected high-water/revision values unchanged. A separate
valid-token command after a real recovery freeze returns LibraryUnauthorized,
retains the draft, fences mutation controls and never reaches aggregate send.
These observations establish packaged behavior against the explicit local issuer.
The fixture's 12 tests and five targeted reply-loss mutants also pass.

An isolated candidate fix for the HTTP plugin settles the pending read and closes
the socket before server output; its three strict cases and all 19 existing native
cases pass. It is **not installed**. The published-package constraint remains;
the candidate diff and stock control are review artifacts, not a vendored runtime.

## Artifacts and local receipts

Evidence lives in gitignored `.context/`; commands above recreate it. Key runs:

- Backend exact tree: `.context/library-runtime-review-{install,check,tests,native,bundles}.log`;
  native results under `library-runtime-review/.context/library-check/all-1793845556189-a37f760a/`.
- Shared client exact tree: `.context/library-client-review-{install,check,coverage,build,browser}.log`;
  browser results/screenshots under `library-client-review/.context/library-browser-check/1793845869684-f746d601/`.
- Complete repository: `.context/library-complete-{install,check,coverage,build,guest-check}.log`.
- No-config release: `.context/library-desktop/logs/candidate-atspi/result.json`.
  `candidate.deb` SHA256 `64f3e8e575294be5b7499e583929e5054c7187601d74e383979a6604d5361149`.
- Explicit local-issuer release: `.context/library-desktop/logs/packaged-unknown-denied-1/result.json`;
  `fixture-shutdown.json` confirms engine identity and owned process-group cleanup.
  `local-fixture.deb` SHA256 `16d5ad0c722a70da720aebf53de40ade45cec5de197ebdf5e475e5f692cb3383`;
  extracted binary `449382845c8eab7d7529e9ce1d76f6c5280458ef1400ecdcafd9181ed8d85581`.
- Development: browser `.context/library-browser-check/1793846586198-240171a4/results.json`;
  Tauri `.context/library-desktop/logs/development-atspi-3/result.json`.
  Production browser follow-up: `.context/library-browser-check/1793846641532-7490576c/results.json`.
- Continuation integrity/commands: `.context/library-desktop/CONTINUATION.md` and
  `logs/continuation-integrity.json`; unchanged package binary and all 42 snapshot inputs.
  Fixture protocol/native proof: `local-fixture/REPLY_LOSS_HANDOFF.md` and
  `reply-loss-native-proof.json` (six cases).
- Stock/candidate cancellation: `.context/native-http-cancel-probe.md`,
  `.context/native-http-cancel-candidate/`, `.context/native-http-cancel-promotion/evidence/`.
- Mutation logs cover Domain, migration/recovery, snapshot coherence, leaf/host,
  connection classification/lifecycle, device/native ACL and fixture OAuth.
  Each targeted bug failed an independent assertion and original bytes were restored.

The packaged Library JavaScript SHA256 is
`4a2f4d2a1e6d688c408c774ebb97ff4ca06bf467e1e13d20e301f294602d576e`;
`library.html` is `fc1572e738185775cc20aa1d167a9247869f7c8df1b424a69b9006729db004b4`.
The isolated client build reproduces both exactly.

## Requirements still incomplete

`KITTIES_LIBRARY_CUTOVER_ENABLED` remains false. Local sealed-set restore preserves
raw receipts, projections, pending delivery and allocator floors, but retained
export upload/retention, owner reset and purge do not cover every Domain store.
Arbitrary independent per-object PITR is unsupported. An old Worker that reopens
legacy writes is not a safe rollback after new Domain writes.

Live Cloudflare Managed OAuth requires the reviewed existing-application change
in [staging authentication](LIBRARY_STAGING_AUTH.md), an explicitly authorized
staging deployment/migration and owner browser sign-in. Current public metadata
redirects to login. Local issuer success is not proof of that provider contract.
No external change is authorized by these tests or draft PRs.

Both idle cancellation gates remain blocking. Packaged ChangedAuthority cutover
is not claimed; that behavior is proven at deterministic official client/Domain
boundaries. Pending intents
are memory-only; there is no offline queue or restart intent recovery. Signed
distribution, macOS/Windows packages and platform-specific browser/trust behavior
remain unverified.
