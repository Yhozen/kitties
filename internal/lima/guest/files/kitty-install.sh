#!/bin/sh
# Installs programs from Debian and remembers them, so a container made anew installs them
# again: kitty-install gimp vlc
set -eu
if [ "$#" -eq 0 ]; then
    echo "usage: kitty-install package..." >&2
    exit 2
fi
sudo -n /usr/local/sbin/kitty-apt "$@"
list="$HOME/work/.desktop/packages"
mkdir -p "$(dirname "$list")"
touch "$list"
for p in "$@"; do
    grep -qx -- "$p" "$list" || echo "$p" >>"$list"
done
echo "installed $*"
