The VM provisions the same `kitty-*` desktop protocol as the container backend,
using standard Debian Openbox instead of the custom Lumen build. The helper files
copied from `docker/kitty-desktop` retain the repository's GPL-3.0-or-later license.
`kitty-open`, `kitty-theme`, and the service/startup files are specific to the VM.

The guest has its own persistent disk, including `/home/kitty/work`. Its `kitty`
user may use sudo inside the guest. Chromium keeps its own sandbox enabled; the
VM does not use the container backend's `--no-sandbox` browser option.

The assets are embedded so a built Kitties binary can provision a VM without a
source checkout or a Docker daemon. When changing a shared desktop helper, update
its copy here as well.

A successful first provisioning writes
`/var/lib/kitties-desktop/provisioned-v1`. Subsequent boots start the existing
desktop without downloading packages or replacing guest tools. A failed first
provisioning leaves no marker and is retried on the next boot.
