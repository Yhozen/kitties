#!/bin/sh
set -eu
export DISPLAY=:99

Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp -ac -noreset +extension RANDR &
display_pid=$!
trap 'kill "$display_pid" 2>/dev/null || true' EXIT INT TERM
ready=false
for attempt in $(seq 1 50); do
    if xdpyinfo >/dev/null 2>&1; then
        ready=true
        break
    fi
    sleep 0.1
done
if [ "$ready" != true ]; then
    echo 'The virtual display did not start' >&2
    exit 1
fi

xsetroot -solid '#17212b'
openbox &
tint2 &
xterm -fa 'DejaVu Sans Mono' -fs 11 -geometry 88x22+180+140 -title 'Kitty virtual machine' -bg '#17212b' -fg '#e6edf3' \
    -e /bin/bash -lc 'printf "Kitties · persistent Linux VM\n\n"; uname -sr; printf "\nWorkspace: /home/kitty/work\nUse sudo to install tools inside this machine.\n\n"; exec /bin/bash' &
wait "$display_pid"
