# shellcheck shell=sh
chmod 755 /usr/local/bin/kitty-* /usr/local/sbin/kitty-apt
gcc -O2 -Wall -Werror -o /usr/local/bin/kitty-grab /usr/local/src/kitty-grab.c -lX11 -lXext -ljpeg

# The privileged account is inside the VM, with no gateway or host mounts.
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
systemctl enable kitties-desktop.service
systemctl restart kitties-desktop.service
for _ in $(seq 1 60); do
    if systemctl is-active --quiet kitties-desktop.service && \
        sudo -n -H -u kitty env DISPLAY=:99 kitty-ready >/dev/null 2>&1; then
        install -d -m 755 /var/lib/kitties-desktop
        touch "$KITTY_PROVISION_MARKER"
        echo 'Kitties VM desktop ready'
        exit 0
    fi
    sleep 1
done
journalctl -u kitties-desktop.service --no-pager -n 50 >&2
exit 1
