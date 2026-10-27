package digest

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/madkoding/kitties/internal/agenda"
	"github.com/madkoding/kitties/internal/budget"
	"github.com/madkoding/kitties/internal/notify"
)

type rig struct {
	r     *Reporter
	cfg   notify.Config
	sent  []notify.Notification
	fail  error
	clock time.Time
	path  string
}

func newRig(t *testing.T) *rig {
	t.Helper()
	g := &rig{cfg: notify.Config{Connector: "phone", Digest: "09:00"}, clock: time.Date(2026, 3, 2, 9, 0, 0, 0, time.UTC), path: filepath.Join(t.TempDir(), "digest.json")}
	at := func(h int) time.Time { return g.clock.Add(-time.Duration(h) * time.Hour) }
	g.r = New(Source{
		Kitties: func() []Kitty { return []Kitty{{"b1", "tom"}, {"a1", "mimi"}} },
		Journal: func(id string, n int) []agenda.Entry {
			if id == "a1" {
				return []agenda.Entry{
					{At: at(1), Kind: agenda.KindDone}, {At: at(2), Kind: agenda.KindDone}, {At: at(3), Kind: agenda.KindBlocked},
					{At: at(4), Kind: agenda.KindApproval, Text: "approved: slack.post"},
					{At: at(5), Kind: agenda.KindApproval, Text: "waiting for approval: slack.post"},
					{At: at(30), Kind: agenda.KindDone}, // older than a day: not counted
				}
			}
			return nil
		},
		Waiting: func() []string { return g.waiting() },
		Today: func(id string) budget.Day {
			if id == "a1" {
				return budget.Day{Tokens: 12400, Actions: 3}
			}
			return budget.Day{}
		},
		Config: func() notify.Config { return g.cfg },
		Deliver: func(_ context.Context, n notify.Notification) error {
			if g.fail != nil {
				return g.fail
			}
			g.sent = append(g.sent, n)
			return nil
		},
	}, g.path)
	g.r.now = func() time.Time { return g.clock }
	return g
}

func (g *rig) waiting() []string { return []string{"slack.post: hello"} }

func TestBuildCountsTheLastDay(t *testing.T) {
	g := newRig(t)
	n := g.r.Build(g.clock)
	if n.Event != notify.Digest || n.Title == "" {
		t.Fatalf("n = %+v", n)
	}
	want := "mimi: 2 done, 1 blocked, 1 actions out (12.4k tokens, 3 actions today)\ntom: quiet\nWaiting for your yes (1):\n- slack.post: hello"
	if n.Body != want {
		t.Errorf("body =\n%s\nwant\n%s", n.Body, want)
	}
}

func TestBuildTrimsLongListsAndEmptyFleets(t *testing.T) {
	g := newRig(t)
	g.r.src.Waiting = func() []string { return []string{"1", "2", "3", "4", "5", "6", "7"} }
	if b := g.r.Build(g.clock).Body; !strings.Contains(b, "(7):") || !strings.Contains(b, "- and 2 more") || strings.Contains(b, "- 6") {
		t.Errorf("body = %s", b)
	}
	g.r.src.Kitties = func() []Kitty { return nil }
	g.r.src.Waiting = func() []string { return nil }
	if b := g.r.Build(g.clock).Body; b != "No kitties yet." {
		t.Errorf("empty = %q", b)
	}
	for in, want := range map[int]string{5: "5", 1500: "1.5k", 2_500_000: "2.5M"} {
		if short(in) != want {
			t.Errorf("short(%d) = %s", in, short(in))
		}
	}
}

