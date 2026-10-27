package boat

import (
	"context"
	"github.com/madkoding/kitties/internal/container"
	"os"
	"strings"
	"testing"
	"time"
)

func TestLiveBoatTemplateHydration(t *testing.T) {
	if os.Getenv("KITTIES_BOAT_FLEET_LIVE") != "1" {
		t.Skip("paid hydration acceptance")
	}
	m, e := New(Options{StateDir: os.Getenv("KITTIES_BOAT_LIVE_STATE"), APIKey: os.Getenv("BOAT_DEV_API_KEY"), MaxRunning: 1})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { m.Close() })
	name := "kitty-fleet-hydration"
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		if r, e := m.lookup(name); e == nil && !r.Removed && r.RemoteID != "" {
			if e = m.Stop(cleanup, name); e != nil {
				t.Errorf("hydration cleanup: %v", e)
			}
		}
	})
	id, e := m.Up(ctx, container.Spec{Name: name, KittyName: "hydration-canary"})
	if e != nil {
		t.Fatal(e)
	}
	check := `pid=$(systemctl show --property=MainPID --value kitties-desktop.service); test "$pid" != 0; test "/proc/$pid/cwd" -ef /home/kitty/work; printf '%s' "$pid"`
	before, e := m.Exec(ctx, id, "sh", "-c", check)
	if e != nil {
		t.Fatal("desktop still holds retired workspace", e)
	}
	if e = m.Start(ctx, id); e != nil {
		t.Fatal(e)
	}
	after, e := m.Exec(ctx, id, "sh", "-c", check)
	if e != nil || before != after {
		t.Fatal("ordinary wake restarted live desktop", e)
	}
	marker := "terminal-marker-" + randomID()
	command := "printf '%s' '" + marker + "' > terminal-marker"
	script := `window=$(xdotool search --onlyvisible --class XTerm | head -n 1); test -n "$window"; xdotool windowactivate --sync "$window"; xdotool key --clearmodifiers ctrl+u; xdotool type --clearmodifiers --delay 1 "$1"; xdotool key Return; for i in 1 2 3 4 5; do test -s /home/kitty/work/terminal-marker && exit 0; sleep 1; done; exit 1`
	if _, e = m.Exec(ctx, id, "sh", "-c", script, "sh", command); e != nil {
		t.Fatal("terminal did not write current home", e)
	}
	if e = m.Remove(ctx, id); e != nil {
		t.Fatal(e)
	}
	if e = m.Start(ctx, id); e != nil {
		t.Fatal(e)
	}
	ref, e := m.Resolve(ctx, id)
	if e != nil || ref.ID == id {
		t.Fatal("did not restore onto new VM", e)
	}
	out, e := m.Exec(ctx, ref.ID, "cat", "/home/kitty/work/terminal-marker")
	if e != nil || strings.TrimSpace(out) != marker {
		t.Fatal("terminal work did not survive fresh restore", e)
	}
	if _, e = m.Exec(ctx, ref.ID, "sh", "-c", check); e != nil {
		t.Fatal("restored service cwd is stale", e)
	}
	if e = m.Stop(ctx, ref.ID); e != nil {
		t.Fatal(e)
	}
	t.Log("hydrated service cwd and terminal-created file verified on fresh restore", id, ref.ID)
}
