#!/usr/bin/env python3
"""Builds the "Lucide" icon pack from the Lucide icons (lucide-static's icons/*.svg, ISC).

Every icon is a rounded square with a gradient by the group of applications it belongs to
(groups.map), the Lucide glyph in white on it, and a soft shadow under the glyph and the square.
Which glyph and which group each freedesktop name gets is in icons.map. Names not listed there
come from Adwaita. A second set, "small", is drawn for 8 to 24 px with a bolder glyph and a tighter
shadow so both still read at 16 px.

  build-theme.py LUCIDE_ICONS_DIR OUT_DIR           the theme (index.theme and the SVGs)
  build-theme.py LUCIDE_ICONS_DIR OUT_DIR --sheet [BACKGROUND INK]   also OUT_DIR/sheet.html, by group
"""
import html
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONTEXTS = {"places": "Places", "apps": "Applications", "mimetypes": "MimeTypes",
            "devices": "Devices", "status": "Status", "actions": "Actions"}

# Per set: the square (x, y, size, radius), the glyph (left, top, scale, stroke in Lucide's 24 grid)
# and the shadows (dy and blur of the glyph's and of the square's, opacity).
SETS = {
    "scalable": dict(rect=(3, 2, 58, 14), glyph=(14, 13, 1.5, 2.1), g_shadow=(2, 1.6, .5), r_shadow=(2.5, 2.4, .38), size=64, min=25, max=512),
    "small": dict(rect=(2, 1, 60, 12), glyph=(11, 10, 1.75, 2.5), g_shadow=(1.5, 0.9, .55), r_shadow=(2, 1.4, .42), size=16, min=8, max=24),
}


def read_groups():
    groups = {}
    for line in (HERE / "groups.map").read_text().splitlines():
        if line.strip() and not line.startswith("#"):
            name, top, bottom = line.split()
            groups[name] = (top, bottom)
    return groups


def read_icons():
    for line in (HERE / "icons.map").read_text().splitlines():
        if line.strip() and not line.startswith("#"):
            name, lucide, group = line.split()
            yield name, lucide, group


def luminance(colour):
    channels = [int(colour[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    r, g, b = [c / 12.92 if c <= .03928 else ((c + .055) / 1.055) ** 2.4 for c in channels]
    return .2126 * r + .7152 * g + .0722 * b


def contrast_with_white(colour):
    return 1.05 / (luminance(colour) + .05)


def glyph_of(path):
    """The shapes inside a Lucide svg."""
    body = re.sub(r"<!--.*?-->", "", path.read_text(), flags=re.S)
    return re.search(r"<svg[^>]*>(.*)</svg>", body, flags=re.S).group(1).strip()


def icon_svg(glyph, top, bottom, s):
    x, y, side, radius = s["rect"]
    gx, gy, scale, stroke = s["glyph"]
    gdy, gblur, gop = s["g_shadow"]
    rdy, rblur, rop = s["r_shadow"]
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{top}"/><stop offset="1" stop-color="{bottom}"/></linearGradient>
    <filter id="square" x="-20%" y="-20%" width="140%" height="150%"><feGaussianBlur in="SourceAlpha" stdDeviation="{rblur}"/><feOffset dy="{rdy}" result="b"/><feFlood flood-color="#000" flood-opacity="{rop}"/><feComposite in2="b" operator="in"/></filter>
    <filter id="glyph" x="-30%" y="-30%" width="160%" height="170%"><feGaussianBlur in="SourceAlpha" stdDeviation="{gblur}"/><feOffset dy="{gdy}" result="b"/><feFlood flood-color="#000" flood-opacity="{gop}"/><feComposite in2="b" operator="in" result="s"/><feMerge><feMergeNode in="s"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect x="{x}" y="{y}" width="{side}" height="{side}" rx="{radius}" filter="url(#square)"/>
  <rect x="{x}" y="{y}" width="{side}" height="{side}" rx="{radius}" fill="url(#bg)"/>
  <rect x="{x + .5}" y="{y + .5}" width="{side - 1}" height="{side - 1}" rx="{radius - .5}" fill="none" stroke="#fff" stroke-opacity=".22"/>
  <g transform="translate({gx} {gy}) scale({scale})" fill="none" stroke="#fff" stroke-width="{stroke}" stroke-linecap="round" stroke-linejoin="round" filter="url(#glyph)">
    {glyph}
  </g>
</svg>
"""


def sheet_html(entries, groups):
    out = ["<!doctype html><meta charset=utf-8><title>Lucide icon pack</title>",
           "<style>body{font:13px sans-serif;background:%s;color:%s;margin:16px}h2{margin:18px 0 6px;font-size:14px}"
           ".row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin:4px 0}.i{text-align:center;font-size:9px;width:150px}"
           ".i img{display:block;margin:0 auto}.px{display:flex;gap:6px;align-items:flex-end;justify-content:center;margin-bottom:2px}</style>"
           % (sys.argv[4] if len(sys.argv) > 5 else "#1b1d21", sys.argv[5] if len(sys.argv) > 5 else "#e8eaed")]
    for group in groups:
        items, seen = [], set()
        for e in entries:
            if e[1] == group and e[4] not in seen:
                seen.add(e[4])
                items.append(e)
        if not items:
            continue
        out.append(f"<h2>{group}</h2><div class=row>")
        for name, _, scalable, small, lucide in items:
            sizes = "".join(f'<img src="{small if px <= 24 else scalable}" width={px} height={px}>' for px in (16, 24, 32, 48))
            label = html.escape(name.split("/")[1])
            out.append(f"<div class=i><div class=px>{sizes}</div>{label}</div>")
        out.append("</div>")
    return "\n".join(out)


def main():
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    groups = read_groups()
    for name, (top, bottom) in groups.items():
        if contrast_with_white(top) < 3:
            sys.exit(f"build-theme: group {name}: white on {top} has a contrast of {contrast_with_white(top):.2f}, 3 is the least")
    entries = []
    for name, lucide, group in read_icons():
        if group not in groups:
            sys.exit(f"build-theme: {name}: no group {group} in groups.map")
        context, base = name.split("/")
        glyph = glyph_of(src / f"{lucide}.svg")
        paths = []
        for set_name, s in SETS.items():
            target = out / set_name / context / f"{base}.svg"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(icon_svg(glyph, *groups[group], s))
            paths.append(f"{set_name}/{context}/{base}.svg")
        entries.append((name, group, *paths, lucide))
    dirs = [f"{s}/{c}" for s in SETS for c in CONTEXTS]
    theme = ["[Icon Theme]", "Name=Lucide", "Comment=Lucide's icons (ISC) on gradient squares by group of applications",
             "Inherits=Adwaita,hicolor", "Directories=" + ",".join(dirs)]
    for set_name, s in SETS.items():
        for context, label in CONTEXTS.items():
            theme += ["", f"[{set_name}/{context}]", f"Size={s['size']}", f"MinSize={s['min']}", f"MaxSize={s['max']}",
                      f"Context={label}", "Type=Scalable"]
    (out / "index.theme").write_text("\n".join(theme) + "\n")
    if "--sheet" in sys.argv:
        (out / "sheet.html").write_text(sheet_html(entries, list(groups)))


main()
