# Security policy

The supported application is the current Cloudflare Effect deployment and web client. Legacy native
binaries are retired. Cloudflare Access limits owner routes; the Worker verifies identity and
same-origin writes. Secrets use AES-GCM envelopes. Guest commands are fenced by identity,
generation and epoch. Encrypted exports have a 30-day lock and a Mac escrow copy of the KEK.

Report vulnerabilities privately through the repository's GitHub Security → Report a vulnerability
channel. Do not include live credentials in public issues. See [recovery](docs/effect/RECOVERY.md)
and [deployment permissions](docs/DEPLOY.md) for operational controls.

CI runs the production dependency audit, secret-history scan and guest shell checks. CodeQL runs
on public repositories or when a licensed private repository sets `ENABLE_CODEQL=true`. GitHub
dependency review is unavailable on this private repository; the supported pnpm audit is the
dependency vulnerability gate.
