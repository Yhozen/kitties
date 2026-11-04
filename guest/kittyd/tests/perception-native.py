#!/usr/bin/env python3
"""Real GTK/AT-SPI acceptance and same-version CLI/FFI timing comparison.

xvfb-run -a -s '-screen 0 1280x800x24' dbus-run-session -- python3 \
  tests/perception-native.py /path/to/agent-desktop /path/to/libagent_desktop_ffi.so
Requires Ubuntu 24.04, python3-gi, gir1.2-gtk-3.0, openbox, xdotool, at-spi2-core.
Prints only aggregate timings and assertions, never the desktop tree.
"""
import json
import os
from pathlib import Path
import statistics
import subprocess as sp
import sys
import tempfile
import time


def fixture():
    import gi
    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk
    win = Gtk.Window(title="Kitties perception fixture")
    win.set_default_size(600, 400)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
    count = Gtk.Label(label="Clicks: 0")
    entry = Gtk.Entry()
    entry.get_accessible().set_name("Fixture input")
    button = Gtk.Button(label="Increment")
    clicks = [0]
    def click(_):
        clicks[0] += 1
        count.set_text(f"Clicks: {clicks[0]}")
    button.connect("clicked", click)
    for item in [count, entry, button]:
        box.pack_start(item, False, False, 8)
    win.add(box)
    win.connect("destroy", Gtk.main_quit)
    win.show_all()
    Gtk.main()


def main():
    cli, library = map(lambda p: str(Path(p).resolve()), sys.argv[1:3])
    helper = Path(__file__).resolve().parents[1] / "files/perception-helper.py"
    with tempfile.TemporaryDirectory(prefix="kitties-native-") as state:
        env = {**os.environ, "AGENT_DESKTOP_HOME": state, "NO_AT_BRIDGE": "0"}
        wm = sp.Popen(["openbox"], env=env, stdout=sp.DEVNULL, stderr=sp.DEVNULL)
        app = sp.Popen([sys.executable, __file__, "--fixture"], env=env,
                       stdout=sp.DEVNULL, stderr=sp.DEVNULL)
        helper_process = None
        try:
            for _ in range(50):
                found = sp.run(["xdotool", "search", "--name", "^Kitties perception fixture$"],
                               env=env, capture_output=True)
                if found.returncode == 0:
                    sp.run(["xdotool", "windowactivate", "--sync", found.stdout.decode().strip()],
                           env=env, check=True)
                    break
                time.sleep(.1)
            time.sleep(.5)
            # Linux first-contact health check, without logging screen metadata.
            health = json.loads(sp.check_output([cli, "status"], env=env))
            assert health["ok"]
            def start():
                p = sp.Popen([sys.executable, "-u", str(helper), library], env=env,
                             stdin=sp.PIPE, stdout=sp.PIPE, stderr=sp.DEVNULL, text=True)
                assert json.loads(p.stdout.readline()) == {"ready": 1}
                return p
            def call(action, **args):
                helper_process.stdin.write(json.dumps({"action": action, **args}) + "\n")
                helper_process.stdin.flush()
                reply = json.loads(helper_process.stdout.readline())
                return reply, json.loads(reply["result"])
            helper_process = start()
            reply, snapshot = call("ui_read")
            assert reply["status"] == "completed", snapshot
            assert snapshot["data"]["complete"]
            def nodes(node):
                if isinstance(node, dict):
                    yield node
                    for value in node.values():
                        yield from nodes(value)
                elif isinstance(node, list):
                    for value in node:
                        yield from nodes(value)
            items = list(nodes(snapshot["data"]["tree"]))
            button = next(n["ref_id"] for n in items if n.get("name") == "Increment" and n.get("ref_id"))
            entry = next(n["ref_id"] for n in items if n.get("name") == "Fixture input" and n.get("ref_id"))
            assert call("ui_click", ref=button)[0]["status"] == "completed"
            assert call("ui_type", ref=entry, text="Kitties 🐈")[0]["status"] == "completed"
            _, observed = call("ui_read")
            assert "Clicks: 1" in json.dumps(observed)
            assert "Kitties 🐈" in json.dumps(observed, ensure_ascii=False)
            helper_process.terminate()
            helper_process.wait(timeout=5)
            helper_process = start()
            reply, stale = call("ui_click", ref=button)
            assert reply["status"] == "failed", stale
            _, observed = call("ui_read")
            assert "Clicks: 1" in json.dumps(observed), "restarted helper replayed a mutation"
            timings = {"cli": [], "persistent": []}
            for _ in range(30):
                # Alternate to reduce warm-cache/thermal ordering bias.
                start_time = time.perf_counter()
                assert json.loads(sp.check_output([cli, "snapshot"], env=env))["ok"]
                timings["cli"].append((time.perf_counter() - start_time) * 1000)
                start_time = time.perf_counter()
                assert call("ui_read")[0]["status"] == "completed"
                timings["persistent"].append((time.perf_counter() - start_time) * 1000)
            print(json.dumps({"status": "passed", "samplesPerPath": 30,
                              "scope": "Ubuntu 24.04 local GTK3, Xvfb 1280x800; excludes network and model time",
                              "version": "agent-desktop 1.1.0 / ABI 7",
                              "assertions": ["snapshot", "semantic click", "Unicode text", "fresh-session stale ref", "no replay"],
                              "snapshotMs": {k: {"p50": round(statistics.median(v), 2),
                                                   "p95": round(sorted(v)[28], 2)} for k, v in timings.items()}}, indent=2))
        finally:
            for p in [helper_process, app, wm]:
                if p:
                    p.kill()
                    p.wait()


if __name__ == "__main__":
    if sys.argv[1:2] == ["--fixture"]:
        fixture()
    else:
        main()
