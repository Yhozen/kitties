package agenda

import (
	"context"
	"errors"
	"github.com/madkoding/kitties/internal/maintenance"
	"path/filepath"
	"testing"
	"time"
)

func TestBackupBarrierLeavesDueGoalsPending(t *testing.T) {
	st := store(t)
	journal := NewJournal(filepath.Join(t.TempDir(), "journal"))
	runner := &fakeRunner{}
	sched := New(st, journal, runner)
	goal, err := st.Add(Goal{Kitty: "kitty", Title: "Due work", Every: "@daily", On: []string{"inbox"}, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	sched.now = func() time.Time { return goal.NextRun }
	gate := &maintenance.Gate{}
	sched.SetAdmission(gate)
	_, resume, err := gate.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	sched.Tick(context.Background())
	sched.Wait()
	if ids := sched.Fire(context.Background(), Event{Source: "inbox"}); len(ids) != 0 {
		t.Fatal("event admitted during capture")
	}
	if _, err := sched.RunNow(context.Background(), goal.ID); !errors.Is(err, maintenance.ErrBusy) {
		t.Fatalf("manual admission: %v", err)
	}
	current, _ := st.Get(goal.ID)
	if current.Runs != 0 || !current.NextRun.Equal(goal.NextRun) || current.LastResult != "" || runner.count() != 0 {
		t.Fatalf("goal changed during backup: %+v", current)
	}
	resume()
	sched.Tick(context.Background())
	sched.Wait()
	current, _ = st.Get(goal.ID)
	if runner.count() != 1 || current.Runs != 1 {
		t.Fatalf("due work lost: %+v", current)
	}
}
