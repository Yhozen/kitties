package boat

import (
	"bytes"
	"context"
	"fmt"
	"image/png"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/madkoding/kitties/internal/container"
)

func TestLiveBoatTemplateFleet(t *testing.T) {
	if os.Getenv("KITTIES_BOAT_FLEET_LIVE") != "1" {
		t.Skip("opt-in paid five-computer acceptance")
	}
	dir := os.Getenv("KITTIES_BOAT_LIVE_STATE")
	if dir == "" {
		t.Fatal("persistent fleet state directory required")
	}
	m, e := New(Options{StateDir: dir, APIKey: os.Getenv("BOAT_DEV_API_KEY"), MaxRunning: 5})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = m.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		for _, r := range m.records() {
			if r.Template || r.Removed || r.RemoteID == "" {
				continue
			}
			if err := m.Stop(cleanup, r.Name); err != nil {
				t.Errorf("fleet cleanup %s: %v", r.Name, err)
			}
		}
	})
	if e = m.CheckAccess(ctx); e != nil {
		t.Fatal(e)
	}
	start := time.Now()
	ids := make([]string, 0, 5)
	for i := 1; i <= 5; i++ {
		name := fmt.Sprintf("kitty-fleet-%d", i)
		created := time.Now()
		id, err := m.Up(ctx, container.Spec{Name: name, KittyName: fmt.Sprintf("fleet-%d", i)})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
		t.Logf("ready name=%s id=%s elapsed=%s", name, id, time.Since(created).Round(time.Millisecond))
		marker := "fleet-marker-" + name
		script := `test ! -e /home/kitty/work/durable-marker && test -z "${BOAT_DEV_API_KEY:-}" && test -z "${OPENAI_API_KEY:-}" && printf '%s' "$1" > /home/kitty/work/fleet-marker && kitty-clip set "$1" && xdotool mousemove 120 140 click 1 key Escape`
		if _, err = m.Exec(ctx, id, "sh", "-c", script, "sh", marker); err != nil {
			t.Fatal(err)
		}
		shot, err := m.Screenshot(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = png.Decode(bytes.NewReader(shot)); err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(fmt.Sprintf("%s/fleet-%d.png", dir, i), shot, 0600); err != nil {
			t.Fatal(err)
		}
		info, err := m.Exec(ctx, id, "sh", "-c", "getconf _NPROCESSORS_ONLN; sed -n '1p' /proc/meminfo")
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("resources %s: %s", id, strings.TrimSpace(info))
	}
	all, err := m.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	running := 0
	for _, s := range all {
		if s.Running {
			running++
		}
	}
	if running != 5 {
		t.Fatalf("running=%d", running)
	}
	if _, err = m.Up(ctx, container.Spec{Name: "kitty-fleet-sixth", KittyName: "fleet-sixth"}); err == nil || !strings.Contains(err.Error(), "limit reached") {
		t.Fatalf("sixth computer was not rejected: %v", err)
	}
	for i, id := range ids {
		expected := fmt.Sprintf("fleet-marker-kitty-fleet-%d", i+1)
		got, err := m.Exec(ctx, id, "cat", "/home/kitty/work/fleet-marker")
		if err != nil || got != expected {
			t.Fatalf("workspace isolation %s: %q %v", id, got, err)
		}
		got, err = m.Exec(ctx, id, "kitty-clip", "get")
		if err != nil || got != expected {
			t.Fatalf("clipboard isolation %s: %q %v", id, got, err)
		}
	}
	template, err := m.lookup(m.templateName())
	if err != nil || !template.Removed || template.CheckpointID == "" {
		t.Fatalf("template source not cleaned: %v", err)
	}
	for _, id := range ids {
		stopping := time.Now()
		if err = m.Stop(ctx, id); err != nil {
			t.Fatal(err)
		}
		ref, err := m.Resolve(ctx, id)
		if err != nil || ref.CheckpointID == "" {
			t.Fatalf("missing recovery %s", id)
		}
		t.Logf("stopped id=%s checkpoint=%s elapsed=%s", id, ref.CheckpointID, time.Since(stopping).Round(time.Millisecond))
	}
	t.Logf("five isolated desktops and sixth rejection verified; template=%s total=%s", template.CheckpointID, time.Since(start).Round(time.Millisecond))
}
