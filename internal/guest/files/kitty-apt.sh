#!/bin/sh
# Run as root through sudo: installs Debian packages, by name only, and nothing else.
set -eu
if [ "$#" -eq 0 ]; then
    echo "usage: kitty-apt package..." >&2
    exit 2
fi
for p in "$@"; do
    if ! printf '%s\n' "$p" | grep -Eqx '[a-z0-9][a-z0-9+.-]{0,99}'; then
        echo "not a package name: $p" >&2
        exit 2
    fi
done
export DEBIAN_FRONTEND=noninteractive
# The lists are refreshed when there are none or they are a day old.
if [ -z "$(find /var/lib/apt/lists -maxdepth 1 -name '*Packages*' -mmin -1440 2>/dev/null | head -n 1)" ]; then
    apt-get -o DPkg::Lock::Timeout=300 update -qq
fi
apt-get -o DPkg::Lock::Timeout=300 install -y -qq --no-install-recommends -- "$@"
