#!/bin/sh
# What the shelf's media island shows: four lines, the player's status (Playing or Paused), the
# title, the artist and a file with the cover. Prints nothing when no player is running (the
# island hides). The browser is a player (MPRIS) on the desktop's session bus.
set -u
status="$(playerctl status 2>/dev/null)" || exit 0
case "$status" in
Playing | Paused) ;;
*) exit 0 ;;
esac
one() { playerctl metadata "$1" 2>/dev/null | head -n 1 | tr -d '\r'; }
echo "$status"
one xesam:title
one xesam:artist
art="$(one mpris:artUrl)"
case "$art" in
file://*) printf '%s\n' "${art#file://}" ;;
http://* | https://*)
    dir=/tmp/shelf-art
    mkdir -p "$dir"
    file="$dir/$(printf '%s' "$art" | md5sum | cut -d' ' -f1)"
    [ -s "$file" ] || curl -fsSL -m 5 -o "$file" "$art" 2>/dev/null || rm -f "$file"
    [ -s "$file" ] && echo "$file"
    ;;
esac
exit 0
