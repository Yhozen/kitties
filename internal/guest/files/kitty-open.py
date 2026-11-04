#!/usr/bin/env python3
"""Open a URL in this kitty's browser, independently of other desktops on the VM."""
import os
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, '/usr/local/lib/kitties')
from kitty_browser import profile_processes, settings


def main():
    config = settings()
    profile = Path(config['profile'])
    profile.mkdir(parents=True, exist_ok=True)
    profile.chmod(0o700)
    if not profile_processes(str(profile)):
        for name in ('SingletonLock', 'SingletonSocket', 'SingletonCookie'):
            (profile / name).unlink(missing_ok=True)
    argv = [config['executable'], '--hide-crash-restore-bubble', '--force-dark-mode',
            '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
            '--remote-debugging-port=' + str(config['port']),
            '--remote-debugging-address=127.0.0.1', '--password-store=basic',
            '--window-size=1280,800', '--user-data-dir=' + str(profile)]
    if not config['sandbox']:
        argv.extend(['--no-sandbox', '--test-type'])
    argv.extend(sys.argv[1:])
    env = dict(os.environ, DISPLAY=os.environ.get('DISPLAY', ':99'))
    with open('/tmp/kitties-browser-%d.log' % os.getuid(), 'ab') as log:
        subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                         env=env, start_new_session=True)
    print('opened %s on %s' % (' '.join(sys.argv[1:]), env['DISPLAY']))


if __name__ == '__main__':
    main()
