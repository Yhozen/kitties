# Shared desktop guest

`files/` is the canonical desktop tool payload consumed by the desktop Dockerfile
and embedded in Kitties for Lima and Boat. Build the desktop image from the
repository root with `docker build -f docker/kitty-desktop/Dockerfile .`.

`guest.Script` installs a Debian 13 Lima desktop; `guest.BoatScript` installs an
Ubuntu 24.04 amd64 Boat desktop using Boat's existing `google-chrome-stable`.
Both scripts run as root, retain the private `/home/kitty` filesystem, and start
an Openbox desktop as the `kitty` user on Xvfb display `:99`. No host filesystem
or credentials are needed. The VM's kitty user can use sudo within that VM.

The browser binary, loopback DevTools port, and sandbox mode are configured by
`/etc/kitties/browser.json`. `KITTY_BROWSER`, `KITTY_CDP_PORT`, and `KITTY_PROFILE`
can override binary, port and profile. The default port is `19222`, separate
from Boat's own desktop browser. Browser process discovery matches both the
current user and exact profile, so stopping one profile does not stop Boat's
browser. VM browsers retain Chromium's sandbox; containers explicitly disable
it in their browser configuration to preserve the existing container behavior.

`kitty-ready` verifies the display, window manager, capture tool and browser
installation. `kitty-quiesce` asks the profile's browser to close and waits for
its process to exit before syncing files; it fails if a running browser cannot
be closed. Invoke it as `kitty` before stopping a VM for a durable checkpoint.
Other applications should be stopped or finish writing before the checkpoint.

A successful installation writes a payload-versioned marker. Re-running the
same version starts and checks the desktop without reinstalling packages.
A new payload version updates tools and restarts the desktop; run it only during
an explicitly drained maintenance operation. Browser profiles and guest files
are retained. The scripts do not capture RAM or active processes.
