import importlib.util
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET

GUEST = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('desktop_defaults', GUEST / 'files/desktop-defaults.py')
DEFAULTS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEFAULTS)
ASSETS = GUEST / 'desktop'
NS = DEFAULTS.NS


class DesktopDefaults(unittest.TestCase):
    def test_fresh_boat_desktop_has_original_appearance_and_chrome_pin(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            DEFAULTS.install_defaults(ASSETS, home, 'google-chrome-stable')
            rc = ET.parse(home / '.config/lumen/rc.xml')
            self.assertEqual(rc.findtext(NS + 'theme/' + NS + 'name'), 'Numix')
            self.assertEqual(rc.findtext(NS + 'shelf/' + NS + 'font'), 'Sansation')
            self.assertEqual(rc.findtext(NS + 'shelf/' + NS + 'iconTheme'), 'Lucide')
            browser = rc.find(NS + 'shelf/' + NS + 'pins/' + NS + 'pin')
            self.assertEqual(browser.findtext(NS + 'command'), 'kitty-open')
            self.assertEqual(browser.findtext(NS + 'class'), 'Google-chrome')
            self.assertEqual((home / '.Xresources').read_bytes(), (ASSETS / 'Xresources').read_bytes())
            wallpaper = home / '.config/pcmanfm/default/desktop-items-0.conf'
            self.assertIn('/usr/share/backgrounds/kitties/wallpaper.jpg', wallpaper.read_text())

    def test_existing_preferences_and_profile_survive_migration_and_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            files = {
                '.gtkrc-2.0': b'my GTK preferences',
                '.config/gtk-3.0/settings.ini': b'my GTK3 preferences',
                '.Xresources': b'my terminal preferences',
                '.config/libreoffice/4/user/registrymodifications.xcu': b'my document preferences',
                '.config/kitties/pins': b'Custom|custom|my-command|MyClass\n',
                '.config/kitties/weather-place': b'Madrid\n',
                'work/.desktop/theme': b'Greybird-dark\n',
                'work/.browser/Default/Cookies': b'nonsecret-cookie-fixture',
                'work/.browser/Default/Local Storage/fixture': b'nonsecret-storage-fixture',
                'work/sentinel': b'workspace survives',
                '.config/openbox/menu.xml': b'<openbox_menu><menu id="custom"/></openbox_menu>',
            }
            for name, data in files.items():
                target = home / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            old_rc = home / '.config/openbox/rc.xml'
            old_rc.write_text('<openbox_config xmlns="http://openbox.org/3.4/rc"><theme><name>Greybird-dark</name></theme><focus><focusNew>no</focusNew></focus></openbox_config>')
            for _ in range(2):
                DEFAULTS.install_defaults(ASSETS, home, 'google-chrome-stable', home / 'missing-system-rc')
                for name, data in files.items():
                    self.assertEqual((home / name).read_bytes(), data, name)
            migrated = ET.parse(home / '.config/lumen/rc.xml')
            self.assertEqual(migrated.findtext(NS + 'theme/' + NS + 'name'), 'Greybird-dark')
            self.assertEqual(migrated.findtext(NS + 'focus/' + NS + 'focusNew'), 'no')
            self.assertEqual(migrated.findtext(NS + 'shelf/' + NS + 'enabled'), 'yes')
            self.assertEqual((home / '.config/lumen/menu.xml').read_bytes(), files['.config/openbox/menu.xml'])
            before = (home / '.config/lumen/rc.xml').read_bytes()
            DEFAULTS.install_defaults(ASSETS, home, 'chromium')
            self.assertEqual((home / '.config/lumen/rc.xml').read_bytes(), before)

    def test_stock_openbox_receives_numix_but_config_symlinks_are_not_followed(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            system = home / 'system-rc.xml'
            system.write_text('<openbox_config xmlns="http://openbox.org/3.4/rc"><theme><name>Clearlooks</name></theme><menu><file>/var/lib/openbox/debian-menu.xml</file></menu></openbox_config>')
            old = home / '.config/openbox/rc.xml'
            old.parent.mkdir(parents=True)
            old.write_text('<openbox_config xmlns="http://openbox.org/3.4/rc"><theme><name>Clearlooks</name></theme><menu/></openbox_config>')
            outside = home / 'external-preferences'
            outside.mkdir()
            (home / '.config/gtk-3.0').symlink_to(outside, target_is_directory=True)
            DEFAULTS.install_defaults(ASSETS, home, 'chromium', system)
            self.assertEqual(list(outside.iterdir()), [])
            rc = ET.parse(home / '.config/lumen/rc.xml')
            self.assertEqual(rc.findtext(NS + 'theme/' + NS + 'name'), 'Numix')
            self.assertEqual(rc.findtext(NS + 'shelf/' + NS + 'pins/' + NS + 'pin/' + NS + 'class'), 'Chromium')


if __name__ == '__main__':
    unittest.main()
