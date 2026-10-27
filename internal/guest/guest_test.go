package guest

import (
	"errors"
	"io/fs"
	"os"
	"os/exec"
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
	for _, path := range []string{"setup.sh", "finish.sh", "files/kitty-page.py"} {
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
