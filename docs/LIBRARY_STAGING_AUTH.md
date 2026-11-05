# Staging native authentication gate

The desktop authentication implementation has deterministic provider/IPC tests.
It has not authenticated against Cloudflare Access Managed OAuth. Public discovery
at `https://next.kitties.rccpr.tech/.well-known/oauth-authorization-server` returned
HTTP 302 to the Access login on 2026-11-05. That response is refused by the native
client; it is not valid OAuth metadata. No Access setting was changed.

The following is the proposed change to the existing Access application protecting
`next.kitties.rccpr.tech`, subject to the owner's explicit external-change approval.
Keep its identity, domains, allow policy, issuer and audience. Do not create a
parallel application or add a bypass policy.

```json
{
  "oauth_configuration": {
    "enabled": true,
    "dynamic_client_registration": {
      "enabled": true,
      "allow_any_on_localhost": false,
      "allow_any_on_loopback": true,
      "allowed_uris": []
    },
    "grant": {
      "access_token_lifetime": "5m",
      "session_duration": "24h"
    }
  }
}
```

This is a field patch, **not a complete PUT body**. Before applying it, fetch the
current application with Access Apps and Policies Read permission, confirm the
protected domain and existing owner policy, and prepare a complete replacement
that preserves every unrelated field. Applying it requires Access Apps and
Policies Write permission. Keep the original configuration for rollback. The
loopback setting allows dynamically allocated `127.0.0.1` callback ports; the
native listener uses a random `/oauth/callback/<nonce>` path, checks state, and
accepts one response.
No localhost wildcard, custom URI scheme or production application bypass is
needed. Existing non-browser 302 behavior changes to OAuth-aware 401 behavior,
which must be included in the approval review.

Reference: [Cloudflare Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/),
settings and authorization-flow sections inspected 2026-11-05. Recheck the current
API schema before any remote write; this feature is beta.

## Proposed packaged build

After metadata is enabled and independently verified, compile with:

```sh
KITTIES_DESKTOP_APPLICATION=https://next.kitties.rccpr.tech \
KITTIES_DESKTOP_ISSUER=https://misty-sky-3199.cloudflareaccess.com \
pnpm --filter @kitties/desktop package
```

These are canonical HTTPS origins, with no trailing slash. They are compiled
inputs, not editable application preferences. The exact issuer is the existing
gateway default and must match the published metadata byte-for-byte. Mismatch
must stop the test rather than loosen validation. Missing configuration keeps the
local preference screen available and makes library connection unavailable.

The client requires public authorization-code registration, `none` token endpoint
authentication, S256 PKCE and the configured RFC 8707 resource. It validates all
metadata endpoints against the application and issuer origins. It refuses secrets,
redirects, substituted resources and an invalid callback. Refresh tokens are not
retained; expiration requires a new interactive login. No token is saved in Store,
localStorage, URLs, Models, Messages or logs.

## Execution and evidence still required

1. Review the exact existing-application configuration diff and obtain approval
   before enabling Managed OAuth. Requesting a person to complete the system-browser
   login is a separate interactive step; automated local test issuers do not prove it.
2. Verify metadata over HTTPS without redirects and a public-client registration.
   Retain only safe endpoint/configuration observations, never token responses or
   callback URLs containing authorization codes.
3. With an explicitly authorized staging deployment and migration, open the actual
   packaged incognito application, sign in, propose and accept a test skill, and
   observe the same state in a browser session. The current implementation task has
   **not authorized that deployment or migration**.
4. Verify wrong-owner denial, typed business rejection, live updates, absolute
   expiry, retained pending intent and same-authority reconnection. Restart the app:
   language/theme must persist and credentials must require sign-in again.
5. Verify the native credential is opaque and the gateway accepts only Access's
   signed forwarded assertion with the expected audience/owner. A locally signed
   fixture cannot establish that forwarding contract.

Do not enable `KITTIES_LIBRARY_CUTOVER_ENABLED` until the export/retention/reset/
purge gaps and the idle-stream abort gate in the implementation report are closed.
The current local sealed-set restoration proof does not cover arbitrary independent
PITR or a production cutover. This document prepares reviewable configuration and
execution steps; it records no external approval or successful provider login.
