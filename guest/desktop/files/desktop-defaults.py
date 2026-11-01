#!/usr/bin/env python3
"""Install missing appearance defaults without replacing a kitty's preferences."""
import copy
import json
import os
from pathlib import Path
import tempfile
import xml.etree.ElementTree as ET

NS = '{http://openbox.org/3.4/rc}'
ET.register_namespace('', NS[1:-1])


def write_missing(data, target, home):
    if target.exists() or target.is_symlink():
        return False
    if any(parent.is_symlink() for parent in target.parents if parent.is_relative_to(home)):
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as staged:
        staged.write(data)
        staged.flush()
        os.fsync(staged.fileno())
    try:
        os.chmod(staged.name, 0o644)
        os.link(staged.name, target)
    except FileExistsError:
        return False
    finally:
        os.unlink(staged.name)
    return True


def copy_missing(source, target, home):
    return write_missing(source.read_bytes(), target, home)


def signature(element):
    return (element.tag, sorted(element.attrib.items()), (element.text or '').strip(),
            [signature(child) for child in element])


def stock_openbox(current, system):
    if not current.exists():
        return True
    if not system.exists():
        return False
    installed = ET.parse(system).getroot()
    for parent in installed.iter():
        for child in list(parent):
            if child.tag == NS + 'file' and (child.text or '').strip() == '/var/lib/openbox/debian-menu.xml':
                parent.remove(child)
    return signature(ET.parse(current).getroot()) == signature(installed)


def install_defaults(assets, home, browser, system_rc=Path('/etc/xdg/openbox/rc.xml')):
    for source in sorted((assets / 'home').rglob('*')):
        if source.is_file():
            copy_missing(source, home / source.relative_to(assets / 'home'), home)
    copy_missing(assets / 'Xresources', home / '.Xresources', home)
    (home / 'Desktop').mkdir(exist_ok=True)
    config = home / '.config/lumen'
    rc = config / 'rc.xml'
    old = home / '.config/openbox/rc.xml'
    if not rc.exists() and not rc.is_symlink():
        base = ET.parse(assets / 'lumen/rc.xml')
        if not stock_openbox(old, system_rc):
            existing = ET.parse(old)
            if existing.find(NS + 'shelf') is None:
                existing.getroot().append(copy.deepcopy(base.find(NS + 'shelf')))
            base = existing
        if browser.startswith('google-chrome'):
            for pin in base.findall(NS + 'shelf/' + NS + 'pins/' + NS + 'pin'):
                if pin.findtext(NS + 'command') == 'kitty-open':
                    pin.find(NS + 'name').text = 'Chrome'
                    pin.find(NS + 'class').text = 'Google-chrome'
        write_missing(ET.tostring(base.getroot(), encoding='utf-8', xml_declaration=True), rc, home)
    menu = home / '.config/openbox/menu.xml'
    legacy_menu = assets.parent / 'menu.xml'
    source_menu = assets / 'lumen/menu.xml'
    if menu.exists() and (not legacy_menu.exists() or menu.read_bytes() != legacy_menu.read_bytes()):
        source_menu = menu
    copy_missing(source_menu, config / 'menu.xml', home)
    copy_missing(assets / 'lumen/autostart', config / 'autostart', home)


if __name__ == '__main__':
    browser = json.loads(Path('/etc/kitties/browser.json').read_text())['executable']
    install_defaults(Path('/usr/local/share/kitties/desktop'), Path.home(), browser)
