#!/bin/sh
set -eu
assets=/usr/local/share/kitties/desktop
# shellcheck disable=SC1091
. "$assets/versions.env"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

stamp=/usr/local/share/kitties/lumen-commit
build="$LUMEN_COMMIT:private-libs-v1"
if [ ! -x /usr/local/bin/lumen-wm ] || [ "$(cat "$stamp" 2>/dev/null || true)" != "$build" ]; then
    curl -fsSL --retry 3 "https://github.com/madkoding/lumen-wm/archive/$LUMEN_COMMIT.tar.gz" -o "$work/lumen.tar.gz"
    mkdir "$work/lumen"
    tar xzf "$work/lumen.tar.gz" -C "$work/lumen" --strip-components=1
    (
        cd "$work/lumen"
        ./bootstrap
        LDFLAGS="-Wl,-rpath,/usr/local/lib/kitties/lumen" ./configure --prefix=/usr/local \
            --libdir=/usr/local/lib/kitties/lumen --sysconfdir=/usr/local/etc --disable-nls
        make -j2
        make install
    )
    printf '%s\n' "$build" > "$stamp"
fi

sed -i '1s|/usr/bin/env python$|/usr/bin/python3|' /usr/local/libexec/openbox-xdg-autostart

for theme in Numix Greybird-dark; do
    mkdir -p "/usr/local/share/themes/$theme"
    cp -a "/usr/share/themes/$theme/openbox-3" "/usr/local/share/themes/$theme/"
    cat "$assets/lumen/menu-style.themerc" >> "/usr/local/share/themes/$theme/openbox-3/themerc"
done

mkdir -p "$work/fonts" /usr/local/share/fonts/kitties
cp "$assets/fonts/"*.woff2 "$work/fonts/"
for font in "$work/fonts/"*.woff2; do woff2_decompress "$font"; done
install -m 644 "$work/fonts/"*.ttf /usr/local/share/fonts/kitties/
fc-cache -f

curl -fsSL --retry 3 "https://registry.npmjs.org/lucide-static/-/lucide-static-$LUCIDE_VERSION.tgz" -o "$work/lucide.tgz"
printf '%s  %s\n' "$LUCIDE_SHA256" "$work/lucide.tgz" | sha256sum -c -
mkdir "$work/lucide"
tar xzf "$work/lucide.tgz" -C "$work/lucide"
python3 "$assets/lucide/build-theme.py" "$work/lucide/package/icons" /usr/share/icons/Lucide
mkdir -p /usr/local/share/doc/kitties
install -m 644 "$work/lucide/package/LICENSE" /usr/local/share/doc/kitties/LUCIDE-LICENSE

mkdir -p /usr/share/backgrounds/kitties
convert "$assets/wallpaper/wallpaper.jpg" -resize '1280x800^' -gravity center -extent 1280x800 \
    -quality 90 /usr/share/backgrounds/kitties/wallpaper.jpg
