#!/usr/bin/env python3
"""Expose only an explicit exchange directory to Boat and the desktop account."""
import os
from pathlib import Path
import pwd
import subprocess


def provision():
    if os.geteuid() != 0:
        raise SystemExit('Shared folder setup requires root')
    # Local Lima guests have no Boat user and do not use the Boat file API.
    try:
        user = pwd.getpwnam('user')
    except KeyError:
        return
    kitty = pwd.getpwnam('kitty')
    root = Path('/home/user/.kitties')
    shared = root / 'shared'
    link = Path('/home/kitty/work/Shared')
    # Never follow an existing symlink while setting permissions or replace user data.
    for directory in (Path('/home/user'), root, shared, Path('/home/kitty/work')):
        if directory.is_symlink():
            raise SystemExit('Shared folder setup found an unexpected symlink')
    if os.path.lexists(link) and not (link.is_symlink() and os.readlink(link) == str(shared)):
        raise SystemExit('Shared already exists; move it before setting up file sharing')
    root.mkdir(mode=0o700, exist_ok=True)
    shared.mkdir(mode=0o700, exist_ok=True)
    os.chown(root, 0, 0)
    os.chown(shared, user.pw_uid, user.pw_gid)
    # Traverse the private parent; do not grant directory listing or read access to it.
    subprocess.run(['setfacl', '-m', f'u:{kitty.pw_uid}:--x', '/home/user'], check=True)
    subprocess.run(['setfacl', '-m', f'u:{kitty.pw_uid}:--x,u:{user.pw_uid}:--x', str(root)], check=True)
    subprocess.run(['setfacl', '-m',
                    f'u:{kitty.pw_uid}:rwx,u:{user.pw_uid}:rwx,o::---,'
                    f'd:u::rwx,d:u:{kitty.pw_uid}:rwx,d:u:{user.pw_uid}:rwx,d:g::---,d:m::rwx,d:o::---',
                    str(shared)], check=True)
    if not os.path.lexists(link):
        link.symlink_to(shared)
    os.chown(link, kitty.pw_uid, kitty.pw_gid, follow_symlinks=False)


if __name__ == '__main__':
    provision()
