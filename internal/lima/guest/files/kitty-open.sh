#!/bin/sh
set -eu
export DISPLAY="${DISPLAY:-:99}"
profile="${KITTY_PROFILE:-/home/kitty/work/.browser}"
mkdir -p "$profile"
chmod 700 "$profile"
if ! pgrep -x chromium >/dev/null 2>&1; then
    rm -f "$profile/SingletonLock" "$profile/SingletonSocket" "$profile/SingletonCookie"
fi
nohup setsid chromium --hide-crash-restore-bubble --force-dark-mode --disable-gpu --no-first-run \
    --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --password-store=basic \
    --window-size=1280,800 --user-data-dir="$profile" "$@" >/tmp/chromium.log 2>&1 </dev/null &
echo "opened $* on $DISPLAY"
