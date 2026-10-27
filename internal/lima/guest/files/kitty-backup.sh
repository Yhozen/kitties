#!/bin/sh
# Prints, as base64, a tar.gz with what a kitty needs to be itself again in a new container:
# the browser's cookies, sessions, saved passwords and local storage, and the keys and
# credentials of its programs (ssh, git, gh), and the apps pinned to the dock. The gateway keeps it sealed, away from the
# container, and gives it back to kitty-restore when the container is made anew.
#   kitty-backup
set -eu
cd /home/kitty
profile="${KITTY_PROFILE:-/home/kitty/work/.browser}"
case "$profile" in
/home/kitty/*) profile="${profile#/home/kitty/}" ;;
*) profile="work/.browser" ;;
esac
list="$(mktemp /tmp/backup-XXXXXX)"
trap 'rm -f "$list"' EXIT
add() { [ -e "$1" ] && printf '%s\n' "$1" >>"$list"; return 0; }
for f in "Local State" "Default/Preferences" "Default/Cookies" "Default/Cookies-journal" "Default/Login Data" \
    "Default/Login Data-journal" "Default/Login Data For Account" "Default/Web Data" "Default/Local Storage" \
    "Default/Session Storage" "Default/Sessions" "Default/Extension State"; do
    add "$profile/$f"
done
for f in .ssh .gitconfig .git-credentials .netrc .config/gh .config/git .config/kitties/pins; do
    add "$f"
done
if [ ! -s "$list" ]; then
    exit 0
fi
tar -czf - -T "$list" 2>/dev/null | base64 -w0
echo
