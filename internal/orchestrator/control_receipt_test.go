package orchestrator

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/madkoding/kitties/internal/computer"
	"github.com/madkoding/kitties/internal/desktop"
	"github.com/madkoding/kitties/internal/maintenance"
)

type preparedComputer struct {
	*remoteComputer
	dispatch func(context.Context, computer.Reference, string, ...string) (string, error)
	starting func(context.Context)
}

func (f *preparedComputer) Start(ctx context.Context, id string) error {
	if f.starting != nil {
		f.starting(ctx)
	}
	return f.remoteComputer.Start(ctx, id)
}

func (f *preparedComputer) ExecPreparedInput(ctx context.Context, ref computer.Reference, input string, argv ...string) (string, error) {
	if ref != f.ref {
		return "", fmt.Errorf("identity changed")
	}
	if f.dispatch != nil {
		return f.dispatch(ctx, ref, input, argv...)
	}
	return f.ExecInput(ctx, ref.ID, input, argv...)
}

func TestPreparedHumanInputDoesNotRestartAnAlreadyReadyComputer(t *testing.T) {
	ctx := context.Background()
	f := &preparedComputer{remoteComputer: newRemote()}
	m, err := New(testConfig(t), WithContainers(f, nil))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	k, err := m.Create(ctx, Spec{Name: "mimi"})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Start(ctx, k.ID); err != nil {
		t.Fatal(err)
	}
	f.fail = "start"
	grant, err := m.Control(ctx, k.ID, true, "")
	if err != nil {
		t.Fatalf("taking a prepared desktop restarted it: %v", err)
	}
	for range 3 {
		if err := m.Input(ctx, k.ID, grant.ID, desktop.Action{Name: "type", Args: map[string]any{"text": "warm fixture"}}); err != nil {
			t.Fatal(err)
		}
	}
	if len(f.inputs) != 3 {
		t.Fatalf("input delivered %d times", len(f.inputs))
	}
	current, _ := m.Get(k.ID)
	if current.Status != "running" || current.Operation.Kind != "" {
		t.Fatal("warm input changed lifecycle status")
	}
}

func TestReleasedControlCannotBeReacquiredByQueuedInput(t *testing.T) {
	ctx := context.Background()
	f := newFake()
	m, err := New(testConfig(t), WithContainers(f, nil))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	k, err := m.Create(ctx, Spec{Name: "mimi"})
	if err != nil {
		t.Fatal(err)
	}
	grant, err := m.Control(ctx, k.ID, true, "")
	if err != nil || !grant.Held || grant.ID == "" {
		t.Fatalf("take control: %+v %v", grant, err)
	}
	if _, err := m.Control(ctx, k.ID, false, grant.ID); err != nil {
		t.Fatal(err)
	}
	if err := m.Input(ctx, k.ID, grant.ID, desktop.Action{Name: "key", Args: map[string]any{"keys": "Return"}}); err == nil {
		t.Fatal("released queued input reacquired the desktop")
	}
	if m.Held(k.ID) || len(f.execs) != 0 {
		t.Fatal("revoked input reached the desktop")
	}
}

func controlledDesktop(t *testing.T) (*Manager, *preparedComputer, string, ControlState) {
	t.Helper()
	f := &preparedComputer{remoteComputer: newRemote()}
	m, err := New(testConfig(t), WithContainers(f, nil))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	k, err := m.Create(context.Background(), Spec{Name: "mimi"})
	if err != nil {
		t.Fatal(err)
	}
	grant, err := m.Control(context.Background(), k.ID, true, "")
	if err != nil {
		t.Fatal(err)
	}
	return m, f, k.ID, grant
}

func TestControlReceiptsRejectMissingExpiredAndReplacedAuthority(t *testing.T) {
	for _, scenario := range []string{"missing", "foreign", "released", "expired", "replaced", "identity", "stopped", "restart"} {
		t.Run(scenario, func(t *testing.T) {
			m, f, id, grant := controlledDesktop(t)
			token := grant.ID
			switch scenario {
			case "missing":
				token = ""
			case "foreign":
				token = "another-viewer"
			case "released":
				_, _ = m.Control(context.Background(), id, false, token)
			case "expired":
				now := time.Now().Add(holdIdle + time.Minute)
				m.now = func() time.Time { return now }
			case "replaced":
				newer, err := m.Control(context.Background(), id, true, "")
				if err != nil {
					t.Fatal(err)
				}
				if _, err = m.Control(context.Background(), id, false, token); err != nil {
					t.Fatal(err)
				}
				if err = m.Input(context.Background(), id, newer.ID, desktop.Action{Name: "key", Args: map[string]any{"keys": "Return"}}); err != nil {
					t.Fatal("old release revoked current control", err)
				}
				f.inputs = nil
			case "identity":
				f.restored = "bx-replacement"
				if err := m.Start(context.Background(), id); err != nil {
					t.Fatal(err)
				}
			case "stopped":
				if err := m.Stop(context.Background(), id); err != nil {
					t.Fatal(err)
				}
			case "restart":
				next, err := New(m.Config(), WithContainers(f, nil))
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(next.Close)
				m = next
			}
			if err := m.Input(context.Background(), id, token, desktop.Action{Name: "key", Args: map[string]any{"keys": "Return"}}); err == nil {
				t.Fatal("invalid control dispatched")
			}
			if len(f.inputs) != 0 {
				t.Fatal("rejected input reached runtime")
			}
		})
	}
}

