package agenda

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/madkoding/kitties/internal/maintenance"
)

type responseClosedRunner struct {
	responseClosed <-chan struct{}
	result         chan error
}

func (r responseClosedRunner) RunGoal(ctx context.Context, _ Goal, _ Trigger) (string, error) {
	<-r.responseClosed
	r.result <- ctx.Err()
	return "goal-chat", nil
}

func TestAcknowledgedWebhookSurvivesResponseCancellation(t *testing.T) {
	st := store(t)
	closed := make(chan struct{})
	result := make(chan error, 1)
	scheduler := New(st, NewJournal(filepath.Join(t.TempDir(), "journal")), responseClosedRunner{closed, result})
	scheduler.SetAdmission(&maintenance.Gate{})
	goal, err := st.Add(Goal{Kitty: "kitty", Title: "Webhook task", On: []string{"inbox"}, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	ids := scheduler.Fire(ctx, Event{Source: "inbox"})
	if len(ids) != 1 || ids[0] != goal.ID {
		t.Fatalf("event was not acknowledged: %v", ids)
	}
	cancel()
	close(closed)
	scheduler.Wait()
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("accepted event inherited response cancellation: %v", err)
		}
	default:
		t.Fatal("accepted event was lost before the runner started")
	}
}

type webhookRunnerFunc func(context.Context, Goal, Trigger) (string, error)

func (f webhookRunnerFunc) RunGoal(ctx context.Context, goal Goal, trigger Trigger) (string, error) {
	return f(ctx, goal, trigger)
}

func TestAcknowledgedWebhookOwnsAdmissionAndKeepsRequestValues(t *testing.T) {
	st := store(t)
	gate := &maintenance.Gate{}
	finish := make(chan struct{})
	result := make(chan error, 1)
	type requestKey struct{}
	runner := webhookRunnerFunc(func(ctx context.Context, _ Goal, _ Trigger) (string, error) {
		<-finish
		if ctx.Value(requestKey{}) != "inbound-event" {
			t.Error("accepted work lost request context values")
		}
		_, release, err := gate.Enter(ctx)
		if err == nil {
			release()
		}
		result <- err
		return "goal-chat", err
	})
	sched := New(st, NewJournal(filepath.Join(t.TempDir(), "journal")), runner)
	sched.SetAdmission(gate)
	goal, err := st.Add(Goal{Kitty: "kitty", Title: "Webhook task", On: []string{"inbox"}, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	request, releaseRequest, err := gate.Enter(context.WithValue(context.Background(), requestKey{}, "inbound-event"))
	if err != nil {
		t.Fatal(err)
	}
	if ids := sched.Fire(request, Event{Source: "inbox"}); len(ids) != 1 || ids[0] != goal.ID {
		t.Fatalf("event was not acknowledged: %v", ids)
	}
	releaseRequest()
	if _, release, err := gate.TryBegin(context.Background()); !errors.Is(err, maintenance.ErrBusy) {
		if release != nil {
			release()
		}
		t.Errorf("maintenance missed acknowledged work: %v", err)
	}
	freeze, cancel := context.WithCancel(context.Background())
	cancel()
	if err := gate.Freeze(freeze); !errors.Is(err, context.Canceled) {
		t.Errorf("freeze missed acknowledged work: %v", err)
	}
	close(finish)
	sched.Wait()
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("accepted work could not finish after the response and freeze: %v", err)
		}
	default:
		t.Fatal("accepted event was lost before the runner started")
	}
	if err := gate.Freeze(context.Background()); err != nil {
		t.Fatal(err)
	}
	gate.Thaw()
	current, _ := st.Get(goal.ID)
	if current.Runs != 1 || current.Chat != "goal-chat" {
		t.Fatalf("accepted event was not recorded: %+v", current)
	}
}

func TestSchedulerShutdownCancelsAndDrainsAcknowledgedWebhook(t *testing.T) {
	st := store(t)
	entered := make(chan struct{})
	canceled := make(chan error, 1)
	runner := webhookRunnerFunc(func(ctx context.Context, _ Goal, _ Trigger) (string, error) {
		close(entered)
		<-ctx.Done()
		canceled <- ctx.Err()
		return "goal-chat", ctx.Err()
	})
	sched := New(st, NewJournal(filepath.Join(t.TempDir(), "journal")), runner)
	gate := &maintenance.Gate{}
	sched.SetAdmission(gate)
	if _, err := st.Add(Goal{Kitty: "kitty", Title: "Webhook task", On: []string{"inbox"}, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { sched.Run(ctx); close(done) }()
	if ids := sched.Fire(context.Background(), Event{Source: "inbox"}); len(ids) != 1 {
		t.Fatalf("event was not acknowledged: %v", ids)
	}
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("accepted event did not start")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("scheduler shutdown did not cancel and drain accepted work")
	}
	if err := <-canceled; !errors.Is(err, context.Canceled) {
		t.Fatalf("accepted work did not receive scheduler cancellation: %v", err)
	}
	_, release, err := gate.TryBegin(context.Background())
	if err != nil {
		t.Fatalf("shutdown retained work admission: %v", err)
	}
	release()
	if ids := sched.Fire(context.Background(), Event{Source: "inbox"}); len(ids) != 0 {
		t.Fatalf("stopped scheduler acknowledged new work: %v", ids)
	}
}

func TestCanceledWebhookIsNotAcknowledged(t *testing.T) {
	st := store(t)
	runner := &fakeRunner{}
	sched := New(st, NewJournal(filepath.Join(t.TempDir(), "journal")), runner)
	if _, err := st.Add(Goal{Kitty: "kitty", Title: "Webhook task", On: []string{"inbox"}, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if ids := sched.Fire(ctx, Event{Source: "inbox"}); len(ids) != 0 {
		t.Fatalf("canceled request was acknowledged: %v", ids)
	}
	sched.Wait()
	if runner.count() != 0 {
		t.Fatal("canceled webhook ran")
	}
}
