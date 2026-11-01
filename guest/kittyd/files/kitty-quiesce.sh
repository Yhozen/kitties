#!/bin/sh
set -eu
if command -v agent-browser >/dev/null 2>&1; then agent-browser close >/dev/null 2>&1 || true; fi

# Close only this desktop user's configured Chrome profile and wait for disk flush.
python3 - <<'BROWSER'
import os,signal,sys,time
sys.path.insert(0,'/usr/local/lib/kitties')
from kitty_browser import profile_processes,settings
profile=settings()['profile']
for pid in profile_processes(profile):
    try: os.kill(pid,signal.SIGTERM)
    except ProcessLookupError: pass
for _ in range(100):
    if not profile_processes(profile): break
    time.sleep(.1)
else: raise SystemExit('Browser did not quiesce')
BROWSER

# Boat's snapshot scanner cannot traverse these private desktop FUSE mounts.
desktop_mount() {
    mounts=$(findmnt --kernel --raw --noheadings --nocanonicalize --output TARGET,FSTYPE,FS-OPTIONS) || return
    printf '%s\n' "$mounts" | awk -v target="$1" '$1 == target { print $2, $3 }'
}
unmount_metadata() {
    target=$1
    expected=$2
    mounted=$(desktop_mount "$target")
    [ -n "$mounted" ] || return 0
    type=${mounted%% *}
    options=${mounted#* }
    if [ "$type" != "$expected" ]; then
        echo "Cannot checkpoint: an unexpected filesystem is mounted at $target" >&2
        exit 1
    fi
    case ",$options," in
        *",user_id=$(id -u),"*) ;;
        *) echo "Cannot checkpoint: the mount at $target belongs to another user" >&2; exit 1 ;;
    esac
    if command -v fusermount3 >/dev/null 2>&1; then
        fusermount3 -u "$target"
    else
        fusermount -u "$target"
    fi
    remaining=$(desktop_mount "$target")
    if [ -n "$remaining" ]; then
        echo "Cannot checkpoint: the mount at $target is still active" >&2
        exit 1
    fi
}
unmount_metadata "$HOME/.gvfs" fuse.gvfsd-fuse
# Without XDG_RUNTIME_DIR, the document portal uses GLib's cache-directory fallback.
unmount_metadata "$HOME/.cache/doc" fuse.portal
sync
