#!/usr/bin/env python3
"""Install the desktop assets from the checksum-verified guest release."""
import hashlib, os, pathlib, shutil, subprocess
root=pathlib.Path(__file__).resolve().parent
payload=b''.join(p.read_bytes() for p in sorted(root.rglob('*')) if p.is_file())
stamp='/var/lib/kitties-desktop/provisioned-'+hashlib.sha256(payload).hexdigest()[:16]
env=dict(os.environ,KITTY_GUEST_KIND='boat',KITTY_PROVISION_MARKER=stamp)
subprocess.run(['/bin/sh',str(root/'setup.sh')],env=env,check=True)
if pathlib.Path(stamp).exists(): raise SystemExit(0)
files={
 'kitty-shot.sh':'/usr/local/bin/kitty-shot','kitty-ocr.sh':'/usr/local/bin/kitty-ocr',
 'kitty-open.py':'/usr/local/bin/kitty-open','kitty_browser.py':'/usr/local/lib/kitties/kitty_browser.py',
 'kitty-ready.sh':'/usr/local/bin/kitty-ready','kitty-quiesce.sh':'/usr/local/bin/kitty-quiesce',
 'kitty-launch.sh':'/usr/local/bin/kitty-launch','kitty-install.sh':'/usr/local/bin/kitty-install',
 'kitty-apt.sh':'/usr/local/sbin/kitty-apt','kitty-theme.sh':'/usr/local/bin/kitty-theme',
 'kitty-desktop.sh':'/usr/local/bin/kitty-desktop','kitty-shelf-media.sh':'/usr/local/bin/kitty-shelf-media',
 'kitty-shelf-weather.sh':'/usr/local/bin/kitty-shelf-weather','install-desktop.sh':'/usr/local/lib/kitties/install-desktop.sh',
 'desktop-defaults.py':'/usr/local/lib/kitties/desktop-defaults.py','kitty-grab.c':'/usr/local/src/kitty-grab.c',
 'chromium-policy.json':'/etc/opt/chrome/policies/managed/kitties.json','menu.xml':'/usr/local/share/kitties/menu.xml',
 'kitties-desktop.service':'/etc/systemd/system/kitties-desktop.service'}
for source,target in files.items():
    pathlib.Path(target).parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(root/'files'/source,target)
shutil.copytree(root/'desktop','/usr/local/share/kitties/desktop',dirs_exist_ok=True)
subprocess.run(['/bin/sh',str(root/'finish.sh')],env=env,check=True)
