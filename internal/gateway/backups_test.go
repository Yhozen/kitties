package gateway

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/madkoding/kitties/internal/backup"
	"github.com/madkoding/kitties/internal/maintenance"
)

type fakeRecoveryBackups struct{ calls int }

func (b *fakeRecoveryBackups) WaitIdle(context.Context) error { return nil }

func (b *fakeRecoveryBackups) Status() backup.Status {
	return backup.Status{Enabled: true, Running: b.calls > 0}
}
func (b *fakeRecoveryBackups) Trigger() (backup.Status, error) { b.calls++; return b.Status(), nil }
func TestBackupStatusStaysAvailableWhileMutationsAreFrozen(t *testing.T) {
	var gate maintenance.Gate
	b := &fakeRecoveryBackups{}
	srv := httptest.NewServer(New(&fakeFleet{}, &fakeChats{}, "tok", "test").WithBackups(b).WithAdmission(&gate))
	defer srv.Close()
	if code, _, _ := call(t, srv, "POST", "/v1/backups", "", nil); code != http.StatusUnauthorized || b.calls != 0 {
		t.Fatal("unauthenticated backup accepted")
	}
	if code, _, _ := call(t, srv, "POST", "/v1/backups", "tok", nil); code != http.StatusAccepted || b.calls != 1 {
		t.Fatalf("manual backup=%d", code)
	}
	_, resume, err := gate.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer resume()
	if code, _, _ := call(t, srv, "GET", "/v1/backups/status", "tok", nil); code != http.StatusOK {
		t.Fatalf("status blocked: %d", code)
	}
	if code, _, _ := call(t, srv, "POST", "/v1/kitties", "tok", map[string]any{"name": "new"}); code != http.StatusServiceUnavailable {
		t.Fatalf("mutation entered backup: %d", code)
	}
}