func TestTickSendsOncePerDayInsideTheWindow(t *testing.T) {
	g := newRig(t)
	ctx := context.Background()
	g.clock = time.Date(2026, 3, 2, 8, 59, 0, 0, time.UTC)
	if sent, _ := g.r.Tick(ctx); sent {
		t.Fatal("before the time")
	}
	g.clock = time.Date(2026, 3, 2, 9, 5, 0, 0, time.UTC)
	if sent, err := g.r.Tick(ctx); !sent || err != nil || len(g.sent) != 1 {
		t.Fatalf("at the time: %v %v", sent, err)
	}
	if sent, _ := g.r.Tick(ctx); sent {
		t.Fatal("not twice in a day")
	}
	// A restart does not repeat it.
	again := New(g.r.src, g.path)
	again.now = g.r.now
	if sent, _ := again.Tick(ctx); sent {
		t.Fatal("a restart repeated the summary")
	}
	// Tomorrow it is due again; too late in the day it is not sent at all.
	g.clock = time.Date(2026, 3, 3, 9, 0, 0, 0, time.UTC)
	if sent, _ := g.r.Tick(ctx); !sent {
		t.Fatal("tomorrow")
	}
	g.clock = time.Date(2026, 3, 4, 20, 0, 0, 0, time.UTC)
	if sent, _ := g.r.Tick(ctx); sent {
		t.Fatal("turned on late in the evening: nothing yesterday's")
	}
}

func TestTickWhenOffBroken(t *testing.T) {
	g := newRig(t)
	ctx := context.Background()
	g.cfg.Digest = ""
	if sent, _ := g.r.Tick(ctx); sent {
		t.Fatal("off")
	}
	g.cfg = notify.Config{Digest: "09:00"}
	if sent, _ := g.r.Tick(ctx); sent {
		t.Fatal("no channel")
	}
	g.cfg = notify.Config{Connector: "phone", Digest: "09:00"}
	g.fail = errors.New("ntfy is down")
	if sent, err := g.r.Tick(ctx); sent || err == nil {
		t.Fatalf("a failed send is reported: %v %v", sent, err)
	}
	g.fail = nil
	if sent, err := g.r.Tick(ctx); !sent || err != nil {
		t.Fatalf("and tried again: %v %v", sent, err)
	}
}

func TestSendNowAndRun(t *testing.T) {
	g := newRig(t)
	g.cfg.Connector = ""
	if err := g.r.SendNow(context.Background()); err == nil {
		t.Fatal("needs a channel")
	}
	g.cfg.Connector = "phone"
	if err := g.r.SendNow(context.Background()); err != nil || len(g.sent) != 1 {
		t.Fatalf("send now: %v", err)
	}
	// Run ticks at once, reports a failure and stops with the context.
	g.fail = errors.New("down")
	g.clock = time.Date(2026, 3, 9, 9, 1, 0, 0, time.UTC)
	logged := make(chan string, 1)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { g.r.Run(ctx, func(f string, a ...any) { logged <- f }); close(done) }()
	if msg := <-logged; !strings.HasPrefix(msg, "digest:") {
		t.Errorf("log = %q", msg)
	}
	cancel()
	<-done
	// Without a logger a failure is quietly kept for the next tick.
	ctx2, cancel2 := context.WithCancel(context.Background())
	cancel2()
	g.r.Run(ctx2, nil)
}

func TestInterruptedDigestIsNotReplayedAfterRestart(t *testing.T) {
	g := newRig(t)
	deliveries := 0
	g.r.src.Deliver = func(context.Context, notify.Notification) error {
		deliveries++
		panic("process stopped after delivery")
	}
	func() {
		defer func() { _ = recover() }()
		_, _ = g.r.Tick(context.Background())
	}()
	again := New(g.r.src, g.path)
	again.now = g.r.now
	if sent, err := again.Tick(context.Background()); sent || err != nil || deliveries != 1 {
		t.Fatalf("interrupted digest replayed: sent=%v err=%v deliveries=%d", sent, err, deliveries)
	}
}

func TestDigestClaimsDeliveryBeforeSending(t *testing.T) {
	g := newRig(t)
	blocker := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	g.r.path = filepath.Join(blocker, "digest.json")
	if sent, err := g.r.Tick(context.Background()); sent || err == nil || len(g.sent) != 0 {
		t.Fatalf("sent without durable claim: sent=%v err=%v messages=%d", sent, err, len(g.sent))
	}
}
