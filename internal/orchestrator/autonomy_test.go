package orchestrator

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/madkoding/kitties/internal/config"
	"github.com/madkoding/kitties/internal/kitty"
	"github.com/madkoding/kitties/internal/notify"
)

func TestLimitsAndBackup(t *testing.T) {
	cfg := testConfig(t)
	m, err := New(cfg, WithContainers(newFake(), nil))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	ana, err := m.Create(ctx, Spec{Name: "ana", Limits: kitty.Limits{MaxTokens: 10, Retries: 2}, Backup: "bo"})
	if err != nil || ana.Limits.MaxTokens != 10 || ana.Backup != "bo" {
		t.Fatalf("create = %+v %v", ana, err)
	}
	if _, err := m.Create(ctx, Spec{Name: "bad", Limits: kitty.Limits{MaxTokens: -1}}); err == nil {
		t.Error("negative limits are refused")
	}
	if _, err := m.Create(ctx, Spec{Name: "self", Backup: "self"}); err == nil {
		t.Error("a kitty cannot back itself up")
	}
	bo, _ := m.Create(ctx, Spec{Name: "bo"})
	// Edit changes the limits and the backup, by name or id, and refuses nonsense.
	lim := kitty.Limits{MaxSeconds: 5}
	backup := bo.ID
	got, err := m.Edit("ana", Update{Limits: &lim, Backup: &backup})
	if err != nil || got.Limits != lim || got.Backup != "bo" {
		t.Errorf("edit = %+v %v", got, err)
	}
	none := ""
	if got, err := m.Edit("ana", Update{Backup: &none}); err != nil || got.Backup != "" {
		t.Errorf("clearing the backup = %+v %v", got, err)
	}
	nobody := "nobody"
	if _, err := m.Edit("ana", Update{Backup: &nobody}); err == nil {
		t.Error("an unknown backup is refused")
	}
	self := "ana"
	if _, err := m.Edit("ana", Update{Backup: &self}); err == nil {
		t.Error("self backup is refused on edit")
	}
	bad := kitty.Limits{Retries: 99}
	if _, err := m.Edit("ana", Update{Limits: &bad}); err == nil {
		t.Error("bad limits are refused on edit")
	}
	// Bootstrap carries limits and backup from the file.
	cfg2 := testConfig(t)
	cfg2.Kitties[0].Limits = kitty.Limits{MaxRounds: 7}
	cfg2.Kitties[0].Backup = "team"
	m2, _ := New(cfg2, WithContainers(newFake(), nil))
	_ = m2.Bootstrap(ctx)
	if solo, err := m2.Get("solo"); err != nil || solo.Limits.MaxRounds != 7 || solo.Backup != "team" {
		t.Errorf("bootstrap = %+v %v", solo, err)
	}
	// The persisted kitty keeps them.
	m3, _ := New(cfg2, WithContainers(newFake(), nil))
	if solo, _ := m3.Get("solo"); solo.Limits.MaxRounds != 7 || solo.Backup != "team" {
		t.Error("limits and backup survive a restart")
	}
}

func TestWatchdog(t *testing.T) {
	cfg := testConfig(t)
	f := newFake()
	m, err := New(cfg, WithContainers(f, nil))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	_ = m.Bootstrap(ctx) // solo gets a container; team-1 and team-2 have none
	var recovered, warned []string
	rec := func(k *kitty.Kitty, what string) { recovered = append(recovered, k.Name+": "+what) }
	warn := func(format string, a ...any) { warned = append(warned, fmt.Sprintf(format, a...)) }
	// All well: nothing happens.
	m.Check(ctx, rec, warn)
	if len(recovered)+len(warned) != 0 {
		t.Errorf("quiet: %v %v", recovered, warned)
	}
	// The container stopped: it is started again.
	f.running["kitty-solo"] = false
	m.Check(ctx, rec, warn)
	if len(recovered) != 1 || recovered[0] != "solo: its container had stopped" || !f.running["kitty-solo"] {
		t.Errorf("stopped: %v", recovered)
	}
	// The container is gone: it is made again.
	delete(f.exists, "kitty-solo")
	delete(f.running, "kitty-solo")
	m.Check(ctx, rec, warn)
	if len(recovered) != 2 || recovered[1] != "solo: its container was gone" || !f.exists["kitty-solo"] {
		t.Errorf("gone: %v", recovered)
	}
	// A kitty in error is tried again, and recovered when the runtime answers.
	solo, _ := m.Get("solo")
	_ = m.setStatus(solo.ID, kitty.StatusError, "boom")
	m.Check(ctx, rec, warn)
	if k, _ := m.Get("solo"); len(recovered) != 3 || !strings.HasPrefix(recovered[2], "solo: it was in error: boom") || k.Status != kitty.StatusRunning {
		t.Errorf("error: %v %s", recovered, k.Status)
	}
	// When the start fails the watchdog warns and leaves the kitty in error.
	f.running["kitty-solo"] = false
	f.fail = "start"
	m.Check(ctx, rec, warn)
	if len(warned) != 1 || !strings.Contains(warned[0], "solo") {
		t.Errorf("warn: %v", warned)
	}
	m.Check(ctx, rec, warn)
	if len(warned) != 1 {
		t.Fatal("watchdog retried before the persisted backoff")
	}
	failed, _ := m.Get(solo.ID)
	m.now = func() time.Time { return failed.Operation.RetryAt.Add(time.Nanosecond) }
	m.Check(ctx, rec, warn)
	if len(warned) != 2 || !strings.Contains(warned[1], "still fails") {
		t.Errorf("still failing: %v", warned)
	}
	f.fail = "list"
	m.Check(ctx, rec, warn)
	if len(warned) != 3 || !strings.Contains(warned[2], "list failed") {
		t.Errorf("list failure: %v", warned)
	}
	// Without a runtime there is nothing to watch; Watch stops with its context.
	brainOnly, _ := New(testConfig(t), WithContainers(nil, errors.New("no docker")))
	brainOnly.Check(ctx, rec, warn)
	wctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { m.Watch(wctx, 10, rec, warn); close(done) }()
	cancel()
	<-done
}

