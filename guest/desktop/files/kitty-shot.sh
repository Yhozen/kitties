#!/bin/sh
# Prints a PNG screenshot of the display to stdout.
set -eu
: "${DISPLAY:=:99}"
out="$(mktemp /tmp/shot-XXXXXX.png)"
scrot -o "$out" >/dev/null 2>&1
cat "$out"
rm -f "$out"
