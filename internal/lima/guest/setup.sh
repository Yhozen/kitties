#!/bin/sh
set -eu
export DEBIAN_FRONTEND=noninteractive

if [ -f /var/lib/kitties-desktop/provisioned-v1 ]; then
    systemctl start kitties-desktop.service
    exit 0
fi

apt-get -o DPkg::Lock::Timeout=300 update -qq
apt-get -o DPkg::Lock::Timeout=300 install -y -qq --no-install-recommends \
    xvfb x11-utils x11-xserver-utils xdotool scrot wmctrl xclip \
    openbox tint2 xterm pcmanfm dbus-x11 sudo \
    chromium chromium-sandbox fonts-dejavu fonts-noto-color-emoji \
    ca-certificates curl git jq python3 python3-websocket openssh-client \
    libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-gtk3 \
    inkscape imagemagick mtpaint mousepad numix-gtk-theme greybird-gtk-theme \
    tesseract-ocr tesseract-ocr-eng tesseract-ocr-spa \
    gcc libc6-dev libx11-dev libxext-dev libjpeg-dev procps tzdata

id kitty >/dev/null 2>&1 || useradd -m -s /bin/bash kitty
install -d -o kitty -g kitty -m 700 /home/kitty/work /home/kitty/.config
install -d -o kitty -g kitty -m 700 /home/kitty/.config/openbox
mkdir -p /usr/local/bin /usr/local/sbin /usr/local/src /usr/local/share/kitties /etc/chromium/policies/managed
