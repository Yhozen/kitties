import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "files" / "kitty-quiesce.sh"
METADATA = {
    "gvfs": ("/home/kitty/.gvfs", "fuse.gvfsd-fuse"),
    "portal": ("/home/kitty/.cache/doc", "fuse.portal"),
}


class CheckpointQuiesce(unittest.TestCase):
    def run_quiesce(self, mount="own", behavior="normal", browser_ok=True, target="gvfs"):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fakebin = root / "bin"
            fakebin.mkdir()
            state = root / "mounts"
            uid = os.getuid() + (1 if mount == "foreign" else 0)
            unrelated = f"/home/kitty/work/remote fuse.sshfs rw,user_id={uid}\n"
            lines = "/ ext4 rw\n" + unrelated
            if mount != "absent":
                for name in METADATA if target == "both" else (target,):
                    path, fstype = METADATA[name]
                    if mount == "unexpected":
                        fstype = "fuse.sshfs"
                    lines += f"{path} {fstype} rw,user_id={uid},group_id=1001\n"
            state.write_text(lines)
            commands = {
                "kitty-page": "echo browser >> \"$EVENTS\"\nexit " + ("0" if browser_ok else "1"),
                "sync": "echo sync >> \"$EVENTS\"",
                "findmnt": """echo inspect >> "$EVENTS"
if [ "$BEHAVIOR" = query_failure ] || { [ "$BEHAVIOR" = verify_failure ] && [ -f "$UNMOUNTED" ]; }; then exit 1; fi
cat "$MOUNTS"
""",
                "fusermount3": """printf 'unmount %s %s\\n' "$1" "$2" >> "$EVENTS"
[ "$#" -eq 2 ] && [ "$1" = -u ] || exit 7
case "$2" in /home/kitty/.gvfs|/home/kitty/.cache/doc) ;; *) exit 7 ;; esac
[ "$BEHAVIOR" != busy ] || exit 8
touch "$UNMOUNTED"
if [ "$BEHAVIOR" != remount ]; then
    awk -v target="$2" '$1 != target' "$MOUNTS" > "$MOUNTS.next"
    mv "$MOUNTS.next" "$MOUNTS"
fi
""",
            }
            for name, body in commands.items():
                path = fakebin / name
                path.write_text("#!/bin/sh\n" + body + "\n")
                path.chmod(0o755)
            env = dict(os.environ, HOME="/home/kitty", MOUNTS=str(state),
                       EVENTS=str(root / "events"), UNMOUNTED=str(root / "unmounted"),
                       BEHAVIOR=behavior, PATH=str(fakebin) + os.pathsep + os.environ["PATH"])
            result = subprocess.run(["sh", str(SCRIPT)], env=env, capture_output=True, text=True)
            events = (root / "events").read_text().splitlines()
            self.assertIn(unrelated, state.read_text())
            return result, events

    def test_owned_desktop_metadata_is_normally_unmounted_before_sync(self):
        result, events = self.run_quiesce(target="both")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, ["browser", "inspect", "unmount -u /home/kitty/.gvfs", "inspect",
                                  "inspect", "unmount -u /home/kitty/.cache/doc", "inspect", "sync"])

    def test_document_portal_is_quiesced_without_a_gvfs_mount(self):
        result, events = self.run_quiesce(target="portal")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, ["browser", "inspect", "inspect",
                                  "unmount -u /home/kitty/.cache/doc", "inspect", "sync"])

    def test_absent_mount_does_not_unmount_other_filesystems(self):
        result, events = self.run_quiesce(mount="absent")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, ["browser", "inspect", "inspect", "sync"])

    def test_busy_foreign_unknown_or_unverifiable_mount_cannot_claim_quiescence(self):
        for target in METADATA:
            for mount, behavior in [("foreign", "normal"), ("unexpected", "normal"),
                                    ("own", "busy"), ("own", "remount"),
                                    ("own", "query_failure"), ("own", "verify_failure")]:
                with self.subTest(target=target, mount=mount, behavior=behavior):
                    result, events = self.run_quiesce(mount, behavior, target=target)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertNotIn("sync", events)
                    if mount in ("foreign", "unexpected") or behavior == "query_failure":
                        self.assertFalse(any(event.startswith("unmount") for event in events))

    def test_browser_failure_prevents_mount_changes(self):
        result, events = self.run_quiesce(browser_ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events, ["browser"])


if __name__ == "__main__":
    unittest.main()
