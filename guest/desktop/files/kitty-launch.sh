#!/bin/sh
# Starts a program with windows and leaves it running: kitty-launch gimp file.png
set -eu
: "${DISPLAY:=:99}"
if [ "$#" -eq 0 ]; then
    echo "usage: kitty-launch program [arguments]" >&2
    exit 2
fi
if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is not installed: install it first (kitty-install)" >&2
    exit 127
fi
cd "$HOME/work" 2>/dev/null || cd "$HOME"
nohup setsid "$@" >"/tmp/launch-$(basename "$1").log" 2>&1 &
echo "started $*"
