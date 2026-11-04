package orchestrator

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/madkoding/kitties/internal/computer"
	"github.com/madkoding/kitties/internal/kitty"
	"github.com/madkoding/kitties/internal/maintenance"
)

type exportingComputer struct {
	*remoteComputer
	export func(context.Context, string, io.Writer) error
}

func (f *exportingComputer) ExportHome(ctx context.Context, ref string, w io.Writer) error {
	return f.export(ctx, ref, w)
}

func TestRecoveryCaptureSleepsBeforeExportAndResumesAfterFailure(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "failure"}[fail], func(t *testing.T) {
			f := &exportingComputer{remoteComputer: newRemote()}
			m, err := New(testConfig(t), WithContainers(f, nil))
			if err != nil {
				t.Fatal(err)
			}
			defer m.Close()
			k, err := m.Create(context.Background(), Spec{Name: "mimi"})
			if err != nil {
				t.Fatal(err)
			}
			if err = m.Start(context.Background(), k.ID); err != nil {
				t.Fatal(err)
			}
			f.export = func(ctx context.Context, ref string, w io.Writer) error {
				current, _ := m.Get(k.ID)
				if current.Status != kitty.StatusSleeping || current.Computer.CheckpointID == "" || ref != current.Computer.ID {
					t.Fatal("exported a mutable or unidentified computer")
				}
				if _, err := m.Acquire(context.Background(), k.ID); !errors.Is(err, maintenance.ErrBusy) {
					t.Fatalf("new work entered capture: %v", err)
				}
				if fail {
					return errors.New("export interrupted")
				}
				_, err := io.WriteString(w, "saved-home")
				return err
			}
			ctx, leave, err := m.BeginMaintenance(context.Background(), true)
			if err != nil {
				t.Fatal(err)
			}
			dir := filepath.Join(t.TempDir(), "homes")
			homes, resume, captureErr := m.CaptureHomes(ctx, dir)
			if (captureErr != nil) != fail {
				t.Fatalf("capture error=%v", captureErr)
			}
			if !fail {
				if len(homes) != 1 {
					t.Fatal("home missing")
				}
				raw, err := os.ReadFile(filepath.Join(dir, k.ID+".tar"))
				if err != nil || string(raw) != "saved-home" {
					t.Fatalf("home changed: %q %v", raw, err)
				}
			}
			if err = resume(); err != nil {
				t.Fatal(err)
			}
			leave()
			current, _ := m.Get(k.ID)
			if current.Status != kitty.StatusRunning || current.Availability != computer.Enabled {
				t.Fatalf("did not restore prior availability: %+v", current)
			}
		})
	}
}

