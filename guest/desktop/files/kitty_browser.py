"""Shared browser configuration and process ownership for the kitty user."""
import json
import os
from pathlib import Path

CONFIG_PATH = Path('/etc/kitties/browser.json')


def settings():
    config = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
    port = int(os.environ.get('KITTY_CDP_PORT', config.get('port', 19222)))
    if not 1024 <= port <= 65535:
        raise ValueError('KITTY_CDP_PORT must be between 1024 and 65535')
    return {
        'executable': os.environ.get('KITTY_BROWSER', config.get('executable', 'chromium')),
        'port': port,
        'sandbox': config.get('sandbox', True),
        'profile': os.path.abspath(os.environ.get('KITTY_PROFILE', '/home/kitty/work/.browser')),
    }


def profile_processes(profile, proc=Path('/proc'), uid=None):
    """Only the current user's browser processes with this exact profile argument."""
    uid = os.getuid() if uid is None else uid
    result = []
    for path in proc.iterdir():
        if not path.name.isdigit():
            continue
        try:
            if path.stat().st_uid != uid:
                continue
            argv = (path / 'cmdline').read_bytes().split(b'\0')
            wanted = ('--user-data-dir=' + profile).encode()
            separate = any(arg == b'--user-data-dir' and i + 1 < len(argv) and
                           argv[i + 1] == profile.encode() for i, arg in enumerate(argv))
            if argv and (wanted in argv or separate):
                executable = os.path.basename(argv[0].decode(errors='replace'))
                if executable in ('chrome', 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'):
                    result.append(int(path.name))
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
    return result
