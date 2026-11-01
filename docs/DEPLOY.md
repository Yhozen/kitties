# Running the gateway as a server

The gateway is one binary with the web interface inside. On your laptop it needs nothing; on a
server it is the page you open from anywhere, so it asks for a token and is meant to sit behind
https. Three ways to run it, from the quickest.

## What you need to know first

- **The token is the password.** The gateway prints one when it starts (and keeps it in its
  data folder); set your own with `KITTIES_TOKEN`. On a network the page asks for it once and
  trades it for a session cookie (`HttpOnly`, `SameSite=Strict`, `Secure` on https): the browser
  never keeps the token. *Sign out* in the sidebar ends the session.
- **Ten wrong tokens from one address within a minute lock that address out** until the minute passes.
- **The kitties' containers need Docker on the same machine.** Each kitty runs in a container
  the gateway starts through Docker. That access is root on the host: do not expose the gateway
  without the token and https. Without Docker the kitties still run, brain-only.
- **The gateway never hands its token out to a network peer.** `/v1/local-token` answers only
  to a browser on the same machine, and not at all behind a proxy or with `local_token: false`.
- **Models and connectors are set from the page**, once signed in. Provider keys can also come
  from the environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`...).

The settings that matter, as environment variables (they override the `gateway` block of the
configuration file, and no file is needed):

| Variable | What it does |
| --- | --- |
| `KITTIES_TOKEN` | the token; empty generates one |
| `KITTIES_LISTEN` | the address to listen on (`0.0.0.0:7488` for the network, `127.0.0.1:7488` behind a proxy on the same machine) |
| `KITTIES_PUBLIC_URL` | where the page is reached from (`https://kitties.example.com`): OAuth redirects, links in notifications, and the origin the session accepts |
| `KITTIES_TRUST_PROXY` | `true` when a reverse proxy in front sets `X-Forwarded-*` (the sign-in limit then counts real client addresses) |
| `KITTIES_DATA_DIR` | where the state lives: kitties, chats, memory, goals, approvals, the workspaces |
| `KITTIES_CONFIG` | a configuration file, when you want one |

TLS can also end in the gateway itself (`gateway.tls_cert` and `gateway.tls_key` in the file),
without a proxy.

## 1. Docker Compose with Caddy (https included)

Needs Docker and a domain whose DNS points at the server. Caddy gets and renews the certificate.

```sh
git clone https://github.com/madkoding/kitties && cd kitties
sudo install -d -o 10001 /var/lib/kitties          # the gateway's state, owned by its user
cp deploy/.env.example deploy/.env                  # set KITTIES_DOMAIN, KITTIES_TOKEN and your keys
stat -c %g /var/run/docker.sock                     # put that number in DOCKER_GID
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

Open `https://<your domain>` and sign in with the token. The image is
`ghcr.io/madkoding/kitties` (published with each release); build it yourself with
`docker build -f docker/gateway/Dockerfile -t kitties .`.

The data folder is mounted at the same path inside and outside the container on purpose: the
kitties' containers mount their workspaces by host path.

## 2. A binary and systemd

