package guest

import (
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestEmbeddedInstallersAreValidShell(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("sh is unavailable")
	}
	for name, script := range map[string]string{"lima": Script, "boat": BoatScript} {
		t.Run(name, func(t *testing.T) {
			cmd := exec.Command(sh, "-n")
			cmd.Stdin = strings.NewReader(script)
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("installer syntax: %v\n%s", err, out)
			}
		})
	}
}

func TestBrowserOwnershipAndQuiesce(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("guest process ownership requires Unix file ownership")
	}
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is unavailable")
	}
	cmd := exec.Command(python, "test/browser_test.py")
	cmd.Env = append(os.Environ(), "PYTHONDONTWRITEBYTECODE=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("browser isolation: %v\n%s", err, out)
	}
}

type missingAsset struct {
	fs.ReadFileFS
	path string
}

func (f missingAsset) ReadFile(path string) ([]byte, error) {
	if path == f.path {
		return nil, &fs.PathError{Op: "read", Path: path, Err: fs.ErrNotExist}
	}
	return f.ReadFileFS.ReadFile(path)
}

func TestMissingProvisioningAssetFailsBeforePublishingInstaller(t *testing.T) {
	for _, path := range []string{"setup.sh", "finish.sh", "files/kitty-page.py", "desktop/lumen/rc.xml"} {
		t.Run(path, func(t *testing.T) {
			defer func() {
				failure, ok := recover().(error)
				if !ok || !errors.Is(failure, fs.ErrNotExist) {
					t.Fatalf("incomplete installer was published: %v", failure)
				}
			}()
			_ = script(missingAsset{ReadFileFS: files, path: path}, "boat")
		})
	}
}

func TestHydratedDesktopRestartsOnlyWhenItsWorkspaceWasReplaced(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("sh unavailable")
	}
	setup, err := files.ReadFile("setup.sh")
	if err != nil {
		t.Fatal(err)
	}
	text := string(setup)
	start := strings.Index(text, "    desktop_pid=")
	if start < 0 {
		t.Fatal("desktop hydration guard missing")
	}
	end := strings.Index(text[start:], "    for ")
	if end < 0 {
		t.Fatal("desktop hydration guard missing")
	}
	guard := text[start : start+end]
	for _, same := range []bool{false, true} {
		t.Run(map[bool]string{false: "retired workspace", true: "current workspace"}[same], func(t *testing.T) {
			dir := t.TempDir()
			current := filepath.Join(dir, "current")
			retired := filepath.Join(dir, "retired")
			if err := os.Mkdir(current, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(retired, 0700); err != nil {
				t.Fatal(err)
			}
			cwd := retired
			if same {
				cwd = current
			}
			testGuard := strings.ReplaceAll(guard, "/proc/$desktop_pid/cwd", cwd)
			testGuard = strings.ReplaceAll(testGuard, "/home/kitty/work", current)
			script := "systemctl() { if [ \"$1\" = show ]; then echo 42; else echo \"$1\"; fi; }\n" + testGuard
			if runtime.GOOS == "darwin" {
				// The guest uses GNU stat; adapt its formatting option for the host BSD stat.
				script = "stat() { shift; command stat -Lf \"$@\"; }\n" + script
			}
			cmd := exec.Command(sh)
			cmd.Stdin = strings.NewReader(script)
			out, err := cmd.CombinedOutput()
			want := "restart"
			if same {
				want = "start"
			}
			if err != nil || strings.TrimSpace(string(out)) != want {
				t.Fatalf("got %q %v; want %s", out, err, want)
			}
		})
	}
}

func TestDesktopDefaultsPreserveExistingGuestState(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	cmd := exec.Command(python, "test/desktop_defaults_test.py")
	cmd.Env = append(os.Environ(), "PYTHONDONTWRITEBYTECODE=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("desktop migration: %v\n%s", err, out)
	}
}

func TestChangedPayloadDefersUpdatesWhileDesktopIsActive(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("sh unavailable")
	}
	setup, err := files.ReadFile("setup.sh")
	if err != nil {
		t.Fatal(err)
	}
	text := string(setup)
	start := strings.Index(text, "if systemctl is-active")
	end := strings.Index(text[start:], "apt-get")
	guard := text[start : start+end]
	for _, cold := range []bool{false, true} {
		env := "0"
		want := "checked\nDesktop update deferred until the computer is stopped and started.\n"
		if cold {
			env = "1"
			want = "install\n"
		}
		cmd := exec.Command(sh)
		cmd.Stdin = strings.NewReader("systemctl() { return 0; }\nsudo() { echo checked; }\nKITTY_DESKTOP_RESTART=" + env + "\n" + guard + "echo install\n")
		out, err := cmd.CombinedOutput()
		if err != nil || string(out) != want {
			t.Fatalf("cold=%v: %q %v", cold, out, err)
		}
	}
}
