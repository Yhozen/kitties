# Alchemy beta.84 with Effect 4.1

The published Alchemy package imports the removed `effect/Crypto` entrypoint. This pnpm patch
uses the Effect 4.1 SecureRandom and Digest services for OAuth state and PKCE and supplies their
WebCrypto layers in the Node/Bun platform service layer. It updates source, emitted JS and
declarations. It does not alter workflow replay or persistence.

`apps/gateway/src/alchemy-compat.test.ts` verifies fresh state, verifier format and the exact S256
challenge. Run the deployed Phase 3 engine suite before changing this patch or upgrading pins.
