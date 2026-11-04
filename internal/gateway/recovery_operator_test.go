package gateway

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/madkoding/kitties/internal/backup"
	"github.com/madkoding/kitties/internal/maintenance"
)

type operatorFleet struct {
	*fakeFleet
	gate     maintenance.Gate
	released bool
}

func (f *operatorFleet) PrepareRecovery(ctx context.Context, _ string) error {
	return f.gate.Freeze(ctx)
}
func (f *operatorFleet) ReleaseRecovery(string) error { f.released = true; f.gate.Thaw(); return nil }

func TestRecoveryOperatorRequiresLocalBearerAndCanReleaseFrozenAdmission(t *testing.T) {
	f := &operatorFleet{fakeFleet: &fakeFleet{}}
	handler := New(f, &fakeChats{}, "tok", "test").WithAdmission(&f.gate)
	server := httptest.NewServer(handler)
	defer server.Close()
	body := map[string]any{"operation_id": "recovery_00000001"}
	if code, _, _ := call(t, server, "POST", "/v1/operator/recovery/prepare", "", body); code != http.StatusUnauthorized {
		t.Fatal(code)
	}
	remote := httptest.NewRequest("POST", "/v1/operator/recovery/prepare", strings.NewReader(`{"operation_id":"recovery_00000001"}`))
	remote.Header.Set("Authorization", "Bearer tok")
	remote.RemoteAddr = "198.51.100.1:1000"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, remote)
	if response.Code != http.StatusForbidden {
		t.Fatal("remote operator accepted", response.Code)
	}
	if code, _, _ := call(t, server, "POST", "/v1/operator/recovery/prepare", "tok", body); code != http.StatusOK {
		t.Fatal(code)
	}
	if !f.gate.Active() {
		t.Fatal("prepare did not freeze")
	}
	if code, _, _ := call(t, server, "POST", "/v1/kitties", "tok", map[string]any{"name": "new"}); code != http.StatusServiceUnavailable {
		t.Fatal(code)
	}
	if code, _, _ := call(t, server, "POST", "/v1/operator/recovery/release", "tok", body); code != http.StatusOK || !f.released || f.gate.Active() {
		t.Fatal("release could not bypass maintenance", code)
	}
}

func TestRecoveryPrepareDrainsBackupRetentionAndKeepsFreezeWhenCancelled(t *testing.T) {
	for _, cancelWait := range []bool{false, true} {
		t.Run(map[bool]string{false: "retention completes", true: "prepare cancelled"}[cancelWait], func(t *testing.T) {
			retention, finishRetention := make(chan struct{}), make(chan struct{})
			manager, err := backup.New(backup.Options{
				DataDir: t.TempDir(), Env: []string{"RESTIC_REPOSITORY=fixture", "RESTIC_PASSWORD=fixture"},
				Capture: func(context.Context, string, bool) error { return nil },
				Stream: func(_ context.Context, _ string, _ []string, input io.Reader, _ ...string) ([]byte, error) {
					_, err := io.Copy(io.Discard, input)
					return []byte(`{"message_type":"summary","snapshot_id":"abcd"}`), err
				},
				Run: func(ctx context.Context, _ string, _ []string, args ...string) ([]byte, error) {
					if args[0] == "tag" {
						return []byte(`{"old_snapshot_id":"abcd","new_snapshot_id":"ef12"}`), nil
					}
					if args[0] == "forget" {
						close(retention)
						select {
						case <-finishRetention:
						case <-ctx.Done():
							return nil, ctx.Err()
						}
					}
					return nil, nil
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			defer manager.Close()
			if _, err := manager.Trigger(); err != nil {
				t.Fatal(err)
			}
			<-retention
			fleet := &operatorFleet{fakeFleet: &fakeFleet{}}
			handler := New(fleet, &fakeChats{}, "tok", "test").WithAdmission(&fleet.gate).WithBackups(manager)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			request := httptest.NewRequest("POST", "/v1/operator/recovery/prepare", strings.NewReader(`{"operation_id":"recovery_00000001"}`)).WithContext(ctx)
			request.RemoteAddr = "127.0.0.1:12345"
			request.Header.Set("Authorization", "Bearer tok")
			response := httptest.NewRecorder()
			prepared := make(chan struct{})
			go func() { handler.ServeHTTP(response, request); close(prepared) }()
			deadline := time.After(time.Second)
			for !fleet.gate.Active() {
				select {
				case <-deadline:
					t.Fatal("prepare did not freeze admission")
				case <-time.After(time.Millisecond):
				}
			}
			select {
			case <-prepared:
				t.Fatal("prepare returned while retention could delete the selected snapshot")
			default:
			}
			if cancelWait {
				cancel()
				<-prepared
				if response.Code != http.StatusServiceUnavailable || !fleet.gate.Active() || !manager.Status().Running {
					t.Fatal("cancelled prepare released freeze or interrupted backup", response.Code)
				}
				if err := fleet.ReleaseRecovery("recovery_00000001"); err != nil {
					t.Fatal(err)
				}
				close(finishRetention)
			} else {
				close(finishRetention)
				<-prepared
				if response.Code != http.StatusOK || !fleet.gate.Active() {
					t.Fatal("ready prepare lost freeze", response.Code)
				}
			}
		})
	}
}
