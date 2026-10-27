package orchestrator

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/madkoding/kitties/internal/computer"
	"github.com/madkoding/kitties/internal/kitty"
)

type renewableComputer struct {
	*remoteComputer
	renews atomic.Int32
}

func (f *renewableComputer) Renew(context.Context, string) error { f.renews.Add(1); return nil }

func cloudFleet(t *testing.T) (*Manager, *renewableComputer, string) {
	t.Helper()
	f := &renewableComputer{remoteComputer: newRemote()}
	m, err := New(testConfig(t), WithContainers(f, nil))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	k, err := m.Create(context.Background(), Spec{Name: "mimi"})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Start(context.Background(), k.ID); err != nil {
		t.Fatal(err)
	}
	return m, f, k.ID
}

func waitOperation(t *testing.T, m *Manager, id, operation string) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		k, _ := m.Get(id)
		if k.Operation.Kind == operation {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("operation %s never appeared", operation)
		case <-time.After(time.Millisecond):
		}
	}
}

func TestStopDrainsLeasedTaskAndKeepsDisabled(t *testing.T) {
	m, f, id := cloudFleet(t)
	release, err := m.Acquire(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	stopped := make(chan error, 1)
	go func() { stopped <- m.Stop(ctx, id) }()
	waitOperation(t, m, id, "stop")
	select {
	case err := <-stopped:
		t.Fatalf("stopped an active task: %v", err)
	default:
	}
	// Existing leased work can finish while the lifecycle gate refuses new work.
	if _, err := m.Exec(computer.WithActivity(ctx, id), id, "pwd"); err != nil {
		t.Fatal(err)
	}
	release()
	release()
	if err := <-stopped; err != nil {
		t.Fatal(err)
	}
	if _, err := m.Acquire(ctx, id); !errors.Is(err, ErrDisabled) {
		t.Fatalf("stopped computer accepted work: %v", err)
	}
	m.Check(ctx, func(*kitty.Kitty, string) { t.Error("watchdog restarted disabled computer") }, func(string, ...any) {})
	if f.running[f.ref.ID] {
		t.Fatal("disabled computer is running")
	}
}

func TestSleepWakesForWorkAndRenewsOnlyActivity(t *testing.T) {
	m, f, id := cloudFleet(t)
	ctx := context.Background()
	if err := m.Sleep(ctx, id); err != nil {
		t.Fatal(err)
	}
	m.Check(ctx, func(*kitty.Kitty, string) { t.Error("watchdog woke sleeping computer") }, func(string, ...any) {})
	if _, err := m.Screenshot(ctx, id); err != nil {
		t.Fatal(err)
	}
	k, _ := m.Get(id)
	if k.Status != kitty.StatusSleeping {
		t.Fatal("thumbnail woke computer")
	}
	release, err := m.Acquire(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	k, _ = m.Get(id)
	if k.Status != kitty.StatusRunning || k.Availability != computer.Enabled {
		t.Fatal("task did not wake computer")
	}
	m.CheckActivity(ctx, func(format string, args ...any) { t.Errorf(format, args...) })
	if f.renews.Load() != 1 {
		t.Fatal("active task did not renew TTL")
	}
	release()
	m.CheckActivity(ctx, func(format string, args ...any) { t.Errorf(format, args...) })
	if f.renews.Load() != 1 {
		t.Fatal("idle computer renewed TTL")
	}
	m.activityMu.Lock()
	m.lastActivity[id] = time.Now().Add(-16 * time.Minute)
	m.activityMu.Unlock()
	m.CheckActivity(ctx, func(format string, args ...any) { t.Errorf(format, args...) })
	deadline := time.After(2 * time.Second)
	for {
		k, _ = m.Get(id)
		if k.Status == kitty.StatusSleeping && k.Operation.Kind == "" {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("idle sleep did not finish: %+v", k)
		case <-time.After(time.Millisecond):
		}
	}
	if k.Computer.CheckpointID == "" {
		t.Fatal("sleep lost recovery checkpoint")
	}
}

func TestCanceledActivityDoesNotWaitForLifecycleGate(t *testing.T) {
	m, _, id := cloudFleet(t)
	unlock, err := m.lockComputer(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		release, err := m.Acquire(ctx, id)
		if release != nil {
			release()
		}
		done <- err
	}()
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled acquisition = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("canceled activity waited for an unrelated lifecycle operation")
	}
}

func TestAsyncIntentIsReservedUnderComputerGate(t *testing.T) {
	m, _, id := cloudFleet(t)
	unlock, err := m.lockComputer(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	accepted, err := m.LifecycleInBackground(id, "stop")
	unlock()
	if !errors.Is(err, ErrLifecycleBusy) || accepted != nil {
		t.Fatalf("stop reservation crossed an in-flight operation: %+v %v", accepted, err)
	}
	k, _ := m.Get(id)
	if k.Operation.Kind != "" || k.Availability != computer.Enabled {
		t.Fatal("rejected reservation changed durable intent")
	}
	accepted, err = m.LifecycleInBackground(id, "stop")
	if err != nil || accepted.Operation.Kind != "stop" || accepted.Availability != computer.Disabled {
		t.Fatalf("accepted stop lost intent: %+v %v", accepted, err)
	}
	waitOperation(t, m, id, "")
	k, _ = m.Get(id)
	if k.Status != kitty.StatusStopped || k.Availability != computer.Disabled {
		t.Fatalf("completed stop = %+v", k)
	}
}

func TestWatchdogCannotOverrideConcurrentManualStop(t *testing.T) {
	m, f, id := cloudFleet(t)
	f.running[f.ref.ID] = false
	sampled, proceed, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var blocked atomic.Bool
	now := time.Now()
	m.now = func() time.Time {
		if blocked.CompareAndSwap(false, true) {
			close(sampled)
			<-proceed
		}
		return now
	}
	go func() { defer close(done); m.Check(context.Background(), func(*kitty.Kitty, string) {}, t.Logf) }()
	<-sampled
	accepted, err := m.LifecycleInBackground(id, "stop")
	if errors.Is(err, ErrLifecycleBusy) {
		// The watchdog owns the gate. Stop can be requested once that operation ends.
		close(proceed)
		<-done
		if err := m.Stop(context.Background(), id); err != nil {
			t.Fatal(err)
		}
	} else {
		if err != nil || accepted == nil {
			close(proceed)
			<-done
			t.Fatalf("concurrent stop = %v", err)
		}
		waitOperation(t, m, id, "")
		close(proceed)
		<-done
	}
	k, _ := m.Get(id)
	if k.Availability != computer.Disabled || k.Status != kitty.StatusStopped || f.running[f.ref.ID] {
		t.Fatalf("stale watchdog recovery overrode explicit stop: %+v", k)
	}
}

func TestIdleSleepDoesNotQueueBehindNewActivity(t *testing.T) {
	m, _, id := cloudFleet(t)
	m.activityMu.Lock()
	m.lastActivity[id] = time.Now().Add(-16 * time.Minute)
	m.activityMu.Unlock()
	unlock, err := m.lockComputer(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	m.CheckActivity(context.Background(), t.Logf)
	k, _ := m.Get(id)
	unlock()
	if k.Operation.Kind != "" {
		t.Fatalf("stale idle work queued behind active gate: %+v", k)
	}
	release, err := m.Acquire(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	release()
	m.CheckActivity(context.Background(), t.Logf)
	k, _ = m.Get(id)
	if k.Operation.Kind != "" || k.Status != kitty.StatusRunning {
		t.Fatalf("freshly completed work was slept immediately: %+v", k)
	}
}

func TestDrainingTasksKeepProviderTTLRenewed(t *testing.T) {
	m, f, id := cloudFleet(t)
	release, err := m.Acquire(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	stopped := make(chan error, 1)
	go func() { stopped <- m.Stop(ctx, id) }()
	waitOperation(t, m, id, "stop")
	m.CheckActivity(ctx, func(format string, args ...any) { t.Errorf(format, args...) })
	if f.renews.Load() != 1 {
		t.Fatal("active draining task lost its provider TTL renewal")
	}
	// Releasing control is also allowed while stop owns the lifecycle gate.
	if _, err := m.Hold(id, false); err != nil {
		t.Fatal(err)
	}
	release()
	if err := <-stopped; err != nil {
		t.Fatal(err)
	}
}

func TestRecentControlPreventsImmediateIdleSleep(t *testing.T) {
	m, _, id := cloudFleet(t)
	m.activityMu.Lock()
	m.lastActivity[id] = time.Now().Add(-16 * time.Minute)
	m.activityMu.Unlock()
	if _, err := m.Hold(id, true); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Hold(id, false); err != nil {
		t.Fatal(err)
	}
	m.CheckActivity(context.Background(), t.Logf)
	k, _ := m.Get(id)
	if k.Operation.Kind != "" || k.Status != kitty.StatusRunning {
		t.Fatalf("recent control was ignored by idle sleep: %+v", k)
	}
}
