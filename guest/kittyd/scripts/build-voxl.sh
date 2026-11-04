#!/bin/bash
set -euo pipefail
# Ubuntu 24.04 x86_64. Install: build-essential pkg-config clang libclang-dev
# libx264-dev libyuv-dev libopus-dev libpulse-dev libxcb1-dev curl nodejs npm; rustup 1.93.0.
cd "$(dirname "$0")/.."
source /etc/os-release
[[ "$ID" = ubuntu && "$VERSION_ID" = 24.04 && "$(uname -m)" = x86_64 ]]
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p dist "$work/pkgconfig" "$work/source/.cargo"
readarray -t spec < <(python3 -c 'import json;v=json.load(open("voxl-version.json"));print(v["url"]);print(v["sha256"]);print(v["rust"]);print(v["esbuild"])')
curl --fail --silent --show-error --location "${spec[0]}" -o "$work/voxl.crate"
printf '%s  %s\n' "${spec[1]}" "$work/voxl.crate" | sha256sum --check --status
tar -xzf "$work/voxl.crate" -C "$work/source" --strip-components=1
# Ubuntu's libyuv-dev omits the pkg-config metadata. This only describes the
# distribution library; no source or compiler flags are patched upstream.
cat > "$work/pkgconfig/libyuv.pc" <<'PC'
prefix=/usr
libdir=/usr/lib/x86_64-linux-gnu
includedir=/usr/include
Name: libyuv
Description: Ubuntu libyuv
Version: 0.0.1888
Libs: -L${libdir} -lyuv
Cflags: -I${includedir}
PC
npm install --prefix "$work/esbuild" --ignore-scripts --no-audit --no-fund "esbuild@${spec[3]}"
export ESBUILD="$work/esbuild/node_modules/.bin/esbuild"
export PKG_CONFIG_PATH="$work/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export CARGO_TARGET_DIR="${KITTYD_VOXL_TARGET:-$PWD/dist/voxl-target}"
export CARGO_PROFILE_RELEASE_DEBUG=0
export RUSTFLAGS="--remap-path-prefix=$work=/voxl-build"
cargo "+${spec[2]}" build --release --locked --manifest-path "$work/source/Cargo.toml"
cp "$CARGO_TARGET_DIR/release/voxl" dist/voxl
strip dist/voxl
# Ship the exact source and locked Rust dependencies with the linked binary.
# x264 is GPL-2.0-or-later; voxl's own source is MIT.
cargo "+${spec[2]}" vendor --locked --manifest-path "$work/source/Cargo.toml" "$work/source/vendor" > "$work/source/.cargo/config.toml"
# Use a relative directory when rebuilding the source bundle.
sed -i "s|$work/source/vendor|vendor|" "$work/source/.cargo/config.toml"
cp scripts/build-voxl.sh voxl-version.json "$work/source/"
cp /usr/share/common-licenses/GPL-2 "$work/source/COPYING-x264"
cp /usr/share/doc/libx264-dev/copyright "$work/source/x264-copyright"
cp /usr/share/doc/libyuv-dev/copyright "$work/source/libyuv-copyright"
cp "$work/source/LICENSE" dist/voxl-LICENSE
cp "$work/source/COPYING-x264" dist/voxl-COPYING-x264
cp "$work/source/x264-copyright" dist/voxl-x264-copyright
cat > "$work/source/BUILD-KITTIES.txt" <<'NOTICE'
Kitties builds this unmodified voxl source using the versions in voxl-version.json,
Ubuntu 24.04 x86_64, and the build-voxl.sh recipe. To rebuild this unpacked source:
install the recipe's listed native dependencies, Rust and esbuild; create libyuv.pc
as shown in the recipe; then run cargo build --release --locked --offline here.
The vendor directory contains the Rust dependency sources and their licenses.
Native libraries are dynamically linked Ubuntu packages, installed by apt rather
than redistributed here. Their source is available from Ubuntu (apt-get source
x264 libyuv opus pulseaudio). The voxl binary links x264 and is distributed under
the GPL-2.0-or-later terms in COPYING-x264; voxl's MIT notice remains in LICENSE.
Kitties only exposes its authenticated read-only video relay, not voxl's web UI.
NOTICE
tar --sort=name --mtime=2026-11-04 --owner=0 --group=0 --numeric-owner \
  -czf dist/voxl-source.tgz -C "$work/source" .
python3 - <<'PY'
import hashlib,json,pathlib,subprocess
root=pathlib.Path('dist'); pin=json.load(open('voxl-version.json'))
manifest={'pin':pin,'platform':'Ubuntu 24.04 x86_64','files':{name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in ['voxl','voxl-source.tgz']},'nativePackages':subprocess.check_output(['dpkg-query','-W','libx264-dev','libyuv-dev','libopus-dev','libpulse-dev'],text=True).splitlines()}
(root/'voxl-build.json').write_text(json.dumps(manifest,indent=2)+'\n')
PY
