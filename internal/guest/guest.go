// Package guest embeds the shared desktop tools and persistent VM installers.
package guest

import (
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"fmt"
	"io/fs"
	"path"
	"strings"
)

//go:embed setup.sh finish.sh files/* all:desktop
var files embed.FS

// Script provisions a persistent Debian 13 Lima guest as root.
var Script = script(files, "lima")

// BoatScript provisions a Boat Ubuntu 24.04 guest as root. Boat's existing Chrome
// stays separate from the kitty profile and its loopback DevTools port.
var BoatScript = script(files, "boat")

func script(source fs.ReadFileFS, kind string) string {
	setup, err := source.ReadFile("setup.sh")
	if err != nil {
		panic(err)
	}
	finish, err := source.ReadFile("finish.sh")
	if err != nil {
		panic(err)
	}
	var body strings.Builder
	body.Write(setup)
	for _, file := range []struct{ source, target string }{
		{"kitty-shot.sh", "/usr/local/bin/kitty-shot"},
		{"kitty-ocr.sh", "/usr/local/bin/kitty-ocr"},
		{"kitty-backup.sh", "/usr/local/bin/kitty-backup"},
		{"kitty-restore.sh", "/usr/local/bin/kitty-restore"},
		{"kitty-page.py", "/usr/local/bin/kitty-page"},
		{"kitty-open.py", "/usr/local/bin/kitty-open"},
		{"kitty_browser.py", "/usr/local/lib/kitties/kitty_browser.py"},
		{"kitty-ready.sh", "/usr/local/bin/kitty-ready"},
		{"kitty-quiesce.sh", "/usr/local/bin/kitty-quiesce"},
		{"kitty-launch.sh", "/usr/local/bin/kitty-launch"},
		{"kitty-install.sh", "/usr/local/bin/kitty-install"},
		{"kitty-apt.sh", "/usr/local/sbin/kitty-apt"},
		{"kitty-stream.sh", "/usr/local/bin/kitty-stream"},
		{"kitty-clip.sh", "/usr/local/bin/kitty-clip"},
		{"kitty-theme.sh", "/usr/local/bin/kitty-theme"},
		{"kitty-desktop.sh", "/usr/local/bin/kitty-desktop"},
		{"kitty-shelf-media.sh", "/usr/local/bin/kitty-shelf-media"},
		{"kitty-shelf-weather.sh", "/usr/local/bin/kitty-shelf-weather"},
		{"install-desktop.sh", "/usr/local/lib/kitties/install-desktop.sh"},
		{"desktop-defaults.py", "/usr/local/lib/kitties/desktop-defaults.py"},
		{"kitty-grab.c", "/usr/local/src/kitty-grab.c"},
		{"chromium-policy.json", "/etc/chromium/policies/managed/kitties.json"},
		{"chromium-policy.json", "/etc/opt/chrome/policies/managed/kitties.json"},
		{"menu.xml", "/usr/local/share/kitties/menu.xml"},
		{"kitties-desktop.service", "/etc/systemd/system/kitties-desktop.service"},
	} {
		data, err := source.ReadFile("files/" + file.source)
		if err != nil {
			panic(err)
		}
		fmt.Fprintf(&body, "\nbase64 -d > %s <<'KITTY_FILE'\n%s\nKITTY_FILE\n", file.target, base64.StdEncoding.EncodeToString(data))
	}
	if err := fs.WalkDir(source, "desktop", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		data, err := source.ReadFile(name)
		if err != nil {
			return err
		}
		target := "/usr/local/share/kitties/" + name
		fmt.Fprintf(&body, "\nmkdir -p %s\nbase64 -d > %s <<'KITTY_FILE'\n%s\nKITTY_FILE\n", path.Dir(target), target, base64.StdEncoding.EncodeToString(data))
		return nil
	}); err != nil {
		panic(err)
	}
	body.Write(finish)
	sum := sha256.Sum256([]byte(body.String()))
	return fmt.Sprintf("#!/bin/sh\nKITTY_GUEST_KIND=%s\nKITTY_PROVISION_MARKER=/var/lib/kitties-desktop/provisioned-%x\n%s", kind, sum[:8], body.String())
}