func TestMaintenanceDoesNotInterruptAnActiveTask(t *testing.T) {
	m, _, id := cloudFleet(t)
	ctx, finish, err := m.AcquireActivity(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = m.BeginMaintenance(context.Background(), true); !errors.Is(err, maintenance.ErrBusy) {
		t.Fatalf("idle backup interrupted work: %v", err)
	}
	_, nested, err := m.AcquireActivity(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	nested()
	finish()
	_, resume, err := m.BeginMaintenance(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	resume()
}

type retainedComputer struct {
	*exportingComputer
	retained []computer.Recovery
	purged   string
}

func (f *retainedComputer) Recoveries() []computer.Recovery { return f.retained }
func (f *retainedComputer) PurgeCheckpoint(_ context.Context, name string) error {
	f.purged = name
	return nil
}

func TestRetainedRecoveryCaptureAndPurgeRequireCleanRemovedOwnership(t *testing.T) {
	f := &retainedComputer{exportingComputer: &exportingComputer{remoteComputer: newRemote(), export: func(_ context.Context, name string, w io.Writer) error { _, err := io.WriteString(w, name); return err }}}
	m, err := New(testConfig(t), WithContainers(f, nil))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	for _, scenario := range []string{"retained", "pending", "invalid", "no-checkpoint"} {
		r := computer.Recovery{Name: "kitty-removed", Removed: true, Computer: computer.Reference{CheckpointID: "saved"}}
		switch scenario {
		case "pending":
			r.Pending = "remove"
		case "invalid":
			r.Name = "../foreign"
		case "no-checkpoint":
			r.Computer.CheckpointID = ""
		}
		f.retained = []computer.Recovery{{Name: "active"}, r}
		ctx, leave, err := m.BeginMaintenance(context.Background(), true)
		if err != nil {
			t.Fatal(err)
		}
		homes, resume, err := m.CaptureHomesTo(ctx, func(name string, stream func(io.Writer) error) error {
			if name != "removed-kitty-removed" {
				t.Fatalf("unstable retained name %s", name)
			}
			return stream(io.Discard)
		})
		if scenario == "pending" || scenario == "invalid" {
			if err == nil {
				t.Fatal("unsafe retained export accepted")
			}
		} else if err != nil {
			t.Fatal(err)
		}
		if scenario == "retained" && len(homes) != 1 {
			t.Fatal("removed computer home omitted")
		}
		if resume != nil {
			if err := resume(); err != nil {
				t.Fatal(err)
			}
		}
		leave()
	}
	f.retained = []computer.Recovery{{Name: "active"}, {Name: "pending", Removed: true, Pending: "remove"}, {Name: "removed", Removed: true}}
	items, err := m.Recoveries()
	if err != nil || len(items) != 3 {
		t.Fatal("recovery inventory lost")
	}
	for _, name := range []string{"active", "pending"} {
		if err = m.PurgeRetained(context.Background(), name); !errors.Is(err, ErrRecoveryBusy) {
			t.Fatal("purged an active recovery")
		}
	}
	if err = m.PurgeRetained(context.Background(), "removed"); err != nil || f.purged != "removed" {
		t.Fatal("removed recovery cannot be purged")
	}
	if err = m.PurgeRetained(context.Background(), "foreign"); !errors.Is(err, ErrNotFound) {
		t.Fatal("foreign recovery accepted")
	}
}

func TestMaintenanceRequiresSupportedRuntimeAndExclusiveOwnership(t *testing.T) {
	m, err := New(testConfig(t), WithContainers(newFake(), nil))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	if _, _, err = m.CaptureHomesTo(context.Background(), nil); err == nil {
		t.Fatal("unowned capture accepted")
	}
	if items, err := m.Recoveries(); err != nil || len(items) != 0 {
		t.Fatal("legacy runtime advertised recovery inventory")
	}
	ctx, resume, err := m.BeginMaintenance(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	if homes, finish, err := m.CaptureHomesTo(ctx, nil); err != nil || len(homes) != 0 {
		t.Fatal("empty fleet cannot be captured")
	} else {
		_ = finish()
	}
	resume()
	k, err := m.Create(context.Background(), Spec{Name: "legacy"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, resume, err = m.BeginMaintenance(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = m.CaptureHomesTo(ctx, nil); err == nil {
		t.Fatal("runtime without full-home export accepted")
	}
	resume()
	if err = m.beginOperation(k.ID, "start", computer.Enabled); err != nil {
		t.Fatal(err)
	}
	if _, _, err = m.BeginMaintenance(context.Background(), true); err == nil || m.Admission().Active() {
		t.Fatal("unfinished operation entered capture or left admission closed")
	}
}

func TestMaintenanceCancellationReleasesHeldDesktopWithoutStoppingIt(t *testing.T) {
	m, _, id := cloudFleet(t)
	if _, err := m.Hold(id, true); err != nil {
		t.Fatal(err)
	}
	if _, _, err := m.BeginMaintenance(context.Background(), true); !errors.Is(err, maintenance.ErrBusy) {
		t.Fatal("automatic backup took held desktop")
	}
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan error, 1)
	go func() {
		_, resume, err := m.BeginMaintenance(ctx, false)
		if resume != nil {
			resume()
		}
		finished <- err
	}()
	deadline := time.After(time.Second)
	for !m.Admission().Active() {
		select {
		case <-deadline:
			t.Fatal("manual maintenance did not begin")
		default:
			runtime.Gosched()
		}
	}
	cancel()
	if err := <-finished; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if m.Admission().Active() {
		t.Fatal("cancelled backup retained exclusive admission")
	}
	k, _ := m.Get(id)
	if k.Status != kitty.StatusRunning || !m.Held(id) {
		t.Fatal("cancelled backup interrupted desktop owner")
	}
	_, _ = m.Hold(id, false)
}

func TestDesktopStreamReleasesActivityExactlyOnceAtEOF(t *testing.T) {
	m, _, id := cloudFleet(t)
	stream, err := m.Stream(context.Background(), id, 1, 50)
	if err != nil {
		t.Fatal(err)
	}
	if !m.Admission().Busy() {
		t.Fatal("viewer did not hold admission")
	}
	if _, err = io.ReadAll(stream); err != nil {
		t.Fatal(err)
	}
	if err = stream.Close(); err != nil {
		t.Fatal(err)
	}
	if m.Admission().Busy() {
		t.Fatal("closed viewer kept backup blocked")
	}
}
