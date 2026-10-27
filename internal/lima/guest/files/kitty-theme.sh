#!/bin/sh
set -eu
name="${1:-}"
case "$name" in
'' | *[!A-Za-z0-9@._-]*) echo 'usage: kitty-theme NAME' >&2; exit 2 ;;
esac
if [ ! -f "/usr/share/themes/$name/openbox-3/themerc" ]; then
    echo "no theme called $name" >&2
    exit 2
fi
python3 - "$name" <<'PY'
import os
import sys
import xml.etree.ElementTree as ET

path = os.path.expanduser('~/.config/openbox/rc.xml')
namespace = 'http://openbox.org/3.4/rc'
ET.register_namespace('', namespace)
tree = ET.parse(path)
tree.find('{%s}theme/{%s}name' % (namespace, namespace)).text = sys.argv[1]
tree.write(path, encoding='unicode')
PY
DISPLAY="${DISPLAY:-:99}" openbox --reconfigure
echo "theme $name"
