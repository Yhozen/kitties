package chat

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/madkoding/kitties/internal/provider"
)

func TestRestartInterruptsWithoutReplayingActions(t *testing.T) {
	f, brain, _, conn := fleet(t)
	s := service(t, f)
	sess, err := s.Create("work", []string{"a1", "b1"})
	if err != nil {
		t.Fatal(err)
	}
	sess.Turns = []Turn{{From: "ana", Kitty: "a1", Text: "I posted the message", Working: true, Steps: []Step{{Action: "click", Result: "done"}}}}
	sess.Pending = "b1"
	if err := s.save(sess); err != nil {
		t.Fatal(err)
	}
	recovered, err := New(f, s.dir)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := recovered.Get(sess.ID)
	if got.Working() || recovered.AnyBusy() || recovered.KittyBusy("a1") || len(got.Turns) != 2 {
		t.Fatalf("stuck or lost history: %+v", got)
	}
	if !got.Turns[0].Interrupted || !got.Turns[0].Resumable || len(got.Turns[0].Steps) != 1 || !got.Turns[1].Interrupted {
		t.Fatalf("missing interrupted work: %+v", got.Turns)
	}
	if len(brain.seen) != 0 || len(conn.calls) != 0 {
		t.Fatal("restart replayed an action")
	}
	twice, err := New(f, s.dir)
	if err != nil {
		t.Fatal(err)
	}
	again, _ := twice.Get(sess.ID)
	if len(again.Turns) != 2 {
		t.Fatal("recovery repeated its interruption marker")
	}
	if _, err := twice.Send(context.Background(), sess.ID, "@ana continue after reviewing the completed actions"); err != nil {
		t.Fatal(err)
	}
}

type leasedFleet struct {
	*fakeFleet
	active   bool
	releases int
	err      error
}

func (f *leasedFleet) Acquire(context.Context, string) (func(), error) {
	if f.err != nil {
		return nil, f.err
	}
	f.active = true
	return func() { f.active = false; f.releases++ }, nil
}

type leaseBrain struct{ check func() }

func (b leaseBrain) Describe() string { return "lease check" }
func (b leaseBrain) Complete(context.Context, []provider.Message) (provider.Reply, error) {
	b.check()
	return provider.Reply{Content: "done"}, nil
}

func TestActivityCoversInitialModelWorkAndDurablePendingTurn(t *testing.T) {
	f, _, _, _ := fleet(t)
	leased := &leasedFleet{fakeFleet: f}
	s := service(t, leased)
	sess, _ := s.Create("work", []string{"a1"})
	f.brains["a1"] = leaseBrain{check: func() {
		if !leased.active || !s.AnyBusy() || !s.KittyBusy("a1") {
			t.Error("initial model work is not held active")
		}
		data, err := os.ReadFile(filepath.Join(s.dir, sess.ID+".json"))
		if err != nil {
			t.Fatal(err)
		}
		var saved Session
		if err := json.Unmarshal(data, &saved); err != nil {
			t.Fatal(err)
		}
		if saved.Pending != "a1" {
			t.Error("initial work was not persisted before executing")
		}
	}}
	if _, err := s.Send(context.Background(), sess.ID, "go"); err != nil {
		t.Fatal(err)
	}
	if leased.active || leased.releases != 1 || s.AnyBusy() {
		t.Fatal("completed work retained an activity lease")
	}
	leased.err = errors.New("computer is disabled")
	turns, err := s.Send(context.Background(), sess.ID, "again")
	if err != nil || len(turns) != 1 || turns[0].Detail != leased.err.Error() || leased.active {
		t.Fatalf("disabled task: %+v %v", turns, err)
	}
}
