#!/bin/sh
set -eu
# Bootstrap inputs arrive through Boat's exact-remote-ID file API, never argv.
bootstrap=/home/user/.config/kittyd-bootstrap
if [ -n "${KITTYD_BUNDLE:-}" ]; then
  work=$KITTYD_BUNDLE
else
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
python3 - "$bootstrap/artifact.json" "$work" <<'PY'
import hashlib,json,pathlib,sys,urllib.request
manifest=json.load(open(sys.argv[1]))
archive=pathlib.Path(sys.argv[2])/'kittyd.tgz'
with urllib.request.urlopen(urllib.request.Request(manifest['url'],headers={'User-Agent':'Mozilla/5.0 (Kitties guest bootstrap)'}),timeout=120) as source,archive.open('wb') as target:
    while chunk:=source.read(1048576):target.write(chunk)
if hashlib.sha256(archive.read_bytes()).hexdigest()!=manifest['sha256']:raise SystemExit('Artifact checksum mismatch')
PY
tar -xzf "$work/kittyd.tgz" -C "$work"
fi
if [ -f "$work/desktop/provision.py" ]; then python3 "$work/desktop/provision.py"; fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq gcc libx11-dev libxext-dev libjpeg-dev xclip x11-xserver-utils
id kittyd >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/kittyd --shell /usr/sbin/nologin kittyd
install -d -m 0755 /usr/local/lib/kittyd
install -m 0755 "$work/kittyd" /usr/local/lib/kittyd/kittyd
for name in agent-desktop agent-desktop-linux-clipboard-owner; do install -m 0755 "$work/$name" "/usr/local/bin/$name"; done
install -m 0755 "$work/agent-browser-linux-x64" /usr/local/bin/agent-browser
install -m 0644 "$work/libagent_desktop_ffi.so" /usr/local/lib/kittyd/libagent_desktop_ffi.so
install -m 0644 "$work/perception-helper.py" /usr/local/lib/kittyd/perception-helper.py
install -m 0644 "$work/agent-desktop-LICENSE" /usr/local/lib/kittyd/agent-desktop-LICENSE
gcc -O2 -march=x86-64 -mtune=generic -o /usr/local/lib/kittyd/kitty-grab "$work/kitty-grab.c" -lX11 -lXext -ljpeg
install -m 0755 "$work/kitty-quiesce.sh" /usr/local/lib/kittyd/kitty-quiesce
install -d -o root -g kittyd -m 0750 /etc/kittyd
if [ -f "$bootstrap/config.json" ]; then
  install -o root -g root -m 0600 "$bootstrap/config.json" /etc/kittyd/config.json
else
  chown root:root /etc/kittyd/config.json
  chmod 0600 /etc/kittyd/config.json
fi
install -d -o kittyd -g kittyd -m 0700 /var/lib/kittyd
display=$(python3 -c 'import json;print(json.load(open("/etc/kittyd/config.json")).get("display",":99"))')
DISPLAY="$display" xhost +SI:localuser:kittyd
DISPLAY="$display" xrandr -s 1280x800 || true
cat > /etc/systemd/system/kittyd.service <<'UNIT'
[Unit]
Description=Kitties persistent guest channel
After=network-online.target kitties-desktop.service
Wants=network-online.target
[Service]
Type=simple
User=kittyd
Group=kittyd
Environment=DISPLAY=:0
LoadCredential=config.json:/etc/kittyd/config.json
ExecStart=/usr/local/lib/kittyd/kittyd
Restart=always
RestartSec=1
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/kittyd
PrivateTmp=no
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/kitties-perception.service <<'UNIT'
[Unit]
Description=Kitties desktop accessibility helper
After=kitties-desktop.service
Requires=kitties-desktop.service
[Service]
Type=simple
User=kitty
Group=kittyd
Environment=DISPLAY=:99
Environment=HOME=/home/kitty
ExecStart=/usr/local/lib/kittyd/kittyd --perception
Restart=always
RestartSec=1
RuntimeDirectory=kitties-perception
RuntimeDirectoryMode=0750
UMask=0007
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/run/kitties-perception /home/kitty/.cache
PrivateTmp=no
[Install]
WantedBy=multi-user.target
UNIT
install -d -o kitty -g kitty -m 0700 /home/kitty/.cache
systemctl daemon-reload
systemctl enable kitties-perception
systemctl restart kitties-perception
systemctl enable kittyd
systemctl restart kittyd
rm -f "$bootstrap/config.json" "$bootstrap/artifact.json"
systemctl is-active kittyd
