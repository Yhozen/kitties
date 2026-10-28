# Shared desktop guest

`files/` and `desktop/` are the canonical tools and appearance assets consumed by
the desktop Dockerfile and embedded in Kitties for Lima and Boat. Build the desktop image from the
repository root with `docker build -f docker/kitty-desktop/Dockerfile .`.

`guest.Script` installs a Debian 13 Lima desktop; `guest.BoatScript` installs an
Ubuntu 24.04 amd64 Boat desktop using Boat's existing `google-chrome-stable`.
Both scripts run as root, retain the private `/home/kitty` filesystem, and start
a Lumen desktop as the `kitty` user on Xvfb display `:99`. No host filesystem
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
its process to exit, then normally unmounts that user’s private GVFS FUSE mount
and the document portal at `~/.cache/doc` before syncing files. The portal uses
this cache path when the desktop session has no `XDG_RUNTIME_DIR`. Boat’s snapshot
scanner cannot traverse these mounts. A busy,
foreign or unexpected mount fails the checkpoint preparation; it is never forcibly
or lazily unmounted. Invoke it as `kitty` before stopping a VM for a durable checkpoint.
Other applications should be stopped or finish writing before the checkpoint.

A successful installation writes a payload-versioned marker. Re-running the
same version starts and checks the desktop without reinstalling packages.
A new payload version is deferred while the desktop is active. Stop/checkpoint
the kitty before deploying an update, then explicitly start it with viewers
closed until ready. Boat permits the installer to restart the desktop only for
a recorded cold bootstrap or resume. Lima sends the current installer only when
its pre-start inventory reports the existing guest stopped, or a persisted cold
upgrade is still incomplete after a failed attempt. Ordinary reads and input do not activate
an update. Browser profiles and guest files are retained; snapshots do not
capture RAM or active processes.

`desktop/versions.env` pins Lumen and Lucide. The VM installer builds Lumen for
the guest's own distro and architecture under `/usr/local`, retaining distro
Openbox for compatibility. Docker and VMs share the wallpaper, fonts, icons,
shelf and application defaults. Boat's browser pin targets Google Chrome;
Docker and Lima target Chromium. New defaults fill missing files only. Custom
Openbox settings migrate to Lumen, and saved themes, pins, browser profiles and
workspace files remain intact. Existing user defaults take precedence over
visual parity.
