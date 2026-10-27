#!/bin/sh
# Writes the display to stdout as a stream of JPEG pictures, each after a line "FRAME <bytes>",
# and only when it changed, with a line "PING" every two quiet seconds.
#   kitty-stream [--stdin] [pictures per second, 1-30 (15 without kitty-grab)] [JPEG quality, 30-95]
# With --stdin it ends when its input closes: `docker exec -i` closes it when the reader goes,
# while the stream's output alone would never tell (docker keeps reading it).
set -eu
: "${DISPLAY:=:99}"
# kitty-grab (C, XShm) does the same much faster: it stays connected to the display, compares raw
# pixels and only compresses what changed. The loop below is for an image that lacks it.
if command -v kitty-grab >/dev/null 2>&1; then
    exec kitty-grab "$@"
fi
if [ "${1:-}" = "--stdin" ]; then
    shift
    me=$$
    # A job in the background reads /dev/null unless told otherwise: it gets the input as fd 3.
    exec 3<&0
    (
        cat <&3 >/dev/null 2>&1
        kill "$me" 2>/dev/null
    ) &
    exec 3<&-
fi
fps="${1:-8}"
quality="${2:-70}"
case "$fps" in '' | *[!0-9]*) fps=8 ;; esac
case "$quality" in '' | *[!0-9]*) quality=70 ;; esac
[ "$fps" -ge 1 ] || fps=8
[ "$fps" -le 15 ] || fps=15
[ "$quality" -ge 30 ] && [ "$quality" -le 95 ] || quality=70
dir="$(mktemp -d /tmp/stream-XXXXXX)"
trap 'rm -rf "$dir"' EXIT
trap 'exit 0' INT TERM
pause="$(awk "BEGIN { print 1 / $fps }")"
last=""
quiet=0
while :; do
    scrot -o -q "$quality" "$dir/f.jpg" >/dev/null 2>&1
    sum="$(md5sum <"$dir/f.jpg" | cut -c1-32)"
    if [ "$sum" != "$last" ]; then
        printf 'FRAME %s\n' "$(stat -c %s "$dir/f.jpg")"
        cat "$dir/f.jpg"
        last="$sum"
        quiet=0
    else
        quiet=$((quiet + 1))
        if [ "$quiet" -ge $((fps * 2)) ]; then
            echo PING
            quiet=0
        fi
    fi
    sleep "$pause"
done