func TestInboundSecret(t *testing.T) {
	cfg := testConfig(t)
	cfg.Connectors["sl"] = cfgConnector(cfg.Connectors["sl"], "inbound_secret", "shh")
	m, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if secret, err := m.InboundSecret("sl"); err != nil || secret != "shh" {
		t.Errorf("secret = %q %v", secret, err)
	}
	if secret, err := m.InboundSecret("dc"); err != nil || secret != "" {
		t.Errorf("no secret = %q %v", secret, err)
	}
	if _, err := m.InboundSecret("zz"); err == nil {
		t.Error("unknown connector")
	}
}

// cfgConnector returns the connector with one more setting.
func cfgConnector(c config.Connector, key, value string) config.Connector {
	settings := map[string]string{}
	for k, v := range c.Settings {
		settings[k] = v
	}
	settings[key] = value
	c.Settings = settings
	return c
}

func TestNotifySettings(t *testing.T) {
	cfg := testConfig(t)
	m, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if c := m.Notify(); c.Connector != "" {
		t.Errorf("off by default: %+v", c)
	}
	v := m.Settings()
	if v.Notify.Connector != "" || len(v.Notify.On) != 0 || strings.Join(v.NotifyEvents, ",") != "help,approval,goal_done,goal_blocked,recovered,budget,updated" {
		t.Errorf("view = %+v %v", v.Notify, v.NotifyEvents)
	}
	if err := m.SetNotify(notify.Config{Connector: "nope"}); err == nil {
		t.Error("an unknown connector is refused")
	}
	if err := m.SetNotify(notify.Config{Connector: "sl", On: []string{"boom"}}); err == nil {
		t.Error("an unknown event is refused")
	}
	if err := m.SetNotify(notify.Config{Connector: "sl", On: []string{"help", "goal_done"}}); err != nil {
		t.Fatal(err)
	}
	if c := m.Notify(); c.Connector != "sl" || len(c.On) != 2 {
		t.Errorf("set = %+v", c)
	}
	// It survives a restart, on top of the file.
	again, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if c := again.Notify(); c.Connector != "sl" || strings.Join(c.On, ",") != "help,goal_done" {
		t.Errorf("reloaded = %+v", c)
	}
	// Removing the connector turns notifications off instead of leaving them pointing nowhere.
	if err := again.RemoveConnector("sl"); err != nil {
		t.Fatal(err)
	}
	if c := again.Notify(); c.Connector != "" {
		t.Errorf("after removing the connector = %+v", c)
	}
	third, _ := New(cfg)
	if third.Notify().Connector != "" {
		t.Error("and it stays off")
	}
	// From the file: a notify block names a configured connector.
	file, err := config.Parse([]byte("providers:\n  p:\n    kind: ollama\nconnectors:\n  hook:\n    kind: webhook\n    url: http://h\nnotify:\n  connector: hook\n  on: [help]\n"))
	if err != nil || file.Notify.Connector != "hook" {
		t.Fatalf("file = %+v %v", file.Notify, err)
	}
	for _, bad := range []string{"notify:\n  connector: nope\n", "notify:\n  connector: hook\n  on: [boom]\n"} {
		if _, err := config.Parse([]byte("providers:\n  p:\n    kind: ollama\nconnectors:\n  hook:\n    kind: webhook\n    url: http://h\n" + bad)); err == nil {
			t.Errorf("%q must be refused", bad)
		}
	}
}
