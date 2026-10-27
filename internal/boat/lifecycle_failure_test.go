package boat

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/madkoding/kitties/internal/container"
)

func overrideLifecycleAPI(t *testing.T, m *Manager, f *boatFixture, handle func(http.ResponseWriter, *http.Request) bool) {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !handle(w, r) {
			f.serve(w, r)
		}
	}))
	t.Cleanup(s.Close)
	m.baseURL = s.URL
}
func TestAccountRequiresDurableSavedSnapshotPolicy(t *testing.T) {
	for _, tt := range []struct {
		name, policy string
		allowance    int
		failed       string
		ok           bool
	}{{"ready", `{}`, 1, "", true}, {"ZDR", `{"enabled":true}`, 10, "", false}, {"disabled", `{"snapshotsOff":true}`, 10, "", false}, {"free", `{}`, 0, "", false}, {"policy outage", `{}`, 10, "/account/data-retention", false}, {"allowance outage", `{}`, 10, "/saved-snapshots", false}} {
		t.Run(tt.name, func(t *testing.T) {
			f := fixture()
			m, _ := testManager(t, f)
			overrideLifecycleAPI(t, m, f, func(w http.ResponseWriter, r *http.Request) bool {
				if r.URL.Path == tt.failed {
					http.Error(w, "unavailable", 503)
					return true
				}
				switch r.URL.Path {
				case "/account/data-retention":
					_, _ = w.Write([]byte(tt.policy))
					return true
				case "/saved-snapshots":
					_ = json.NewEncoder(w).Encode(map[string]any{"allowance": map[string]int{"included": tt.allowance}})
					return true
				}
				return false
			})
			if e := m.CheckAccess(context.Background()); (e == nil) != tt.ok {
				t.Fatalf("got %v", e)
			}
		})
	}
}
func TestStopNeverClaimsDurabilityForIncompleteProviderStates(t *testing.T) {
	for _, tt := range []struct {
		name     string
		state    sandbox
		failStop bool
	}{{name: "still provisioning", state: sandbox{State: "creating"}}, {name: "archived without snapshot", state: sandbox{State: "archived"}}, {name: "failed snapshot", state: sandbox{State: "archived", SnapshotAvailable: true, LastSnapshotStatus: "failed"}}, {name: "stop request unavailable", state: sandbox{State: "ready", Hydrated: true}, failStop: true}} {
		t.Run(tt.name, func(t *testing.T) {
			f := fixture()
			m, _ := testManager(t, f)
			id := createKitty(t, m)
			s := f.computers[id]
			s.State = tt.state.State
			s.Hydrated = tt.state.Hydrated
			s.SnapshotAvailable = tt.state.SnapshotAvailable
			s.LastSnapshotStatus = tt.state.LastSnapshotStatus
			f.computers[id] = s
			if tt.failStop {
				overrideLifecycleAPI(t, m, f, func(w http.ResponseWriter, r *http.Request) bool {
					if strings.HasSuffix(r.URL.Path, "/stop") {
						http.Error(w, "unavailable", 503)
						return true
					}
					return false
				})
			}
			if e := m.Stop(context.Background(), id); e == nil {
				t.Fatal("claimed durable stop")
			}
			r, _ := m.lookup(id)
			if r.CheckpointID != "" {
				t.Fatal("published incomplete checkpoint")
			}
		})
	}
}
func TestResumeExpiredCheckpointAndInterruptedStopFinishBeforeRestart(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	id := createKitty(t, m)
	if e := m.Stop(context.Background(), id); e != nil {
		t.Fatal(e)
	}
	overrideLifecycleAPI(t, m, f, func(w http.ResponseWriter, r *http.Request) bool {
		if strings.HasSuffix(r.URL.Path, "/resume") {
			w.WriteHeader(409)
			_, _ = w.Write([]byte(`{"code":"snapshot_data_expired"}`))
			return true
		}
		return false
	})
	if e := m.Start(context.Background(), id); e != nil {
		t.Fatal(e)
	}
	r, _ := m.lookup(id)
	if r.RemoteID == id {
		t.Fatal("expired restore reused missing disk")
	}
	r.Pending = &operation{Kind: "stop", StartedAt: time.Now()}
	if e := m.put(r); e != nil {
		t.Fatal(e)
	}
	if e := m.Start(context.Background(), id); e != nil {
		t.Fatal(e)
	}
	r, _ = m.lookup(id)
	if r.Pending != nil || r.CheckpointID == "" {
		t.Fatal("restart lost stop checkpoint")
	}
}
func TestDeletionResumesBlockedOperationWithoutSecondDelete(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	id := createKitty(t, m)
	polls := 0
	overrideLifecycleAPI(t, m, f, func(w http.ResponseWriter, r *http.Request) bool {
		if strings.HasPrefix(r.URL.Path, "/deletion-operations/") {
			polls++
			status := "blocked"
			if polls > 1 {
				status = "completed"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"operation": map[string]string{"status": status}})
			return true
		}
		return false
	})
	if e := m.Remove(context.Background(), id); e != nil {
		t.Fatal(e)
	}
	if polls != 2 || len(f.deleted) != 1 {
		t.Fatal("blocked deletion was abandoned or repeated")
	}
	if e := m.Remove(context.Background(), id); e != nil {
		t.Fatal(e)
	}
}
func TestRenewRequiresCurrentOwnedRunningComputer(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	id := createKitty(t, m)
	patches := 0
	overrideLifecycleAPI(t, m, f, func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method == "PATCH" {
			var body map[string]int
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["ttlSeconds"] != 3600 {
				t.Error("wrong orphan deadline")
			}
			patches++
			_, _ = w.Write([]byte(`{}`))
			return true
		}
		return false
	})
	if e := m.Renew(context.Background(), id); e != nil {
		t.Fatal(e)
	}
	s := f.computers[id]
	s.State = "archived"
	f.computers[id] = s
	if e := m.Renew(context.Background(), id); e == nil {
		t.Fatal("renewed archived VM")
	}
	s.State = "ready"
	s.Access = "use"
	f.computers[id] = s
	if e := m.Renew(context.Background(), id); e == nil {
		t.Fatal("renewed shared VM")
	}
	delete(f.computers, id)
	if e := m.Renew(context.Background(), id); e == nil {
		t.Fatal("renewed missing VM")
	}
	r, _ := m.lookup(id)
	r.Removed = true
	_ = m.put(r)
	if e := m.Renew(context.Background(), id); e == nil {
		t.Fatal("renewed removed VM")
	}
	if patches != 1 {
		t.Fatal("unowned renewal reached provider")
	}
}
func TestUnknownComputerAndInvalidRequestsDoNotReachProvider(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	ctx := context.Background()
	for _, action := range []func() error{func() error { return m.Start(ctx, "missing") }, func() error { return m.Stop(ctx, "missing") }, func() error { return m.Remove(ctx, "missing") }, func() error { return m.PurgeCheckpoint(ctx, "missing") }, func() error { return m.Renew(ctx, "missing") }, func() error { _, e := m.Resolve(ctx, "missing"); return e }, func() error { _, e := m.Exec(ctx, "missing", "true"); return e }, func() error { _, e := m.Screenshot(ctx, "missing"); return e }} {
		if e := action(); e == nil {
			t.Fatal("unknown identity accepted")
		}
	}
	for _, spec := range []container.Spec{{Name: "invalid"}, {Name: "kitty-template-user"}, {Name: "kitty-test", Network: "host"}, {Name: "kitty-test", Env: map[string]string{"bad-key": "a"}}, {Name: "kitty-test", Env: map[string]string{"KEY": "\x00"}}} {
		if _, e := m.Up(ctx, spec); e == nil {
			t.Fatal("unsupported request accepted")
		}
	}
	if len(f.creates) != 0 {
		t.Fatal("invalid request created a VM")
	}
	if c := m.Capabilities(); !c.PersistentDisk || c.ImageUpdates || !c.GuestWorkspace {
		t.Fatal(c)
	}
	if e := m.Pull(ctx, "image"); e == nil {
		t.Fatal("unsupported image update accepted")
	}
	if stale, e := m.ImageStale(ctx, "name", "image"); e != nil || stale {
		t.Fatal("persistent computer treated as container image")
	}
}
func TestInvalidConfigurationAndCorruptIdentityFailBeforeProvider(t *testing.T) {
	for _, change := range []func(*Options){func(o *Options) { o.StateDir = "relative" }, func(o *Options) { o.StateDir = "/" }, func(o *Options) { o.APIKey = " " }, func(o *Options) { o.BaseURL = "http://remote.example" }, func(o *Options) { o.BaseURL = "https://user@example.com" }, func(o *Options) { o.Size = "huge" }, func(o *Options) { o.TTL = time.Second }, func(o *Options) { o.MaxRunning = 6 }} {
		o := Options{StateDir: t.TempDir(), APIKey: "test-key"}
		change(&o)
		if m, e := New(o); e == nil {
			m.Close()
			t.Fatal("invalid config accepted")
		}
	}
	for _, data := range []string{"{", `{"version":8}`, `{"version":1,"owner_id":"01234567890123456789012345678901","computers":{"wrong":{"name":"wrong","generation":1}}}`} {
		dir := t.TempDir()
		if e := os.WriteFile(filepath.Join(dir, "state.json"), []byte(data), 0600); e != nil {
			t.Fatal(e)
		}
		if m, e := New(Options{StateDir: dir, APIKey: "key"}); e == nil {
			m.Close()
			t.Fatal("corrupt identity accepted")
		}
	}
}
func TestFailedLocalJournalWriteRollsBackUnpublishedIntent(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	id := createKitty(t, m)
	before, _ := m.lookup(id)
	m.dir = filepath.Join(t.TempDir(), "missing")
	changed := before
	changed.Removed = true
	if e := m.put(changed); e == nil {
		t.Fatal("accepted failed durable write")
	}
	after, _ := m.lookup(id)
	if after.Removed {
		t.Fatal("failed write changed in-memory identity")
	}
	fresh := record{Name: "kitty-unpublished"}
	if e := m.put(fresh); e == nil {
		t.Fatal("accepted failed creation journal")
	}
	if _, e := m.lookup(fresh.Name); e == nil {
		t.Fatal("kept unpersisted record")
	}
}
func TestCanceledLifecycleOperationsReturnWithoutMutations(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, action := range []func() error{func() error { _, e := m.Up(ctx, container.Spec{Name: "kitty-test"}); return e }, func() error { return m.Start(ctx, "kitty-test") }, func() error { return m.Remove(ctx, "kitty-test") }, func() error { return m.PurgeCheckpoint(ctx, "kitty-test") }, func() error { return m.ExportHome(ctx, "kitty-test", nil) }} {
		if e := action(); !errors.Is(e, context.Canceled) {
			t.Fatalf("got %v", e)
		}
	}
}

