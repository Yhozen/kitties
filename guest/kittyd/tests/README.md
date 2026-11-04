# Native desktop acceptance

Run from the repository root. The standard check/test/build suite covers the bounded process
supervisor and video flow-control logic. CI additionally runs the real native and browser tests.

## Perception

On Ubuntu 24.04 with python3-gi, gir1.2-gtk-3.0, at-spi2-core, dbus-x11, Xvfb, Openbox and xdotool:

```sh
pnpm --filter @kitties/kittyd build:voxl
pnpm --filter @kitties/kittyd release
cd guest/kittyd
sh scripts/test-native.sh
```

The script loads the packaged agent-desktop library, exercises a GTK fixture, verifies state after
clicking and typing, rejects refs across helper restarts, and compares 30 alternating CLI/FFI reads.
Only aggregates and fixture assertions are printed.

## Capture and browser recovery

Install the build dependencies listed in `scripts/build-voxl.sh` and the resulting `dist/voxl`
at `/usr/local/lib/kittyd/voxl`. Chrome must be available at `/usr/bin/google-chrome` (or CHROME_BIN).

```sh
mkdir -p .context
KITTYD_VIDEO_FIXTURE="$PWD/.context/video-fixture.bin" xvfb-run -a -s '-screen 0 1280x800x24' bun guest/kittyd/tests/video-native.ts
KITTYD_VIDEO_FIXTURE="$PWD/.context/video-fixture.bin" node guest/kittyd/tests/viewer-browser.mjs
```

The fresh Xvfb contains no user applications. Its encoded keyframe feeds the browser test, which
uses the actual viewer module and Chrome's real H.264 decoder. Additional cases check missing
WebCodecs, configuration failure, startup timeout, unavailable video, both fences, and a late JPEG
decode after closure. Mocked WebSockets isolate these recovery cases from a deployment.

## Full click-to-visible comparison

Start the existing local Alchemy stage (owner gateway on 1337; guest ingress on 1338). Use a
**dedicated** Ubuntu 24.04 Docker container named `kitties-desktop-build`, with host networking and
the repository mounted at `/work`. Install `python3-tk`, Xvfb, xdotool, voxl's runtime libraries, and
the built `voxl` at `/usr/local/lib/kittyd/voxl`. Compile `files/kitty-grab.c` at the same location
with `gcc -O2 -march=x86-64 -mtune=generic ... -lX11 -lXext -ljpeg`. Build kittyd normally first.
The fixture uses display :97. `KITTYD_TEST_CONTAINER` can select another dedicated container whose
name starts with `kitties-desktop-`.

```sh
node guest/kittyd/probes/desktop-browser.mjs
node guest/kittyd/probes/desktop-browser.mjs --reverse
```

This configures a synthetic local KittyDO, launches the real guest daemon and counter fixture,
and mounts the actual browser component in an isolated page. The test sends 60 owner clicks per
path and counts only decoded canvas updates that change the counter. The first pass disables
WebCodecs in one browser context to measure JPEG. Reversing the order checks warmup bias.
The private guest config is deleted and that fixture's daemon is stopped afterward. No Boat
sandbox is created or touched. Results and synthetic screenshots go under `.context/desktop-benchmark`.
Chrome's local-network permission check is disabled only in this intercepted local test page;
production browser settings are unchanged.

## Continuous video with acknowledgement delay

With the same dedicated container and local stage as the click probe:

```sh
KITTIES_MOTION_LABEL=adaptive node guest/kittyd/probes/desktop-motion.mjs
KITTIES_MOTION_LABEL=adaptive-reverse node guest/kittyd/probes/desktop-motion.mjs --reverse
```

The fixture updates every 16 ms, encoding its source timestamp in the picture. The browser
samples visible-image age as well as time between updates, so freezes count toward latency.
Playwright delays both directions of the video WebSocket by half of each requested RTT
(0, 100, 200 and 350 ms), without delaying the control socket. This introduces delay, not a
bandwidth or loss model. Results and a synthetic screenshot are under `.context/desktop-motion`.
The benchmark cleans up its exact guest process and private config. Do not edit gateway source
or run concurrent heavy builds during measurements; local Alchemy would rebuild the worker.
