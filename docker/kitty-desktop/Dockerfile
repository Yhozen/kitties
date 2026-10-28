# kitty-desktop: the body of a kitty.
#
# A desktop on a headless X display (Xvfb) with the Lumen window manager (madkoding/lumen-wm,
# with its shelf: a dock of pinned and open apps and a clock) in the dark Numix theme and
# Kitties' fonts: windows to move, focus and close, and PCManFM for the desktop's wallpaper and
# icons and as the file manager. The
# kitty acts on it with xdotool and wmctrl, and the person can watch it live and take it over
# from the chat. Chromium for the web, LibreOffice for office documents (also headless: `soffice
# --headless --convert-to pdf file.docx`), Inkscape, ImageMagick and mtPaint for drawing;
# kitty-install adds more from Debian, and they are installed again when the container is made
# anew. No port is published (the browser's DevTools listens on the container's own loopback only): the
# orchestrator reaches the container through `docker exec`.
#
#   docker build -f docker/kitty-desktop/Dockerfile -t ghcr.io/madkoding/kitty-desktop:latest .

# Lumen (the Openbox fork) with the shelf, at a fixed commit (a commit is its own checksum).
FROM debian:trixie-slim AS lumen
COPY internal/guest/desktop/versions.env /tmp/kitties-desktop-versions.env
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl build-essential autoconf \
        automake libtool pkg-config gettext autopoint libglib2.0-dev libxml2-dev libpango1.0-dev libcairo2-dev \
        libx11-dev libxft-dev libxrandr-dev libxinerama-dev libxcursor-dev libxi-dev libsm-dev librsvg2-dev \
        libimlib2-dev \
    && rm -rf /var/lib/apt/lists/*
RUN . /tmp/kitties-desktop-versions.env && curl -fsSL -o /tmp/lumen.tar.gz "https://github.com/madkoding/lumen-wm/archive/${LUMEN_COMMIT}.tar.gz" \
    && mkdir /tmp/lumen && tar xzf /tmp/lumen.tar.gz -C /tmp/lumen --strip-components=1 \
    && cd /tmp/lumen && ./bootstrap && ./configure --prefix=/usr --sysconfdir=/etc --disable-nls \
    && make -j"$(nproc)" && make DESTDIR=/out install

# The window theme, Numix (GPL-3) and the dark Greybird (GPL-2+ or CC-BY-SA-3.0+) from Debian: only
# their Openbox themes and licences are kept;
# and Kitties' own fonts (Sansation, JetBrains Mono Nerd Font, the same files as the app's page),
# from the web's woff2 to the ttf the desktop reads.
FROM debian:trixie-slim AS extras
# Lucide's icons (ISC), from npm (lucide-static) at a fixed version and checksum, drawn by
# lucide/build-theme.py as gradient squares by group of applications.
COPY internal/guest/desktop/versions.env /tmp/kitties-desktop-versions.env
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git python3 woff2 \
        numix-gtk-theme greybird-gtk-theme \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /out/themes/Numix /out/themes/Greybird-dark /out/doc/numix /out/doc/greybird /out/fonts \
    && cp -a /usr/share/themes/Numix/openbox-3 /out/themes/Numix/ \
    && cp -a /usr/share/themes/Greybird-dark/openbox-3 /out/themes/Greybird-dark/ \
    && cp /usr/share/doc/numix-gtk-theme/copyright /out/doc/numix/ \
    && cp /usr/share/doc/greybird-gtk-theme/copyright /out/doc/greybird/
# the menus wear the shelf's dark material, in both themes
COPY internal/guest/desktop/lumen/menu-style.themerc /tmp/menu-style.themerc
RUN cat /tmp/menu-style.themerc >> /out/themes/Numix/openbox-3/themerc \
    && cat /tmp/menu-style.themerc >> /out/themes/Greybird-dark/openbox-3/themerc
COPY internal/guest/desktop/fonts/ /tmp/fonts/
RUN for f in /tmp/fonts/*.woff2; do woff2_decompress "$f"; done && mv /tmp/fonts/*.ttf /out/fonts/
COPY internal/guest/desktop/lucide/ /tmp/lucide-map/
RUN . /tmp/kitties-desktop-versions.env && mkdir -p /tmp/lucide \
    && curl -fsSL -o /tmp/lucide.tgz "https://registry.npmjs.org/lucide-static/-/lucide-static-${LUCIDE_VERSION}.tgz" \
    && echo "${LUCIDE_SHA256}  /tmp/lucide.tgz" | sha256sum -c - \
    && tar xzf /tmp/lucide.tgz -C /tmp/lucide \
    && /tmp/lucide-map/build-theme.py /tmp/lucide/package/icons /out/icons/Lucide \
    && cp /tmp/lucide/package/LICENSE /out/doc/LUCIDE-LICENSE

# kitty-grab, the live view's capture: C, XShm and libjpeg (see kitty-grab.c).
FROM debian:trixie-slim AS grab
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev libx11-dev libxext-dev libjpeg-dev \
    && rm -rf /var/lib/apt/lists/*
COPY internal/guest/files/kitty-grab.c /tmp/kitty-grab.c
RUN gcc -O2 -Wall -Werror -o /kitty-grab /tmp/kitty-grab.c -lX11 -lXext -ljpeg && strip /kitty-grab

FROM debian:trixie-slim

# Dark everywhere: GTK 3 programs (LibreOffice among them) in Adwaita's dark variant.
ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    SCREEN=1280x800x24 \
    LANG=C.UTF-8 \
    GTK_THEME=Adwaita:dark \
    SAL_USE_VCLPLUGIN=gtk3

RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb x11-utils x11-xserver-utils xdotool scrot wmctrl xclip \
        xterm sudo playerctl dbus-x11 pcmanfm gnome-themes-extra gtk2-engines-pixbuf \
        libglib2.0-0 libxml2 libpango-1.0-0 libpangocairo-1.0-0 libpangoxft-1.0-0 libcairo2 libxft2 libxrandr2 libxinerama1 \
        libxcursor1 libxi6 libsm6 librsvg2-2 libimlib2 \
        chromium fonts-dejavu fonts-noto-color-emoji \
        ca-certificates curl git jq python3 python3-websocket openssh-client \
        libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-gtk3 \
        inkscape imagemagick mtpaint mousepad \
        tesseract-ocr tesseract-ocr-eng tesseract-ocr-spa \
        libx11-6 libxext6 libjpeg62-turbo \
        tini procps tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -s /bin/bash kitty \
    && mkdir -p /home/kitty/work && chown -R kitty:kitty /home/kitty \
    && echo 'kitty ALL=(root) NOPASSWD: /usr/local/sbin/kitty-apt' > /etc/sudoers.d/kitty \
    && chmod 440 /etc/sudoers.d/kitty

COPY --from=lumen /out/ /
RUN ldconfig
COPY --from=extras /out/themes/ /usr/share/themes/
COPY --from=extras /out/doc/numix/ /usr/share/doc/numix-gtk-theme/
COPY --from=extras /out/doc/greybird/ /usr/share/doc/greybird-gtk-theme/
COPY --from=extras /out/icons/Lucide/ /usr/share/icons/Lucide/
COPY --from=extras /out/doc/LUCIDE-LICENSE /usr/share/doc/lucide-icons/LICENSE
COPY --from=extras /out/fonts/ /usr/share/fonts/truetype/kitties/
RUN fc-cache -f
# The wallpaper: whatever picture is in wallpaper/ (jpg, png or webp), cropped to the display.
COPY internal/guest/desktop/wallpaper/ /tmp/wallpaper/
RUN mkdir -p /usr/share/backgrounds/kitties \
    && convert "$(ls /tmp/wallpaper/* | head -n 1)" -resize '1280x800^' -gravity center -extent 1280x800 \
        -quality 90 /usr/share/backgrounds/kitties/wallpaper.jpg \
    && rm -rf /tmp/wallpaper

COPY --chmod=755 docker/kitty-desktop/entrypoint.sh /usr/local/bin/kitty-entrypoint
COPY --chmod=755 internal/guest/files/kitty-shot.sh /usr/local/bin/kitty-shot
COPY --chmod=755 internal/guest/files/kitty-ocr.sh /usr/local/bin/kitty-ocr
COPY --chmod=755 internal/guest/files/kitty-backup.sh /usr/local/bin/kitty-backup
COPY --chmod=755 internal/guest/files/kitty-restore.sh /usr/local/bin/kitty-restore
# "Continue where you left off": the browser keeps session cookies (logins that have no expiry)
# across a restart, which an update of the desktop is.
COPY internal/guest/files/chromium-policy.json /etc/chromium/policies/managed/kitties.json
COPY --chmod=755 internal/guest/files/kitty-page.py /usr/local/bin/kitty-page
COPY internal/guest/files/kitty_browser.py /usr/local/lib/kitties/kitty_browser.py
COPY --chmod=755 internal/guest/files/kitty-ready.sh /usr/local/bin/kitty-ready
COPY --chmod=755 internal/guest/files/kitty-quiesce.sh /usr/local/bin/kitty-quiesce
RUN mkdir -p /etc/kitties && printf '%s\n' '{"executable":"chromium","port":19222,"sandbox":false}' > /etc/kitties/browser.json
COPY --chmod=755 internal/guest/files/kitty-open.py /usr/local/bin/kitty-open
COPY --chmod=755 internal/guest/files/kitty-launch.sh /usr/local/bin/kitty-launch
COPY --chmod=755 internal/guest/files/kitty-install.sh /usr/local/bin/kitty-install
COPY --chmod=755 internal/guest/files/kitty-apt.sh /usr/local/sbin/kitty-apt
COPY --chmod=755 internal/guest/files/kitty-stream.sh /usr/local/bin/kitty-stream
COPY --from=grab --chmod=755 /kitty-grab /usr/local/bin/kitty-grab
COPY --chmod=755 internal/guest/files/kitty-clip.sh /usr/local/bin/kitty-clip
COPY --chmod=755 internal/guest/files/kitty-theme.sh /usr/local/bin/kitty-theme
COPY --chmod=755 internal/guest/files/kitty-shelf-media.sh /usr/local/bin/kitty-shelf-media
COPY --chmod=755 internal/guest/files/kitty-shelf-weather.sh /usr/local/bin/kitty-shelf-weather
COPY --chown=kitty:kitty internal/guest/desktop/lumen/rc.xml internal/guest/desktop/lumen/menu.xml internal/guest/desktop/lumen/autostart /home/kitty/.config/lumen/
# The file manager's settings and the desktop's (wallpaper only).
COPY --chown=kitty:kitty internal/guest/desktop/home/ /home/kitty/
# An empty desktop: PCManFM draws only the wallpaper, no icons (the shelf has the apps).
RUN mkdir -p /home/kitty/Desktop && chown kitty:kitty /home/kitty/Desktop
COPY --chown=kitty:kitty internal/guest/desktop/Xresources /home/kitty/.Xresources

USER kitty
WORKDIR /home/kitty/work

ENTRYPOINT ["tini", "--", "kitty-entrypoint"]
