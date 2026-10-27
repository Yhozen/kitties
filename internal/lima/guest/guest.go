// Package guest provisions the desktop tools directly in a persistent Debian VM.
package guest

import (
	"embed"
	"encoding/base64"
	"fmt"
	"strings"
)

//go:embed setup.sh finish.sh files/*
var files embed.FS

// Script runs as root through Lima's system provisioning.
var Script = script()

func script() string {
	setup, _ := files.ReadFile("setup.sh")
	finish, _ := files.ReadFile("finish.sh")
	var out strings.Builder
	out.Write(setup)
	for _, file := range []struct{ source, target string }{
		{"kitty-shot.sh", "/usr/local/bin/kitty-shot"},
		{"kitty-ocr.sh", "/usr/local/bin/kitty-ocr"},
		{"kitty-backup.sh", "/usr/local/bin/kitty-backup"},
		{"kitty-restore.sh", "/usr/local/bin/kitty-restore"},
		{"kitty-page.py", "/usr/local/bin/kitty-page"},
		{"kitty-launch.sh", "/usr/local/bin/kitty-launch"},
		{"kitty-install.sh", "/usr/local/bin/kitty-install"},
		{"kitty-apt.sh", "/usr/local/sbin/kitty-apt"},
		{"kitty-stream.sh", "/usr/local/bin/kitty-stream"},
		{"kitty-clip.sh", "/usr/local/bin/kitty-clip"},
		{"kitty-open.sh", "/usr/local/bin/kitty-open"},
		{"kitty-theme.sh", "/usr/local/bin/kitty-theme"},
		{"kitty-desktop.sh", "/usr/local/bin/kitty-desktop"},
		{"kitty-grab.c", "/usr/local/src/kitty-grab.c"},
		{"chromium-policy.json", "/etc/chromium/policies/managed/kitties.json"},
		{"menu.xml", "/usr/local/share/kitties/menu.xml"},
		{"kitties-desktop.service", "/etc/systemd/system/kitties-desktop.service"},
	} {
		data, err := files.ReadFile("files/" + file.source)
		if err != nil {
			panic(err)
		}
		fmt.Fprintf(&out, "\nbase64 -d > %s <<'KITTY_FILE'\n%s\nKITTY_FILE\n", file.target, base64.StdEncoding.EncodeToString(data))
	}
	out.Write(finish)
	return out.String()
}
