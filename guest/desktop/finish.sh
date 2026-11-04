# shellcheck shell=sh
chmod 755 /usr/local/bin/kitty-* /usr/local/sbin/kitty-apt
gcc -O2 -Wall -Werror -o /usr/local/bin/kitty-grab /usr/local/src/kitty-grab.c -lX11 -lXext -ljpeg

# The privileged account is inside the VM, with no gateway or host mounts.
printf '%s\n' 'kitty ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/kitty
chmod 440 /etc/sudoers.d/kitty
visudo -cf /etc/sudoers.d/kitty

sh /usr/local/lib/kitties/install-desktop.sh
sudo -n -H -u kitty python3 /usr/local/lib/kitties/desktop-defaults.py
systemctl daemon-reload
systemctl enable kitties-desktop.service
install -d -m 755 /var/lib/kitties-desktop
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
