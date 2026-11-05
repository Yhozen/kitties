# DevicePreferences

Consumers require only `DevicePreferences`: `load` returns validated
`Option<Preferences>`; `save(record)` returns only after persistence is
acknowledged. The strict full record is `{ version: 1, language: en|es|pt,
theme: system|light|dark }`. Absence is None; malformed data, unavailable storage
and native timeout are typed failures. Errors contain no raw persisted content.
No credentials, business state or pending commands belong in this capability.

Composition selects `DevicePreferences.browser.layerBrowser` or
`DevicePreferences.tauri.layerTauri`. Tests use `DevicePreferences.test-layer.layerMemory()`
or the narrow browser/native ports. The browser adapter has no native dependency.
`preferencesOrDefaults` is an explicit, non-writing consumer choice;
preserve the current dark default and existing browser language detection.

The browser uses one key, `kitties.device-preferences.v1`, with a 512 UTF-8 byte
load bound. Native invokes only `read_device_preferences` and
`write_device_preferences`. Its five-second Effect boundary stops waiting but
cannot cancel filesystem work already started; timeout is an unknown outcome.
Reload/reconcile before retrying. There is no automatic background retry.

## Browser migration and Preact coexistence

Both screens now use the same canonical record through DevicePreferences.
Bootstrap and prepaint are read-only. A valid canonical record wins; absence
uses validated old `kitties.lang` and `kitties.ui.theme` values as compatibility
defaults, then navigator language/en and dark. Invalid old values also fall back
to those defaults. No bootstrap migration writes or removes either old key.

The Foldkit host exposes canonical load errors while allowing a preview of
defaults. Its explicit Save acknowledges a complete record. Preact's language
and theme controls reload the canonical record before changing one field, retain
the other field, and refuse a corrupt canonical record. Language reloads the
page only after acknowledgement; theme applies only after acknowledgement.
`applyMode` and prepaint do not persist. Existing Preact `?lang`/`?theme` visit
overrides remain temporary. Cross-tab live preference synchronization is not
implemented; a reload or normal navigation reads the saved record.

## Tests

`pnpm test --project device`: 29 tests, including 14 preference tests, using
root assertion policy, Layers, TestClock and named ports; no module mocks/live
services/sleeps. Promoted mutants
removing browser persistence, removing its byte bound and acknowledging native
save before the commit all fail assertions. Each original is restored with an
exact SHA256 check; receipts are under `.context/cross-platform-device/evidence/`.

Native commands and generated-ACL tests live in the desktop crate. The maintained
browser harness proves shared preference saves across Preact/Foldkit navigation.
The separate packaged Linux harness proves native save and process relaunch.
Signing and real provider authentication remain separate gates.
