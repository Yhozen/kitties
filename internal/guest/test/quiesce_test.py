import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "files" / "kitty-quiesce.sh"


class CheckpointQuiesce(unittest.TestCase):
    def run_quiesce(self, mount="own", behavior="normal", browser_ok=True):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fakebin = root / "bin"
            fakebin.mkdir()
            state = root / "mounts"
            target = "/home/kitty/.gvfs"
            uid = os.getuid() + (1 if mount == "foreign" else 0)
            fstype = "fuse.sshfs" if mount == "unexpected" else "fuse.gvfsd-fuse"
            line = f"{target} {fstype} rw,user_id={uid},group_id=1001\n"
            state.write_text("/ ext4 rw\n" + (line if mount != "absent" else ""))
            commands = {
                "kitty-page": "echo browser >> \"$EVENTS\"\nexit " + ("0" if browser_ok else "1"),
                "sync": "echo sync >> \"$EVENTS\"",
                "findmnt": """echo inspect >> "$EVENTS"
if [ "$BEHAVIOR" = query_failure ] || { [ "$BEHAVIOR" = verify_failure ] && [ -f "$UNMOUNTED" ]; }; then exit 1; fi
cat "$MOUNTS"
""",
                "fusermount3": """printf 'unmount %s %s\\n' "$1" "$2" >> "$EVENTS"
[ "$#" -eq 2 ] && [ "$1" = -u ] && [ "$2" = /home/kitty/.gvfs ] || exit 7
[ "$BEHAVIOR" != busy ] || exit 8
touch "$UNMOUNTED"
if [ "$BEHAVIOR" != remount ]; then printf '/ ext4 rw\\n' > "$MOUNTS"; fi
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
            return result, events

    def test_owned_gvfs_is_normally_unmounted_before_sync(self):
        result, events = self.run_quiesce()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, ["browser", "inspect", "unmount -u /home/kitty/.gvfs", "inspect", "sync"])

    def test_absent_mount_does_not_unmount_other_filesystems(self):
        result, events = self.run_quiesce(mount="absent")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, ["browser", "inspect", "sync"])

    def test_busy_foreign_unknown_or_unverifiable_mount_cannot_claim_quiescence(self):
        for mount, behavior in [("foreign", "normal"), ("unexpected", "normal"),
                                ("own", "busy"), ("own", "remount"),
                                ("own", "query_failure"), ("own", "verify_failure")]:
            with self.subTest(mount=mount, behavior=behavior):
                result, events = self.run_quiesce(mount, behavior)
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
