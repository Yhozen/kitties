#!/bin/sh
set -eu
export DEBIAN_FRONTEND=noninteractive

if [ "$(id -u)" != 0 ]; then
    echo 'desktop provisioning must run as root' >&2
    exit 1
fi
. /etc/os-release
case "$KITTY_GUEST_KIND:$ID:$VERSION_ID" in
lima:debian:13) browser=chromium ;;
boat:ubuntu:24.04)
    if [ "$(dpkg --print-architecture)" != amd64 ]; then
        echo 'Boat requires an amd64 machine' >&2
        exit 1
    fi
    browser=google-chrome-stable
    command -v "$browser" >/dev/null
    ;;
*) echo "unsupported guest OS: $KITTY_GUEST_KIND/$ID/$VERSION_ID" >&2; exit 1 ;;
esac

if [ -f "$KITTY_PROVISION_MARKER" ]; then
    desktop_pid=$(systemctl show --property=MainPID --value kitties-desktop.service)
    if [ "$desktop_pid" != 0 ] && [ "$(stat -Lc '%d:%i' "/proc/$desktop_pid/cwd" 2>/dev/null || true)" != "$(stat -Lc '%d:%i' /home/kitty/work)" ]; then
        systemctl restart kitties-desktop.service
    else
        systemctl start kitties-desktop.service
    fi
    for _ in $(seq 1 60); do
        if sudo -n -H -u kitty env DISPLAY=:99 kitty-ready >/dev/null 2>&1; then
            exit 0
        fi
        sleep 1
    done
    echo 'the existing desktop did not become ready' >&2
    exit 1
fi

if systemctl is-active --quiet kitties-desktop.service && [ "${KITTY_DESKTOP_RESTART:-0}" != 1 ]; then
    sudo -n -H -u kitty env DISPLAY=:99 kitty-ready
    echo 'Desktop update deferred until the computer is stopped and started.'
    exit 0
fi

apt-get -o DPkg::Lock::Timeout=300 update -qq
apt-get -o DPkg::Lock::Timeout=300 install -y -qq --no-install-recommends \
    xvfb x11-utils x11-xserver-utils xdotool scrot wmctrl xclip \
    openbox xterm pcmanfm dbus-x11 sudo playerctl gnome-themes-extra gtk2-engines-pixbuf \
    fonts-dejavu fonts-noto-color-emoji \
    ca-certificates curl git jq python3 python3-xdg python3-websocket openssh-client \
    libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-gtk3 \
    inkscape imagemagick mtpaint mousepad numix-gtk-theme greybird-gtk-theme \
    tesseract-ocr tesseract-ocr-eng tesseract-ocr-spa \
    at-spi2-core libatk-adaptor gcc libc6-dev libx11-dev libxext-dev libjpeg-dev procps tzdata \
    build-essential autoconf automake libtool pkg-config gettext autopoint \
    libglib2.0-dev libxml2-dev libpango1.0-dev libcairo2-dev libxft-dev libxrandr-dev \
    libxinerama-dev libxcursor-dev libxi-dev libsm-dev librsvg2-dev libimlib2-dev woff2 fontconfig
if [ "$KITTY_GUEST_KIND" = lima ]; then
    apt-get -o DPkg::Lock::Timeout=300 install -y -qq --no-install-recommends chromium chromium-sandbox
fi

id kitty >/dev/null 2>&1 || useradd -m -s /bin/bash kitty
install -d -o kitty -g kitty -m 700 /home/kitty/work /home/kitty/.config
install -d -o kitty -g kitty -m 700 /home/kitty/.config/openbox
mkdir -p /usr/local/bin /usr/local/sbin /usr/local/src /usr/local/share/kitties /usr/local/lib/kitties /etc/kitties
mkdir -p /etc/chromium/policies/managed /etc/opt/chrome/policies/managed
printf '{"executable":"%s","port":19222,"sandbox":true}\n' "$browser" > /etc/kitties/browser.json
