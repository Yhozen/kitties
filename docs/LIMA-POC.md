> Historical pre-Effect reference. Production now uses the [Effect architecture](ARCHITECTURE.md)
> and [Cloudflare deployment](DEPLOY.md). Commands below describe the retired implementation.

# Kitties with a computer per agent

This proof of concept runs each kitty's desktop directly in a persistent Debian 13
virtual machine. Lima uses Apple's Virtualization.framework on this Mac; Linux
hosts use Lima's QEMU backend. No Docker daemon or desktop container is involved.

The chat, browser tools, live display, keyboard/mouse control and provider settings
are the existing Kitties interface. The guest uses a simple Openbox desktop and
taskbar, with Chromium, a terminal, LibreOffice and drawing tools.

## Run

On macOS, install the tools with `brew install lima go node`. Lima 2 or later and
Go 1.26.10 or later are required. On Linux, install Lima and its QEMU/KVM
prerequisites using Lima's installation guide.

```sh
scripts/run-lima.sh
```

Open <http://127.0.0.1:7489>, add/sign in to an AI provider in Settings, then create
a kitty with a computer. Its first start downloads a Debian cloud image and
installs desktop packages; allow several minutes. Each VM gets two CPUs, 4 GiB
RAM and a 16 GiB disk with the example configuration.

For a quick demonstration without AI credentials:

```sh
scripts/run-lima.sh --demo
```

This creates `mimi` with a **scripted brain and a real Linux VM**. Ask it to
`open https://example.com`, or take control of its desktop. The scripted responses
exercise the real tools but are not a general-purpose AI. Use the normal mode to
connect a real provider. The modes use separate state directories and the same
port, so run one gateway at a time.

After building, the demo can also be controlled directly:

```sh
./dist/kitties -vm-demo exec mimi uname -a
./dist/kitties -vm-demo exec mimi kitty-open https://example.com
./dist/kitties -vm-demo shot mimi /tmp/mimi.png
./dist/kitties -vm-demo stop mimi
./dist/kitties -vm-demo start mimi
```

## Persistence and boundaries

- Normal state lives in `~/.kitties-lima`; demo state in `~/.kitties-lima-demo`.
  `KITTIES_DATA_DIR` overrides either. The `lima/` subdirectory is a dedicated
  `LIMA_HOME`, separate from personal Lima instances.
- `/home/kitty/work`, browser profiles, installed packages and the rest of the
  guest disk survive stop/start and gateway restarts. Closing the gateway does
  not stop running VMs. Use `stop` to release their memory.
- **Removing a kitty deletes its VM and disk.** Export files you need first.
  Browser-session backups in the UI are not complete VM backups.
- No host home/workspace, Docker socket or SSH agent is shared. Guest ports are
  not automatically forwarded. The guest user has sudo inside its own VM.
- This PoC uses Lima's default outbound networking. It does **not** provide an
  egress allowlist or block access to reachable LAN/host network services.
- Provider credentials and external connectors remain in the host gateway.
  A host shell connector still runs on the host; the VM boundary applies to
  desktop tools. The demo has no external connectors.
- Automatic container-image replacement is disabled and the manual image-update
  action is rejected for Lima. Update packages inside the guest with apt. Full
  guest-image migration, disk snapshots and recovery are outside this PoC.

## Implementation

`internal/lima` implements the existing desktop runtime interface. Lifecycle
operations use `limactl`; commands and binary screenshot streams travel over
Lima's SSH connection, with arguments quoted by Lima. A systemd service starts
Xvfb and the desktop. Guest provisioning and the `kitty-*` tools are embedded in
the gateway binary, so the running binary does not need this source checkout.

`containers.runtime: lima` selects the backend. `containers.workspace` and
`containers.network` are rejected because Docker bind mounts and network names
do not describe this guest. Existing Docker/Podman modes remain available.

## Checks

Run `go test ./...`, `go vet ./...`, and the frontend typecheck/build. A live check
must also boot the VM, execute a command, open/read a browser page, decode a PNG
and a live JPEG frame, close the stream, and verify a file and browser state
survive stop/start. Unit tests do not replace that VM check.

With the demo VM running, close its live desktop viewers and run the transport
check against it:

```sh
KITTIES_LIMA_LIVE_HOME="$HOME/.kitties-lima-demo/lima" \
  go test ./internal/lima -run TestLiveVMDesktopTransport -count=1 -v
```

This checks real argument/stdin transport, screenshots, video frames and stream
cleanup. It does not create, stop or delete a VM. The PoC was exercised on Apple
Silicon with Lima 2.2.1; the Linux/QEMU path has not been boot-tested.
