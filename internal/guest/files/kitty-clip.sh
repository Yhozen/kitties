#!/bin/sh
# The display's clipboard: kitty-clip get prints it, kitty-clip set "text" fills it.
set -eu
: "${DISPLAY:=:99}"
case "${1:-}" in
get)
    xclip -selection clipboard -o 2>/dev/null || true
    ;;
set)
    # xclip stays in the background to own the clipboard until something else takes it.
    printf '%s' "${2:-}" | xclip -selection clipboard -i >/dev/null 2>&1
    echo "set"
    ;;
*)
    echo "usage: kitty-clip get | kitty-clip set TEXT" >&2
    exit 2
    ;;
esac
