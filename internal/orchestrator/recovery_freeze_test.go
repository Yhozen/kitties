package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/madkoding/kitties/internal/maintenance"
)

const freezeID = "recovery_00000001"

func TestRecoveryFreezeDrainsActivityAndFencesLifecycleUntilExplicitRelease(t *testing.T) {
	m, runtime, id := cloudFleet(t)
	admitted, finish, err := m.AcquireActivity(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	defer finish()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	prepared := make(chan error, 1)
	go func() { prepared <- m.PrepareRecovery(ctx, freezeID) }()
	deadline := time.After(time.Second)
	for !m.Admission().Active() {
		select {
		case <-deadline:
			t.Fatal("freeze did not close admission")
		case <-time.After(time.Millisecond):
		}
	}
	raw, err := os.ReadFile(filepath.Join(m.cfg.DataDirOr(), RecoveryFreezeFile))
	if err != nil {
		t.Fatal(err)
	}
	var receipt recoveryFreeze
	if json.Unmarshal(raw, &receipt) != nil || receipt.Active != freezeID {
		t.Fatal("drain began before durable hold")
	}
	select {
	case err := <-prepared:
		t.Fatalf("activity was not drained: %v", err)
	default:
	}
	_, child, err := m.Admission().Enter(admitted)
	if err != nil {
		t.Fatalf("existing task could not finish: %v", err)
	}
	child()
	finish()
	if err := <-prepared; err != nil {
		t.Fatal(err)
	}
	if err := m.Start(context.Background(), id); !errors.Is(err, maintenance.ErrBusy) {
		t.Fatalf("start entered validated recovery: %v", err)
	}
	if err := m.PrepareRecovery(context.Background(), freezeID); err != nil {
		t.Fatalf("same operation not idempotent: %v", err)
	}
	if err := m.PrepareRecovery(context.Background(), "recovery_00000002"); !errors.Is(err, ErrRecoveryConflict) {
		t.Fatal(err)
	}
	m.Close()
	reopened, err := New(m.cfg, WithContainers(runtime, nil))
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if err := reopened.Start(context.Background(), id); !errors.Is(err, maintenance.ErrBusy) {
		t.Fatalf("restart lost hold: %v", err)
	}
	if err := reopened.ReleaseRecovery("recovery_00000002"); !errors.Is(err, ErrRecoveryConflict) {
		t.Fatal(err)
	}
	if err := reopened.ReleaseRecovery(freezeID); err != nil {
		t.Fatal(err)
	}
	if err := reopened.ReleaseRecovery(freezeID); err != nil {
		t.Fatal(err)
	}
	if err := reopened.Start(context.Background(), id); err != nil {
		t.Fatalf("release did not reopen admission: %v", err)
	}
}

func TestRecoveryCancellationSurvivesRestartAndRejectsDelayedPrepare(t *testing.T) {
	m, runtime, _ := cloudFleet(t)
	if err := m.ReleaseRecovery(freezeID); err != nil {
		t.Fatal(err)
	}
	m.Close()
	reopened, err := New(m.cfg, WithContainers(runtime, nil))
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if err := reopened.PrepareRecovery(context.Background(), freezeID); !errors.Is(err, ErrRecoveryConflict) {
		t.Fatalf("late prepare ignored cancellation: %v", err)
	}
	if reopened.Admission().Active() {
		t.Fatal("cancelled recovery froze gateway")
	}
}

func TestInterruptedRecoveryDrainKeepsDurableHold(t *testing.T) {
	m, _, id := cloudFleet(t)
	_, finish, err := m.AcquireActivity(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	defer finish()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := m.PrepareRecovery(ctx, freezeID); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if !m.Admission().Active() {
		t.Fatal("cancelled drain reopened admission")
	}
	if err := m.ReleaseRecovery(freezeID); err != nil {
		t.Fatal(err)
	}
}

func TestRecoveryFreezeRejectsDamagedReceiptsBeforeStartup(t *testing.T) {
	for _, raw := range []string{
		`{`,
		`{"active":"invalid"}`,
		`{"released":{"invalid":true}}`,
		`{"active":"recovery_00000001","released":{"recovery_00000001":true}}`,
	} {
		t.Run(raw, func(t *testing.T) {
			cfg := testConfig(t)
			if err := os.MkdirAll(cfg.DataDirOr(), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(cfg.DataDirOr(), RecoveryFreezeFile), []byte(raw), 0o600); err != nil {
				t.Fatal(err)
			}
			if manager, err := New(cfg, WithContainers(newRemote(), nil)); err == nil {
				manager.Close()
				t.Fatal("damaged hold silently opened admission")
			}
		})
	}
}

func TestRecoveryHoldCannotReleaseBeforeCancellationIsDurable(t *testing.T) {
	m, _, _ := cloudFleet(t)
	if err := m.PrepareRecovery(context.Background(), freezeID); err != nil {
		t.Fatal(err)
	}
	staging := filepath.Join(m.cfg.DataDirOr(), RecoveryFreezeFile+".tmp")
	if err := os.Mkdir(staging, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := m.ReleaseRecovery(freezeID); err == nil {
		t.Fatal("acknowledged unpersisted cancellation")
	}
	if !m.Admission().Active() {
		t.Fatal("failed cancellation opened admission")
	}
	if err := os.Remove(staging); err != nil {
		t.Fatal(err)
	}
	if err := m.ReleaseRecovery(freezeID); err != nil {
		t.Fatal(err)
	}
	second := "recovery_00000002"
	if err := m.PrepareRecovery(context.Background(), second); err != nil {
		t.Fatal(err)
	}
	if err := m.ReleaseRecovery(second); err != nil {
		t.Fatal(err)
	}
	if err := m.PrepareRecovery(context.Background(), freezeID); !errors.Is(err, ErrRecoveryConflict) {
		t.Fatal("later recovery forgot old cancellation", err)
	}
}

func TestRecoveryFreezeRejectsUnfinishedLifecycleWithoutReopening(t *testing.T) {
	m, _, id := cloudFleet(t)
	m.mu.Lock()
	m.kitties[id].Operation.Kind = "stop"
	m.mu.Unlock()
	if err := m.PrepareRecovery(context.Background(), freezeID); err == nil {
		t.Fatal("verified unresolved lifecycle")
	}
	if !m.Admission().Active() {
		t.Fatal("failed validation reopened hold before explicit release")
	}
	if err := m.ReleaseRecovery(freezeID); err != nil {
		t.Fatal(err)
	}
}
