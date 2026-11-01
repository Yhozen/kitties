#!/bin/sh
set -eu
export DISPLAY=:99
export GTK_MODULES=atk-bridge
export NO_AT_BRIDGE=0
mkdir -p /tmp/kitties-session
chmod 755 /tmp/kitties-session
python3 - <<'SESSION'
import json,os,pathlib
path=pathlib.Path('/tmp/kitties-session/env.json')
path.write_text(json.dumps({key:os.environ[key] for key in ['DISPLAY','DBUS_SESSION_BUS_ADDRESS','XDG_RUNTIME_DIR','AT_SPI_BUS_ADDRESS'] if key in os.environ}))
path.chmod(0o644)
SESSION
if command -v gsettings >/dev/null 2>&1; then gsettings set org.gnome.desktop.interface toolkit-accessibility true || true; fi

Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp -ac -noreset +extension RANDR &
display_pid=$!
trap 'kill "$display_pid" 2>/dev/null || true' EXIT INT TERM
ready=false
for _ in $(seq 1 50); do
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

xrdb -nocpp -merge "$HOME/.Xresources" 2>/dev/null || true
if [ -s "$HOME/work/.desktop/theme" ]; then
    theme="$(head -n 1 "$HOME/work/.desktop/theme" | tr -cd 'A-Za-z0-9@._-')"
    kitty-theme "$theme" >/dev/null
fi
/usr/local/bin/openbox-session >/tmp/lumen.log 2>&1 &
wait "$display_pid"
