
chmod 755 /usr/local/bin/kitty-* /usr/local/sbin/kitty-apt
gcc -O2 -Wall -Werror -o /usr/local/bin/kitty-grab /usr/local/src/kitty-grab.c -lX11 -lXext -ljpeg

# Privilege elevation stays inside this VM; no host directories or sockets are shared.
printf '%s\n' 'kitty ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/kitty
chmod 440 /etc/sudoers.d/kitty
visudo -cf /etc/sudoers.d/kitty

if [ ! -f /home/kitty/.config/openbox/rc.xml ]; then
    install -o kitty -g kitty -m 644 /etc/xdg/openbox/rc.xml /home/kitty/.config/openbox/rc.xml
    sed -i '\|/var/lib/openbox/debian-menu.xml|d' /home/kitty/.config/openbox/rc.xml
fi
if [ ! -f /home/kitty/.config/openbox/menu.xml ]; then
    install -o kitty -g kitty -m 644 /usr/local/share/kitties/menu.xml /home/kitty/.config/openbox/menu.xml
fi
systemctl daemon-reload
systemctl enable --now kitties-desktop.service

for attempt in $(seq 1 60); do
    if systemctl is-active --quiet kitties-desktop.service && \
        sudo -H -u kitty env DISPLAY=:99 xdpyinfo >/dev/null 2>&1 && \
        sudo -H -u kitty env DISPLAY=:99 wmctrl -m >/dev/null 2>&1; then
        install -d -m 755 /var/lib/kitties-desktop
        touch /var/lib/kitties-desktop/provisioned-v1
        echo 'Kitties VM desktop ready'
        exit 0
    fi
    sleep 1
done
journalctl -u kitties-desktop.service --no-pager -n 50 >&2
exit 1
