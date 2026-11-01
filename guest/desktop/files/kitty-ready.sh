#!/bin/sh
set -eu
export DISPLAY="${DISPLAY:-:99}"
xdpyinfo >/dev/null
wmctrl -m >/dev/null
command -v kitty-grab >/dev/null
python3 - <<'PY'
import shutil
import sys
sys.path.insert(0, '/usr/local/lib/kitties')
from kitty_browser import settings
if not shutil.which(settings()['executable']):
    raise SystemExit('the configured browser is missing')
PY
