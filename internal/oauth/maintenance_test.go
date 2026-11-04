package oauth

import (
	"context"
	"errors"
	"github.com/madkoding/kitties/internal/maintenance"
	"testing"
)

func TestBackupBarrierDefersRotatingRefreshCredentials(t *testing.T) {
	st := &memStore{provider: "google", id: "client", creds: Credentials{AccessToken: "old", RefreshToken: "old-refresh"}}
	response := &answer{code: 200, body: `{"access_token":"new","refresh_token":"rotated","expires_in":3600}`}
	manager := manager(st, response)
	gate := &maintenance.Gate{}
	manager.SetAdmission(gate)
	_, resume, err := gate.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Exchange(context.Background(), "pending-state", "code"); !errors.Is(err, maintenance.ErrBusy) {
		t.Fatalf("callback admitted: %v", err)
	}
	manager.refreshDue(context.Background(), []string{"connector"}, nil)
	if _, err := manager.Token(context.Background(), "connector"); !errors.Is(err, maintenance.ErrBusy) {
		t.Fatalf("token: %v", err)
	}
	if response.req != nil || st.creds.RefreshToken != "old-refresh" {
		t.Fatal("credentials rotated during capture")
	}
	resume()
	manager.refreshDue(context.Background(), []string{"connector"}, nil)
	if st.creds.AccessToken != "new" || st.creds.RefreshToken != "rotated" {
		t.Fatalf("refresh did not resume: %+v", st.creds)
	}
}