The quick way is the installer (`curl -fsSL .../scripts/install.sh | sudo sh`,
[INSTALL.md](INSTALL.md#on-a-linux-server-one-line)); by hand:

```sh
sudo useradd --system --create-home --home-dir /var/lib/kitties --groups docker kitties
sudo install -m 0755 kitties-linux-amd64 /usr/local/bin/kitties    # from the release page
sudo install -d -m 0750 -o kitties /etc/kitties
sudo install -m 0600 -o kitties deploy/kitties.env.example /etc/kitties/kitties.env   # edit it
sudo cp deploy/kitties.service /etc/systemd/system/
sudo systemctl enable --now kitties
journalctl -u kitties -f
```

The unit runs as its own user with a read-only system and only its state folder writable. Put
nginx (`deploy/nginx.conf`) or Caddy in front for https: keep `KITTIES_LISTEN=127.0.0.1:7488`
and set `KITTIES_PUBLIC_URL`.

Caddy in front of a binary:

```
kitties.example.com {
	reverse_proxy 127.0.0.1:7488 {
		flush_interval -1
	}
}
```

## 3. Behind another proxy

Whatever it is, three things matter: pass `Host` and `X-Forwarded-*`, set
`KITTIES_TRUST_PROXY=true` and `KITTIES_PUBLIC_URL`, and do not buffer
`GET /v1/chats/{id}/events`, the server-sent events stream (nginx: `proxy_buffering off`;
Caddy: `flush_interval -1`). `deploy/nginx.conf` is a complete example.

## Updating and backing up

- Update by hand: `docker compose pull && docker compose up -d`, or replace the binary and
  `systemctl restart kitties`. State is kept in the data folder across versions.
- Update by itself, in a container: `docker compose --profile autoupdate up -d` also runs
  Watchtower, which looks at the registry on a schedule (`KITTIES_UPDATE_CRON`, 03:00 by default)
  and recreates the gateway when a newer image is out. It touches only the gateway (it has the
  label); the kitties' desktops are updated by the gateway itself (below).
- Update by itself, as a binary: Kitties looks at its own releases on GitHub (`updates:` in the
  configuration). `gateway: notify` (the default) tells you, through your notifications and from
  Settings, Preferences, where **Update and restart** installs it; `gateway: auto` installs it by
  itself. It downloads the file for this system, checks it against the release's `SHA256SUMS`, runs
  it once to see it is the version it claims to be, keeps the old one as `<name>.prev` and restarts
  into it (same process id, so a supervisor follows it), only when no kitty is working and no
  desktop is held, and inside `updates.window` ("02:00-06:00", the server's clock) when there is one.
  The desktops of the kitties keep running across the restart. If the new version is started again
  before it has stayed up for three minutes (it crashed, or hung and was restarted), that start goes
  back to `<name>.prev`, keeps the failed binary as `<name>.failed`, tells you, and does not offer
  that version again (a newer one is offered); a supervisor that restarts a crashed program
  (systemd `Restart=always`, a container's restart policy) is what brings the failed start back for
  this to see it. It does not replace a development
  build, a program in a container (that is the image's update), the one inside the Kitties app (its
  bundle is signed), one it cannot write next to, or anything on Windows: it says so and how to
  update instead. `updates.gateway: off` stops it looking.
- Who made a release: a checksum shows a file arrived whole, not who made it, so releases are
  **signed**. `kitties release-key` makes an Ed25519 key pair: keep the private key as the repository
  secret `KITTIES_SIGNING_KEY` and the public key as the repository variable `KITTIES_UPDATE_PUBKEY`
  (it is built into the binaries) or set it as `updates.public_key`. The release pipeline signs
  `SHA256SUMS` (`SHA256SUMS.sig`, checked against the public key before it is published); a gateway
  that holds the key installs nothing whose checksums are not signed by it, and `gateway: auto`
  needs the key. Without one, the update from Settings is only checksummed and the page says so.
- The desktops: with `containers.auto_update` (on), the gateway pulls the desktop image every
  `containers.update_check_hours` and makes each idle desktop anew with its sessions kept (see
  [how a kitty uses its desktop](DESKTOP.md)); it also waits for `updates.window`.
- Back up the data folder (`settings.json` holds the keys and the signed-in tokens: keep the
  backup as private as the server). Each kitty's workspace is under `work/`.
- The kitties' containers survive a gateway restart; the watchdog brings back any that stopped.

## Keeping the repository itself safe

- Actions are pinned to a commit, with the version as a comment; Dependabot proposes the updates
  weekly (actions, Go, npm, Gradle and the images' base) as pull requests the checks look at.
- The `security` workflow scans the gateway and the kitty-desktop images with Trivy (pulling the base anew, also every Monday), fetched from its release and checked
  against a checksum kept in the workflow; raise `TRIVY_VERSION` and `TRIVY_SHA256` together.
- In the repository settings (Rules → branch ruleset for `main`), require a pull request, and these
  checks to pass before merging: `fmt · vet · test`, `desktop app · end to end`,
  `gateway image`, `kitty-desktop image`, `updating itself`, `semantic title`, `CodeQL`,
  `dependencies a pull request adds` and `gateway image · known vulnerabilities`, `kitty-desktop image · known vulnerabilities`. Only an owner of the
  repository can set this; it is not done by the workflows.

## Checking it works

```sh
curl -s https://kitties.example.com/v1/health          # open: version and uptime
curl -s -o /dev/null -w '%{http_code}\n' https://kitties.example.com/v1/kitties   # 401 without the token
```

And in the browser: the sign-in page appears, a wrong token is refused, the right one opens the
fleet, and after *Sign out* the page asks again.
