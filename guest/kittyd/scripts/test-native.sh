#!/bin/sh
set -eu
# Run from guest/kittyd after `pnpm release`; validates the packaged native library.
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
tar -xzf dist/kittyd.tgz -C "$fixture"
xvfb-run -a -s '-screen 0 1280x800x24' dbus-run-session -- \
  python3 tests/perception-native.py "$fixture/agent-desktop" "$fixture/libagent_desktop_ffi.so"
