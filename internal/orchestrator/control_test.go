package orchestrator

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/madkoding/kitties/internal/desktop"
)

func TestHoldAndInput(t *testing.T) {
	ctx := context.Background()
	f := newFake()
	m, err := New(testConfig(t), WithContainers(f, nil))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 1, 1, 9, 0, 0, 0, time.UTC)
	m.now = func() time.Time { return now }
	k, _ := m.Create(ctx, Spec{Name: "mimi"})
	no := false
	brain, _ := m.Create(ctx, Spec{Name: "brain", Desktop: &no})
	if m.Held(k.ID) {
		t.Error("held from the start")
	}
	if on, err := m.Hold("mimi", true); !on || err != nil || !m.Held(k.ID) {
		t.Errorf("hold = %v %v", on, err)
	}
	took := m.HoldStarted(k.ID)
	if took.IsZero() {
		t.Error("the hold's start is kept")
	}
	if on, err := m.Hold("mimi", false); on || err != nil || m.Held(k.ID) {
		t.Errorf("give back = %v %v", on, err)
	}
	if !m.HoldStarted(k.ID).Equal(took) {
		t.Error("the start outlives the hold")
	}
	if _, err := m.Hold("brain", true); err == nil || m.Held(brain.ID) {
		t.Error("a kitty without a desktop cannot be held")
	}
	if _, err := m.Hold("nobody", true); err == nil {
		t.Error("unknown kitty")
	}
	// Input requires the receipt from taking control.
	grant, err := m.Control(ctx, "mimi", true, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Input(ctx, "mimi", grant.ID, desktop.Action{Name: "click", Args: map[string]any{"x": 5.0, "y": 6.0}}); err != nil {
		t.Fatal(err)
	}
	if !m.Held(k.ID) || !strings.Contains(strings.Join(f.calls, " "), "exec") {
		t.Errorf("input = held %v, calls %v", m.Held(k.ID), f.calls)
	}
	// What the person types may be a password: it goes in on the input, never in the arguments.
	if err := m.Input(ctx, "mimi", grant.ID, desktop.Action{Name: "type", Args: map[string]any{"text": "hunter2"}}); err != nil {
		t.Fatal(err)
	}
	if len(f.inputs) != 1 || f.inputs[0] != "kitty-mimi:hunter2" || strings.Contains(strings.Join(f.execs, " "), "hunter2") {
		t.Errorf("typed: inputs %v execs %v", f.inputs, f.execs)
	}
	if _, err := m.ExecInput(ctx, "brain", "x", "ls"); err == nil {
		t.Error("a kitty without a desktop has no container")
	}
	if _, err := m.ExecInput(ctx, "nobody", "x", "ls"); err == nil {
		t.Error("unknown kitty")
	}
	if err := m.Input(ctx, "mimi", grant.ID, desktop.Action{Name: "run", Args: map[string]any{"argv": []any{"rm"}}}); err == nil {
		t.Error("the person's input runs no programs")
	}
	if err := m.Input(ctx, "nobody", "", desktop.Action{Name: "key", Args: map[string]any{"keys": "a"}}); err == nil {
		t.Error("unknown kitty input")
	}
	// A hold left alone ends by itself.
	now = now.Add(holdIdle + time.Second)
	if m.Held(k.ID) {
		t.Error("an idle hold ends")
	}
}

func TestStreamClipboardAndTheme(t *testing.T) {
	ctx := context.Background()
	f := newFake()
	m, err := New(testConfig(t), WithContainers(f, nil))
	if err != nil {
		t.Fatal(err)
	}
	k, _ := m.Create(ctx, Spec{Name: "mimi"})
	no := false
	_, _ = m.Create(ctx, Spec{Name: "brain", Desktop: &no})
	if rc, err := m.Stream(ctx, "mimi", 8, 70); err != nil || rc == nil {
		t.Errorf("stream = %v", err)
	}
	if _, err := m.Stream(ctx, "brain", 8, 70); err == nil {
		t.Error("a brain-only kitty has no display to stream")
	}
	if _, err := m.Stream(ctx, "nobody", 8, 70); err == nil {
		t.Error("unknown kitty")
	}
	if out, err := m.Clipboard(ctx, "mimi"); err != nil || out != k.Container+":kitty-clip get" {
		t.Errorf("clipboard = %q %v", out, err)
	}
	if err := m.SetClipboard(ctx, "mimi", "hola"); err != nil || f.execs[len(f.execs)-1] != k.Container+":kitty-clip set hola" {
		t.Errorf("set clipboard = %v %v", err, f.execs)
	}
	if err := m.SetClipboard(ctx, "mimi", strings.Repeat("a", MaxClipboard+1)); err == nil {
		t.Error("too long a text")
	}
	// A theme: refused when unknown, saved and put on the desktop at once, and again on start.
	bad := "neon"
	if _, err := m.Edit("mimi", Update{Theme: &bad}); err == nil {
		t.Error("an unknown theme")
	}
	light := "Greybird-dark"
	got, err := m.Edit("mimi", Update{Theme: &light})
	if err != nil || got.Theme != "Greybird-dark" || f.execs[len(f.execs)-1] != k.Container+":kitty-theme Greybird-dark" {
		t.Fatalf("theme = %+v %v %v", got, err, f.execs)
	}
	f.execs = nil
	if err := m.Start(ctx, "mimi"); err != nil || len(f.execs) != 1 || f.execs[0] != k.Container+":kitty-theme Greybird-dark" {
		t.Errorf("start = %v %v", err, f.execs)
	}
	// Back to the image's own theme: Numix goes on the running desktop again.
	own := ""
	f.execs = nil
	if got, err := m.Edit("mimi", Update{Theme: &own}); err != nil || got.Theme != "" || len(f.execs) != 1 || f.execs[0] != k.Container+":kitty-theme Numix" {
		t.Errorf("own theme = %+v %v %v", got, err, f.execs)
	}
}

// A start with the image's own theme runs nothing more.
func TestStartWithoutTheme(t *testing.T) {
	f := newFake()
	m, _ := New(testConfig(t), WithContainers(f, nil))
	_, _ = m.Create(context.Background(), Spec{Name: "mimi"})
	if err := m.Start(context.Background(), "mimi"); err != nil || len(f.execs) != 0 {
		t.Errorf("start = %v %v", err, f.execs)
	}
}

func TestAnyHeld(t *testing.T) {
	m, err := New(testConfig(t), WithContainers(newFake(), nil))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 1, 1, 9, 0, 0, 0, time.UTC)
	m.now = func() time.Time { return now }
	_, _ = m.Create(context.Background(), Spec{Name: "mimi"})
	if m.AnyHeld() {
		t.Error("held from the start")
	}
	_, _ = m.Hold("mimi", true)
	if !m.AnyHeld() {
		t.Error("a held desktop is not seen")
	}
	now = now.Add(holdIdle + time.Second)
	if m.AnyHeld() {
		t.Error("an idle hold counts")
	}
}
