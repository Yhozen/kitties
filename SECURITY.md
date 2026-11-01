# Security policy

The supported application is the current Cloudflare Effect deployment and PWA. Legacy native
binaries are retired. Cloudflare Access limits owner routes; the Worker verifies identity and
same-origin writes. Secrets use AES-GCM envelopes. Guest commands are fenced by identity,
generation and epoch. Encrypted exports have a 30-day lock and a Mac escrow copy of the KEK.

Report vulnerabilities privately through the repository's GitHub Security → Report a vulnerability
channel. Do not include live credentials in public issues. See [recovery](docs/effect/RECOVERY.md)
and [deployment permissions](docs/DEPLOY.md) for operational controls.
