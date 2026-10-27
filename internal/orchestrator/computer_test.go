package orchestrator

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/madkoding/kitties/internal/computer"
	"github.com/madkoding/kitties/internal/container"
	"github.com/madkoding/kitties/internal/kitty"
)

type remoteComputer struct {
	*fakeContainers
	ref      computer.Reference
	kind     string
	restored string
}

func newRemote() *remoteComputer {
	return &remoteComputer{fakeContainers: newFake(), kind: "boat", ref: computer.Reference{Runtime: "boat", ID: "bx-original", OwnerID: "deployment", Generation: 1}}
}
func (f *remoteComputer) Capabilities() computer.Capabilities {
	return computer.Capabilities{Kind: f.kind, PersistentDisk: true, GuestWorkspace: true}
}
func (f *remoteComputer) Up(_ context.Context, s container.Spec) (string, error) {
	if err := f.op("up"); err != nil {
		return "", err
	}
	f.exists[f.ref.ID], f.running[f.ref.ID] = true, true
	return f.ref.ID, nil
}
func (f *remoteComputer) Start(ctx context.Context, id string) error {
	if err := f.fakeContainers.Start(ctx, id); err != nil {
		return err
	}
	if f.restored != "" {
		delete(f.exists, f.ref.ID)
		delete(f.running, f.ref.ID)
		f.ref.ID, f.ref.Generation = f.restored, f.ref.Generation+1
		f.exists[f.ref.ID], f.running[f.ref.ID] = true, true
		f.restored = ""
	}
	return nil
}
func (f *remoteComputer) Resolve(context.Context, string) (computer.Reference, error) {
	return f.ref, nil
}
func (f *remoteComputer) Stop(ctx context.Context, id string) error {
	if err := f.fakeContainers.Stop(ctx, id); err != nil {
		return err
	}
	f.ref.CheckpointID = "saved-checkpoint"
	return nil
}

func TestComputerIdentitySurvivesGatewayRestartAndRestore(t *testing.T) {
	ctx := context.Background()
	cfg := testConfig(t)
	f := newRemote()
	m, err := New(cfg, WithContainers(f, nil))
	if err != nil {
		t.Fatal(err)
	}
	k, err := m.Create(ctx, Spec{Name: "mimi"})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Start(ctx, k.ID); err != nil {
		t.Fatal(err)
	}
	m, err = New(cfg, WithContainers(f, nil))
	if err != nil {
		t.Fatal(err)
	}
	k, _ = m.Get(k.ID)
	if k.Provider != "p" || k.Container != "kitty-mimi" || k.Computer.ID != "bx-original" || k.Computer.OwnerID != "deployment" || k.Workspace != container.Workdir {
		t.Fatalf("persisted identity = %+v", k)
	}
	out, err := m.Exec(ctx, k.ID, "pwd")
	if err != nil || out != "bx-original:pwd" {
		t.Fatalf("execution target = %q, %v", out, err)
	}
	if err := m.Stop(ctx, k.ID); err != nil {
		t.Fatal(err)
	}
	k, _ = m.Get(k.ID)
	if k.Availability != computer.Disabled || k.Computer.CheckpointID != "saved-checkpoint" {
		t.Fatalf("stopped identity = %+v", k)
	}
	delete(f.exists, f.ref.ID)
	delete(f.running, f.ref.ID)
	f.restored = "bx-restored"
	f.calls = nil
	if err := m.Start(ctx, k.ID); err != nil {
		t.Fatal(err)
	}
	restored, _ := m.Get(k.ID)
	if restored.ID != k.ID || restored.Computer.ID != "bx-restored" || restored.Computer.Generation != 2 {
		t.Fatalf("restored identity = %+v", restored)
	}
	for _, call := range f.calls {
		if call == "up" {
			t.Fatal("missing durable machine was replaced with a blank computer")
		}
	}
	out, err = m.Exec(ctx, k.ID, "pwd")
	if err != nil || out != "bx-restored:pwd" {
		t.Fatalf("restored execution target = %q, %v", out, err)
	}
}