func TestReleaseDrainsAdmittedInputButRejectsItsQueuedSuccessor(t *testing.T) {
	m, f, id, grant := controlledDesktop(t)
	entered, finish := make(chan struct{}), make(chan struct{})
	calls := 0
	f.dispatch = func(ctx context.Context, _ computer.Reference, _ string, _ ...string) (string, error) {
		calls++
		close(entered)
		select {
		case <-finish:
			return "", nil
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	first := make(chan error, 1)
	action := desktop.Action{Name: "key", Args: map[string]any{"keys": "Return"}}
	go func() { first <- m.Input(context.Background(), id, grant.ID, action) }()
	<-entered
	if _, err := m.Control(context.Background(), id, false, grant.ID); err != nil {
		t.Fatal(err)
	}
	if !m.Held(id) {
		t.Fatal("agent resumed before admitted human input finished")
	}
	second := make(chan error, 1)
	go func() { second <- m.Input(context.Background(), id, grant.ID, action) }()
	close(finish)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	if err := <-second; !errors.Is(err, ErrControlExpired) {
		t.Fatalf("queued input after release: %v", err)
	}
	if calls != 1 || m.Held(id) {
		t.Fatal("release replayed input or retained control")
	}
}

func TestUnknownInputDeliveryInvalidatesReceiptWithoutReplay(t *testing.T) {
	m, f, id, grant := controlledDesktop(t)
	calls := 0
	f.dispatch = func(context.Context, computer.Reference, string, ...string) (string, error) {
		calls++
		return "", errors.New("acknowledgement lost")
	}
	action := desktop.Action{Name: "type", Args: map[string]any{"text": "nonsecret fixture"}}
	if err := m.Input(context.Background(), id, grant.ID, action); err == nil {
		t.Fatal("unknown delivery acknowledged")
	}
	if err := m.Input(context.Background(), id, grant.ID, action); !errors.Is(err, ErrControlExpired) {
		t.Fatalf("failed grant reused: %v", err)
	}
	if calls != 1 || m.Held(id) {
		t.Fatal("unknown delivery replayed or kept control")
	}
}

func TestShutdownCancelsAndJoinsAdmittedHumanInput(t *testing.T) {
	m, f, id, grant := controlledDesktop(t)
	entered := make(chan struct{})
	f.dispatch = func(ctx context.Context, _ computer.Reference, _ string, _ ...string) (string, error) {
		close(entered)
		<-ctx.Done()
		return "", ctx.Err()
	}
	done := make(chan error, 1)
	go func() {
		done <- m.Input(context.Background(), id, grant.ID, desktop.Action{Name: "key", Args: map[string]any{"keys": "Return"}})
	}()
	<-entered
	closed := make(chan struct{})
	go func() { m.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown did not join input")
	}
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("shutdown command: %v", err)
	}
	if m.Held(id) {
		t.Fatal("shutdown kept controls")
	}
	if _, err := m.Control(context.Background(), id, true, ""); err == nil {
		t.Fatal("shutdown granted new controls")
	}
}

func TestRecoveryFreezeRejectsNewInputAndRetiresOldControl(t *testing.T) {
	m, f, id, grant := controlledDesktop(t)
	entered, finish := make(chan struct{}), make(chan struct{})
	f.dispatch = func(ctx context.Context, _ computer.Reference, _ string, _ ...string) (string, error) {
		close(entered)
		select {
		case <-finish:
			return "", nil
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	action := desktop.Action{Name: "key", Args: map[string]any{"keys": "Return"}}
	done := make(chan error, 1)
	go func() { done <- m.Input(context.Background(), id, grant.ID, action) }()
	<-entered
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	const operation = "warm-input-freeze"
	if err := m.PrepareRecovery(ctx, operation); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("freeze failed to drain: %v", err)
	}
	if err := m.Input(context.Background(), id, grant.ID, action); !errors.Is(err, maintenance.ErrBusy) {
		t.Fatalf("new input bypassed frozen admission: %v", err)
	}
	close(finish)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := m.ReleaseRecovery(operation); err != nil {
		t.Fatal(err)
	}
	if err := m.Input(context.Background(), id, grant.ID, action); !errors.Is(err, ErrControlExpired) {
		t.Fatalf("old controls survived recovery: %v", err)
	}
}

func TestInterruptedRecoveryRejectsControlPreparationAlreadyInFlight(t *testing.T) {
	m, f, id, _ := controlledDesktop(t)
	m.invalidateControl(id, true)
	entered, finish := make(chan struct{}), make(chan struct{})
	f.starting = func(context.Context) { close(entered); <-finish }
	done := make(chan error, 1)
	go func() { _, err := m.Control(context.Background(), id, true, ""); done <- err }()
	<-entered
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	const operation = "late-control-freeze"
	if err := m.PrepareRecovery(ctx, operation); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	if err := m.ReleaseRecovery(operation); err != nil {
		t.Fatal(err)
	}
	close(finish)
	if err := <-done; !errors.Is(err, ErrControlExpired) {
		t.Fatalf("late preparation granted control: %v", err)
	}
	if m.Held(id) {
		t.Fatal("late preparation holds the desktop")
	}
	f.starting = nil
	if _, err := m.Control(context.Background(), id, true, ""); err != nil {
		t.Fatalf("explicit fresh take after recovery: %v", err)
	}
}

func TestControlPreparationCoalescesAndCancelledWaiterGetsNoGrant(t *testing.T) {
	m, f, id, _ := controlledDesktop(t)
	m.invalidateControl(id, true)
	entered, finish := make(chan struct{}), make(chan struct{})
	starts := 0
	f.starting = func(context.Context) { starts++; close(entered); <-finish }
	first := make(chan error, 1)
	go func() { _, err := m.Control(context.Background(), id, true, ""); first <- err }()
	<-entered
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := m.Control(ctx, id, true, ""); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("waiter: %v", err)
	}
	second := make(chan error, 1)
	go func() { _, err := m.Control(context.Background(), id, true, ""); second <- err }()
	close(finish)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	if err := <-second; err != nil {
		t.Fatal(err)
	}
	if starts != 1 {
		t.Fatalf("prepared %d times", starts)
	}
}

func TestFailedPreparationAndUnavailableComputersNeverGrantControl(t *testing.T) {
	for _, scenario := range []string{"missing", "no-desktop", "disabled", "pending-stop", "failed-start", "frozen", "cancelled", "empty-release"} {
		t.Run(scenario, func(t *testing.T) {
			m, f, id, grant := controlledDesktop(t)
			ctx := context.Background()
			on, receipt := true, ""
			switch scenario {
			case "missing":
				id = "missing"
			case "no-desktop":
				m.mu.Lock()
				m.kitties[id].Desktop = false
				m.mu.Unlock()
			case "disabled":
				if err := m.Stop(ctx, id); err != nil {
					t.Fatal(err)
				}
			case "pending-stop":
				if err := m.beginOperation(id, "stop", computer.Enabled); err != nil {
					t.Fatal(err)
				}
			case "failed-start":
				m.invalidateControl(id, true)
				f.fail = "start"
			case "frozen":
				if err := m.PrepareRecovery(ctx, "frozen-control-fixture"); err != nil {
					t.Fatal(err)
				}
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			case "empty-release":
				on = false
			}
			if _, err := m.Control(ctx, id, on, receipt); err == nil {
				t.Fatal("unavailable control was granted")
			}
			if scenario == "failed-start" && m.Held(id) {
				t.Fatal("failed setup retained control")
			}
			if scenario == "empty-release" {
				if err := m.Input(context.Background(), id, grant.ID, desktop.Action{Name: "key", Args: map[string]any{"keys": "Return"}}); err != nil {
					t.Fatalf("empty release revoked a real grant: %v", err)
				}
			}
		})
	}
}

func TestPreparedInputKeepsDockerAndLimaButFailsClosedForUnsupportedBoat(t *testing.T) {
	for _, kind := range []string{"docker", "lima", "boat"} {
		t.Run(kind, func(t *testing.T) {
			f := newRemote()
			f.kind = kind
			f.ref.Runtime = kind
			m, err := New(testConfig(t), WithContainers(f, nil))
			if err != nil {
				t.Fatal(err)
			}
			defer m.Close()
			k, err := m.Create(context.Background(), Spec{Name: "mimi"})
			if err != nil {
				t.Fatal(err)
			}
			grant, err := m.Control(context.Background(), k.ID, true, "")
			if err != nil {
				t.Fatal(err)
			}
			err = m.Input(context.Background(), k.ID, grant.ID, desktop.Action{Name: "type", Args: map[string]any{"text": "local fixture"}})
			if kind == "boat" {
				if err == nil || len(f.inputs) != 0 || m.Held(k.ID) {
					t.Fatalf("unsupported Boat dispatched: %v", err)
				}
			} else if err != nil || len(f.inputs) != 1 {
				t.Fatalf("local input: %v", err)
			}
		})
	}
}

func TestIdleBackupNeverRevokesActiveHumanControl(t *testing.T) {
	m, _, id, grant := controlledDesktop(t)
	if _, _, err := m.BeginMaintenance(context.Background(), true); !errors.Is(err, maintenance.ErrBusy) {
		t.Fatalf("idle backup: %v", err)
	}
	if m.Admission().Active() {
		t.Fatal("rejected idle backup kept admission closed")
	}
	if err := m.Input(context.Background(), id, grant.ID, desktop.Action{Name: "key", Args: map[string]any{"keys": "Return"}}); err != nil {
		t.Fatalf("idle backup revoked controls: %v", err)
	}
}