func TestStopAndCheckpointPollingPreserveIntentOnProviderErrors(t *testing.T) {
	for _, mode := range []string{"missing identity", "get failed", "ownership changed", "archiving timeout", "failed stop", "checkpoint POST failed", "checkpoint GET failed", "checkpoint changed", "checkpoint pending"} {
		t.Run(mode, func(t *testing.T) {
			f := fixture()
			m, _ := testManager(t, f)
			id := createKitty(t, m)
			r, _ := m.lookup(id)
			if mode == "missing identity" {
				r.RemoteID = ""
				if e := m.stop(context.Background(), r); e == nil {
					t.Fatal("stopped unresolved create")
				}
				return
			}
			s := f.computers[id]
			switch mode {
			case "get failed":
				delete(f.computers, id)
			case "ownership changed":
				s.Access = "use"
				f.computers[id] = s
			case "archiving timeout":
				s.State = "archiving"
				f.computers[id] = s
			case "failed stop":
				s.State = "archived"
				s.Stop = &struct{ ID, Status, Error string }{Status: "failing", Error: "disk failed"}
				f.computers[id] = s
			}
			if strings.HasPrefix(mode, "checkpoint") {
				overrideLifecycleAPI(t, m, f, func(w http.ResponseWriter, q *http.Request) bool {
					if mode == "checkpoint POST failed" && q.Method == "POST" && q.URL.Path == "/saved-snapshots" {
						http.Error(w, "unavailable", 503)
						return true
					}
					if q.Method == "GET" && strings.HasPrefix(q.URL.Path, "/saved-snapshots/") {
						switch mode {
						case "checkpoint GET failed":
							http.Error(w, "unavailable", 503)
							return true
						case "checkpoint changed":
							_ = json.NewEncoder(w).Encode(map[string]any{"snapshot": savedSnapshot{Status: "ready", SnapshotID: "wrong", SourceSandboxID: "other"}})
							return true
						case "checkpoint pending":
							_, _ = w.Write([]byte(`{"snapshot":{"status":"saving"}}`))
							return true
						}
					}
					return false
				})
			}
			ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
			defer cancel()
			if e := m.Stop(ctx, id); e == nil {
				t.Fatal("reported durable checkpoint despite failure")
			}
			r, _ = m.lookup(id)
			if r.CheckpointID != "" {
				t.Fatal("published unverified point")
			}
		})
	}
}
func TestInterruptedDeleteCannotLoseItsOperation(t *testing.T) {
	for _, mode := range []string{"request fails", "missing receipt", "poll fails", "poll canceled"} {
		t.Run(mode, func(t *testing.T) {
			f := fixture()
			m, _ := testManager(t, f)
			id := createKitty(t, m)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			interrupted := make(chan struct{}, 1)
			markInterrupted := func() {
				select {
				case interrupted <- struct{}{}:
				default:
				}
			}
			overrideLifecycleAPI(t, m, f, func(w http.ResponseWriter, r *http.Request) bool {
				if r.Method == "DELETE" {
					if mode == "request fails" {
						markInterrupted()
						http.Error(w, "unavailable", 503)
						return true
					}
					if mode == "missing receipt" {
						markInterrupted()
						_, _ = w.Write([]byte(`{}`))
						return true
					}
				}
				if strings.HasPrefix(r.URL.Path, "/deletion-operations/") {
					if mode == "poll fails" {
						markInterrupted()
						http.Error(w, "unavailable", 503)
						return true
					}
					if mode == "poll canceled" {
						markInterrupted()
						cancel()
						_, _ = w.Write([]byte(`{"operation":{"status":"blocked"}}`))
						return true
					}
				}
				return false
			})
			if e := m.Remove(ctx, id); e == nil {
				t.Fatal("incomplete delete reported as complete")
			}
			select {
			case <-interrupted:
			default:
				t.Fatal("remove failed before the intended deletion interruption")
			}
			r, _ := m.lookup(id)
			if r.Removed || r.Pending == nil || r.Pending.Kind != "delete" || r.CheckpointID == "" {
				t.Fatal("deletion lost recovery or retry state")
			}
		})
	}
}
func TestExportRefusesChangedIncompleteAndWrongContent(t *testing.T) {
	for _, mode := range []string{"unknown", "no checkpoint", "saved missing", "changed", "file failure", "wrong kind", "unavailable bytes", "skipped bytes"} {
		t.Run(mode, func(t *testing.T) {
			f := fixture()
			m, _ := testManager(t, f)
			id := createKitty(t, m)
			if mode != "no checkpoint" {
				if e := m.Stop(context.Background(), id); e != nil {
					t.Fatal(e)
				}
			}
			if mode == "unknown" {
				id = "missing"
			}
			overrideLifecycleAPI(t, m, f, func(w http.ResponseWriter, r *http.Request) bool {
				if r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/saved-snapshots/") {
					if mode == "saved missing" {
						http.NotFound(w, r)
						return true
					}
					if mode == "changed" {
						_, _ = w.Write([]byte(`{"snapshot":{"status":"ready","snapshotId":"other"}}`))
						return true
					}
				}
				if strings.HasSuffix(r.URL.Path, "/files") {
					switch mode {
					case "file failure":
						http.Error(w, "unavailable", 503)
						return true
					case "wrong kind":
						w.Header().Set("X-Snapshot-Entry-Kind", "file")
						return true
					case "unavailable bytes":
						w.WriteHeader(404)
						_, _ = w.Write([]byte(`{"code":"content_unavailable"}`))
						return true
					case "skipped bytes":
						w.Header().Set("X-Snapshot-Entry-Kind", "dir")
						w.Header().Set("X-Snapshot-Skipped-Base-Image-Files", "1")
						return true
					}
				}
				return false
			})
			if e := m.ExportHome(context.Background(), id, &strings.Builder{}); e == nil {
				t.Fatal("accepted unverifiable export")
			}
		})
	}
}
