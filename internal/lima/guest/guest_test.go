package guest

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestInstallerDeliversRunnableDesktopToolsWithoutChangingTheirBytes(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("sh is unavailable")
	}
	installer := script()
	parse := exec.Command(sh, "-n")
	parse.Stdin = strings.NewReader(installer)
	if output, err := parse.CombinedOutput(); err != nil {
		t.Fatalf("generated installer cannot be parsed: %v\n%s", err, output)
	}

	// Execute only delivery, under a temporary root: provisioning must never run on the test host.
	deliveries := regexp.MustCompile(`(?m)^base64 -d > (/[^\n ]+) <<'KITTY_FILE'\n[^\n]*\nKITTY_FILE\n`).FindAllStringSubmatch(installer, -1)
	root := t.TempDir()
	var delivery strings.Builder
	delivery.WriteString("set -eu\n")
	for _, block := range deliveries {
		path := filepath.Join(root, block[1])
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		delivery.WriteString(strings.Replace(block[0], "> "+block[1]+" ", "> '"+strings.ReplaceAll(path, "'", "'\\''")+"' ", 1))
	}
	install := exec.Command(sh)
	install.Stdin = strings.NewReader(delivery.String())
	if output, err := install.CombinedOutput(); err != nil {
		t.Fatalf("deliver embedded tools: %v\n%s", err, output)
	}

	for source, destination := range map[string]string{
		"kitty-shot.sh":           "/usr/local/bin/kitty-shot",
		"kitty-ocr.sh":            "/usr/local/bin/kitty-ocr",
		"kitty-backup.sh":         "/usr/local/bin/kitty-backup",
		"kitty-restore.sh":        "/usr/local/bin/kitty-restore",
		"kitty-page.py":           "/usr/local/bin/kitty-page",
		"kitty-launch.sh":         "/usr/local/bin/kitty-launch",
		"kitty-install.sh":        "/usr/local/bin/kitty-install",
		"kitty-apt.sh":            "/usr/local/sbin/kitty-apt",
		"kitty-stream.sh":         "/usr/local/bin/kitty-stream",
		"kitty-clip.sh":           "/usr/local/bin/kitty-clip",
		"kitty-open.sh":           "/usr/local/bin/kitty-open",
		"kitty-theme.sh":          "/usr/local/bin/kitty-theme",
		"kitty-desktop.sh":        "/usr/local/bin/kitty-desktop",
		"kitty-grab.c":            "/usr/local/src/kitty-grab.c",
		"chromium-policy.json":    "/etc/chromium/policies/managed/kitties.json",
		"menu.xml":                "/usr/local/share/kitties/menu.xml",
		"kitties-desktop.service": "/etc/systemd/system/kitties-desktop.service",
	} {
		t.Run(source, func(t *testing.T) {
			want, err := files.ReadFile("files/" + source)
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(root, destination)
			got, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("required guest tool was not delivered: %v", err)
			}
			if !bytes.Equal(got, want) {
				t.Fatal("shell delivery changed the embedded asset")
			}
			if strings.HasSuffix(source, ".sh") {
				if output, err := exec.Command(sh, "-n", path).CombinedOutput(); err != nil {
					t.Fatalf("delivered tool cannot be parsed: %v\n%s", err, output)
				}
			}
		})
	}
}
