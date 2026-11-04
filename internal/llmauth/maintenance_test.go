package llmauth

import (
	"context"
	"errors"
	"github.com/madkoding/kitties/internal/maintenance"
	"testing"
	"time"
)

func TestLoginCompletionDrainsBeforeRecoveryCapture(t *testing.T) {
	manager := New(t.TempDir())
	defer manager.Close()
	gate := &maintenance.Gate{}
	manager.SetAdmission(gate)
	entered := make(chan struct{})
	finish := make(chan struct{})
	flow := manager.track(context.Background(), Flow{Kind: "codex"}, nil, func(ctx context.Context) (Credential, error) {
		close(entered)
		select {
		case <-finish:
			return Credential{Kind: "codex", AccessToken: "saved-before-backup"}, nil
		case <-ctx.Done():
			return Credential{}, ctx.Err()
		}
	})
	<-entered
	if _, _, err := gate.TryBegin(context.Background()); !errors.Is(err, maintenance.ErrBusy) {
		t.Fatalf("active login not held: %v", err)
	}
	close(finish)
	deadline, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, release, err := gate.Begin(deadline)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	credential, found, err := manager.store.Load("codex")
	if err != nil || !found || credential.AccessToken != "saved-before-backup" {
		t.Fatalf("capture preceded credential save: %v %v", found, err)
	}
	if _, err := manager.Start("codex", StartOptions{}); !errors.Is(err, maintenance.ErrBusy) {
		t.Fatalf("new login admitted: %v", err)
	}
	if _, err := manager.Source("codex")(context.Background()); !errors.Is(err, maintenance.ErrBusy) {
		t.Fatalf("refresh admitted: %v", err)
	}
	current, ok := manager.Get(flow.ID)
	if !ok || current.Status != Connected {
		t.Fatalf("login completion: %+v", current)
	}
}

func TestShutdownJoinsPendingLoginAndRejectsNewFlows(t *testing.T) {
	manager := New(t.TempDir())
	gate := &maintenance.Gate{}
	manager.SetAdmission(gate)
	done := make(chan struct{})
	manager.track(context.Background(), Flow{Kind: "codex"}, nil, func(ctx context.Context) (Credential, error) {
		<-ctx.Done()
		close(done)
		return Credential{}, ctx.Err()
	})
	manager.Close()
	select {
	case <-done:
	default:
		t.Fatal("login writer still running")
	}
	if gate.Busy() {
		t.Fatal("shutdown leaked admission")
	}
	if _, err := manager.Start("codex", StartOptions{}); err == nil {
		t.Fatal("login started after shutdown")
	}
}
