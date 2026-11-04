package chat

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madkoding/kitties/internal/provider"
)

type shutdownBrain struct{ started, canceled, release chan struct{} }

func (b *shutdownBrain) Describe() string { return "shutdown test" }
func (b *shutdownBrain) Complete(ctx context.Context, _ []provider.Message) (provider.Reply, error) {
	close(b.started)
	<-ctx.Done()
	close(b.canceled)
	<-b.release
	return provider.Reply{}, ctx.Err()
}

func awaitShutdownSignal(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(3 * time.Second):
		t.Fatal("shutdown did not make progress")
	}
}

func TestShutdownCancelsInitialTurnAndWaitsForItsFinalWrite(t *testing.T) {
	f, _, _, _ := fleet(t)
	b := &shutdownBrain{make(chan struct{}), make(chan struct{}), make(chan struct{})}
	f.brains["a1"] = b
	s := service(t, f)
	sess, _ := s.Create("work", []string{"a1"})
	sent := make(chan struct{})
	go func() { _, _ = s.Send(context.Background(), sess.ID, "work"); close(sent) }()
	awaitShutdownSignal(t, b.started)
	done := make(chan struct{})
	go func() { s.Shutdown(); close(done) }()
	awaitShutdownSignal(t, b.canceled)
	if _, err := s.Send(context.Background(), sess.ID, "more"); !errors.Is(err, ErrShuttingDown) {
		t.Fatalf("new turn during shutdown = %v", err)
	}
	if _, err := s.Create("more", []string{"a1"}); !errors.Is(err, ErrShuttingDown) {
		t.Fatalf("new chat during shutdown = %v", err)
	}
	select {
	case <-done:
		t.Fatal("shutdown returned while initial turn could still write")
	default:
	}
	close(b.release)
	awaitShutdownSignal(t, done)
	awaitShutdownSignal(t, sent)
	if s.AnyBusy() {
		t.Fatal("shutdown left the initial turn permanently busy")
	}
	s.Shutdown()
}

type shutdownDesktop struct {
	*deskFleet
	started, canceled, release chan struct{}
}

func (d *shutdownDesktop) Exec(ctx context.Context, _ string, _ ...string) (string, error) {
	close(d.started)
	<-ctx.Done()
	close(d.canceled)
	<-d.release
	return "", ctx.Err()
}

func TestShutdownDrainsDetachedDesktopTask(t *testing.T) {
	f, brain, _, _ := fleet(t)
	brain.replies = []string{"Opening.\n@tool open {\"url\":\"https://example.com\"}"}
	d := &shutdownDesktop{&deskFleet{fakeFleet: f}, make(chan struct{}), make(chan struct{}), make(chan struct{})}
	s := service(t, d)
	sess, _ := s.Create("work", []string{"a1"})
	turns, err := s.Send(context.Background(), sess.ID, "open the site")
	if err != nil || len(turns) != 1 || !turns[0].Working {
		t.Fatalf("desktop task = %+v, %v", turns, err)
	}
	awaitShutdownSignal(t, d.started)
	done := make(chan struct{})
	go func() { s.Shutdown(); close(done) }()
	awaitShutdownSignal(t, d.canceled)
	select {
	case <-done:
		t.Fatal("shutdown returned before desktop task finished writing")
	default:
	}
	close(d.release)
	awaitShutdownSignal(t, done)
	if s.AnyBusy() {
		t.Fatal("shutdown left a desktop task working")
	}
}
