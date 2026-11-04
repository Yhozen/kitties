#!/bin/bash
set -eu
python3 "${KITTYD_FIXTURE:-/work/guest/kittyd/tests/desktop-fixture.py}" &
fixture_pid=$!
guest_pid=
cleanup() {
  kill "$fixture_pid" 2>/dev/null || true
  if [ -n "$guest_pid" ]; then kill "$guest_pid" 2>/dev/null || true; fi
  rm -f "$KITTYD_CONFIG.pid"
}
trap cleanup EXIT TERM INT
sleep 1
/work/guest/kittyd/dist/kittyd &
guest_pid=$!
printf '%s\n' "$guest_pid" > "$KITTYD_CONFIG.pid"
wait "$guest_pid"
