# Shared Library client

`/library.html` boots the Foldkit screen independently of the existing Preact
application. Workspace navigation links to it and preserves the file library.
The same built entry is selected by the desktop host. Domain owns all business
transitions; the UI holds drafts, command IDs, receipts and subscription state.

The leaf uses `DomainFoldkit.make(LibraryApi)`, official command IDs and watches.
A logical operation retains its ID and encoded input through Unknown retry.
Success records a receipt and reads details at its source barrier. Review of an
existing row waits for that row's detail revision, including delayed projection
delivery. Accepted state is never inferred from a local edit or optimistic flag.
Pending intents are memory-only: process restart does not restore them.

The parent host uses Foldkit child composition and lifted subscriptions. It
loads preferences without writing defaults, explicitly saves a complete record,
waits for the persistence acknowledgement, and freezes edits/duplicate saves
while waiting. Language changes preserve the child's pending operation and
receipt. English, Spanish and Portuguese expose accessible controls, errors and
status; styles support narrow layouts and system/light/dark themes.

## Connection and credentials

`LibraryConnection` constructs the official HTTP client inside a scoped
generation. Handshake supplies owner, epoch and expiry; none is inferred from a
token. Reauthentication requires the same owner/epoch and replaces the scoped
client and watches. ChangedAuthority is terminal and cannot adopt old intents.
Late messages from an old generation cannot clear a draft or update current state.

Closing a generation while a sent command awaits its reply produces Unknown,
allowing retry of the same intent. Genuine caller interruption remains cancelled.
An error arriving after local expiry keeps its actual classification; elapsed
time cannot turn an uncertain server outcome into Denied. Explicit browser
401/403 or the narrowly validated native Denied error maps to authentication
failure. Other native errors and HTTP 503 remain Unavailable/Unknown.

Browser transport uses same-origin credentials, refuses redirects and obtains a
new-tab sign-in URL from the fixed same-origin entry. Native composition uses
official `isTauri` and the device NativeAccess/HttpClient Layer. Missing compiled
native configuration fails closed while independent preferences remain usable.
Tokens stay outside Models, Messages, DevTools and persisted preferences.

## Preferences and existing application

DevicePreferences exposes one validated versioned language/theme record through
browser, native and test Layers. Preact now uses the same browser record as
Foldkit. A single-field edit reloads the saved record and retains its other field;
canonical corruption refuses saving. Old keys provide compatibility defaults
only. Bootstrap and prepaint do not write. Explicit language saves retain the
existing page reload; cross-tab live preference synchronization is not provided.

## Verification and limits

```sh
pnpm check
pnpm test --project web --project device
pnpm --filter @kitties/web build
pnpm test:library-browser
```

Story/Scene tests exercise visible outcomes, frozen retries, stale events, null
detail failures, preference acknowledgements and language changes during pending
work. Real in-process Domain tests prove receipt barriers with held delivery.
Connection tests use the official HTTP client/server and commit before withholding
a reply, then replace the generation and retry the original intent: one allocation
and the original receipt survive. Native adapter composition tests distinguish
Denial from transport uncertainty and assert that safe errors contain no secrets.
Targeted mutants were rejected and restored byte-for-byte.

The maintained browser harness serves actual built assets over local HTTPS and
uses real local Durable Objects. It passes proposal/accept/remove, another tab's
live view, Preact/Foldkit preference roundtrip, mobile/keyboard layout and session
expiry/reconnect. It uses explicit fixture authentication, not Cloudflare Access.
Packaged WebKit, real system-browser OAuth and native IPC require the separate
desktop harness. Known workerd and native-plugin idle-disconnect failures remain
release gates; neither passing UI checks nor absolute expiry proves prompt cleanup.
