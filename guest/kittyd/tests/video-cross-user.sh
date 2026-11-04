#!/bin/bash
set -euo pipefail
# Match the installed services: Xvfb and voxl run as different Unix users.
# This isolated display has no user applications or credentials.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
chmod 0755 "$work"
bun build guest/kittyd/tests/video-native.ts --compile --target=bun-linux-x64-baseline --outfile "$work/probe"
chmod 0755 "$work/probe"
xvfb-run -a -s '-screen 0 1280x800x24 -nolisten tcp' bash -c '
  # Share only this synthetic display cookie with the second test user.
  cp "$XAUTHORITY" "$1/authority"
  chmod 0644 "$1/authority"
  if [ "$(id -u)" = 0 ]; then
    runuser -u nobody -- env DISPLAY="$DISPLAY" XAUTHORITY="$1/authority" "$1/probe"
  else
    sudo -u nobody env DISPLAY="$DISPLAY" XAUTHORITY="$1/authority" "$1/probe"
  fi
' fixture "$work"
