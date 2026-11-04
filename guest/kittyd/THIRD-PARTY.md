Guest native components

- agent-desktop CLI and FFI 1.1.0: Apache-2.0, https://github.com/vercel-labs/agent-desktop.
  The release verifies both archives against perception-versions.json and includes the license.
- voxl 0.3.2: MIT source, https://github.com/tembo/voxl. The executable dynamically links Ubuntu's
  x264 (GPL-2.0-or-later), and is distributed under those GPL terms. The release includes voxl's
  source, locked Rust dependency sources and their licenses, the build recipe, the MIT notice,
  GPL text and x264 copyright notice in voxl-source.tgz. System runtime libraries (x264, libyuv,
  Opus, PulseAudio) are installed from Ubuntu packages; they are not copied into our bundle.
  The checksum-pinned private-shm patch supports a display running as a different Unix user
  by falling back to X11 GetImage. The source bundle includes the patch and patched source.

The Kitties client speaks only the single-stripe video portion of voxl's documented protocol.
It does not embed voxl's browser client or proxy its input, audio, microphone, clipboard or file APIs.
