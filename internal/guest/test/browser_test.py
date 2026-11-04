import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

FILES = Path(__file__).resolve().parents[1] / 'files'
sys.path.insert(0, str(FILES))
import kitty_browser


class BrowserOwnership(unittest.TestCase):
    def test_only_exact_profile_for_current_user_is_running(self):
        with tempfile.TemporaryDirectory() as directory:
            proc = Path(directory)
            def process(pid, *argv):
                path = proc / str(pid)
                path.mkdir()
                (path / 'cmdline').write_bytes(b'\0'.join(arg.encode() for arg in argv))
            process(1, '/opt/google/chrome/chrome', '--user-data-dir=/home/user/boat')
            process(2, '/usr/lib/chromium/chromium', '--user-data-dir=/home/kitty/work/.browser')
            process(3, '/opt/google/chrome/chrome', '--user-data-dir', '/home/kitty/work/.browser-extra')
            process(4, 'sh', '--user-data-dir=/home/kitty/work/.browser')
            process(5, '/opt/google/chrome/chrome', '--user-data-dir', '/home/kitty/work/.browser')
            self.assertEqual(sorted(kitty_browser.profile_processes('/home/kitty/work/.browser', proc)), [2, 5])
            self.assertEqual(kitty_browser.profile_processes('/home/kitty/work/.browser', proc, os.getuid() + 1), [])

    def test_boat_defaults_and_explicit_port_override(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'browser.json'
            config.write_text('{"executable":"google-chrome-stable","port":19222,"sandbox":true}')
            with patch.object(kitty_browser, 'CONFIG_PATH', config), patch.dict(os.environ, {}, clear=True):
                self.assertEqual(kitty_browser.settings()['executable'], 'google-chrome-stable')
                self.assertTrue(kitty_browser.settings()['sandbox'])
                self.assertEqual(kitty_browser.settings()['port'], 19222)
                with patch.dict(os.environ, {'KITTY_CDP_PORT': '19223'}):
                    self.assertEqual(kitty_browser.settings()['port'], 19223)
                with patch.dict(os.environ, {'KITTY_CDP_PORT': '922'}):
                    with self.assertRaises(ValueError):
                        kitty_browser.settings()


class BrowserQuiesce(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # The host needs no browser or websocket package to verify the close contract.
        fake = types.SimpleNamespace(WebSocketException=RuntimeError)
        spec = importlib.util.spec_from_file_location('kitty_page', FILES / 'kitty-page.py')
        cls.page = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'websocket': fake}):
            spec.loader.exec_module(cls.page)

    def test_running_profile_without_cdp_is_a_failed_checkpoint(self):
        with patch.object(self.page, 'profile_processes', return_value=[23]), \
             patch.object(self.page.urllib.request, 'urlopen', side_effect=OSError('unreachable')):
            with self.assertRaises(SystemExit) as result:
                self.page.quit_browser()
            self.assertEqual(result.exception.code, 1)

    def test_no_owned_browser_does_not_contact_another_desktop(self):
        with patch.object(self.page, 'profile_processes', return_value=[]), \
             patch.object(self.page.urllib.request, 'urlopen') as request:
            self.page.quit_browser()
            request.assert_not_called()


if __name__ == '__main__':
    unittest.main()