func TestRuntimeChangeDoesNotMigrateExistingComputers(t *testing.T) {
	ctx := context.Background()
	cfg := testConfig(t)
	f := newRemote()
	m, _ := New(cfg, WithContainers(f, nil))
	k, _ := m.Create(ctx, Spec{Name: "mimi"})
	if err := m.Start(ctx, k.ID); err != nil {
		t.Fatal(err)
	}
	f.kind = "lima"
	if _, err := New(cfg, WithContainers(f, nil)); err == nil || !strings.Contains(err.Error(), "belongs to runtime") {
		t.Fatalf("runtime changed without migration: %v", err)
	}
	// An older container state cannot silently become a cloud computer either.
	old := []map[string]any{{"id": "old", "name": "old", "desktop": true, "container": "kitty-old", "workspace": "/old/work/old", "status": "running"}}
	data, _ := json.Marshal(old)
	if err := os.WriteFile(filepath.Join(cfg.DataDir, "kitties.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	f.kind = "boat"
	if _, err := New(cfg, WithContainers(f, nil)); err == nil || !strings.Contains(err.Error(), "legacy container workspace") {
		t.Fatalf("legacy state migrated: %v", err)
	}
}

func TestPendingStopIsResumedWithoutWakingDisabledComputer(t *testing.T) {
	ctx := context.Background()
	cfg := testConfig(t)
	f := newRemote()
	m, _ := New(cfg, WithContainers(f, nil))
	k, _ := m.Create(ctx, Spec{Name: "mimi"})
	if err := m.Start(ctx, k.ID); err != nil {
		t.Fatal(err)
	}
	f.fail = "stop"
	if err := m.Stop(ctx, k.ID); err == nil {
		t.Fatal("stop unexpectedly succeeded")
	}
	m, err := New(cfg, WithContainers(f, nil))
	if err != nil {
		t.Fatal(err)
	}
	k, _ = m.Get(k.ID)
	if k.Availability != computer.Disabled || k.Operation.Kind != "stop" {
		t.Fatalf("lost stop intent: %+v", k)
	}
	f.fail, f.calls = "", nil
	m.Check(ctx, func(*kitty.Kitty, string) { t.Error("stop retried before backoff expired") }, t.Logf)
	retryAt := k.Operation.RetryAt
	m.now = func() time.Time { return retryAt.Add(time.Nanosecond) }
	m.Check(ctx, func(*kitty.Kitty, string) {}, t.Logf)
	k, _ = m.Get(k.ID)
	if k.Status != kitty.StatusStopped || k.Operation.Kind != "" {
		t.Fatalf("stop not resumed: %+v", k)
	}
	m.Check(ctx, func(*kitty.Kitty, string) {}, t.Logf)
	for _, call := range f.calls {
		if call == "start" || call == "up" {
			t.Fatalf("disabled computer woken: %v", f.calls)
		}
	}
}

func TestPersistentComputerCannotBeImageReplacedOrInventoriedAway(t *testing.T) {
	ctx := context.Background()
	cfg := testConfig(t)
	cfg.Containers.AutoUpdate = true
	f := newRemote()
	m, _ := New(cfg, WithContainers(f, nil))
	k, _ := m.Create(ctx, Spec{Name: "mimi"})
	if err := m.Start(ctx, k.ID); err != nil {
		t.Fatal(err)
	}
	f.stale, f.calls = true, nil
	m.CheckUpdates(ctx, func(*kitty.Kitty) { t.Fatal("durable computer image updated") }, t.Logf)
	if _, err := m.UpdateInBackground(k.ID); err == nil {
		t.Fatal("image replacement allowed")
	}
	f.fail = "list"
	if err := m.Start(ctx, k.ID); err == nil {
		t.Fatal("inventory failure ignored")
	}
	for _, call := range f.calls {
		if call == "up" || call == "rm" || strings.HasPrefix(call, "pull ") {
			t.Fatalf("destructive operation after unavailable inventory: %v", f.calls)
		}
	}
}

func TestInterruptedStartKeepsItsPendingOperation(t *testing.T) {
	ctx := context.Background()
	cfg := testConfig(t)
	f := newRemote()
	m, _ := New(cfg, WithContainers(f, nil))
	k, _ := m.Create(ctx, Spec{Name: "mimi"})
	if err := m.beginOperation(k.ID, "start", computer.Enabled); err != nil {
		t.Fatal(err)
	}
	reloaded, err := New(cfg, WithContainers(f, nil))
	if err != nil {
		t.Fatal(err)
	}
	k, _ = reloaded.Get(k.ID)
	if k.Status != kitty.StatusStarting || k.Operation.Kind != "start" {
		t.Fatalf("unfinished start was reported as running: %+v", k)
	}
	reloaded.Check(ctx, func(*kitty.Kitty, string) {}, t.Logf)
	k, _ = reloaded.Get(k.ID)
	if k.Status != kitty.StatusRunning || k.Operation.Kind != "" || k.Computer.ID != "bx-original" {
		t.Fatalf("pending start was not recovered: %+v", k)
	}
}
