package boat

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func preflightHandler(t *testing.T, m *Manager, f *boatFixture, override func(http.ResponseWriter, *http.Request) bool) {
	t.Helper()
	overrideLifecycleAPI(t, m, f, func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method != "GET" {
			t.Fatalf("read-only preflight mutated provider: %s %s", r.Method, r.URL.Path)
		}
		switch r.URL.Path {
		case "/account/data-retention":
			_, _ = w.Write([]byte(`{}`))
			return true
		case "/saved-snapshots":
			_, _ = w.Write([]byte(`{"allowance":{"included":10}}`))
			return true
		}
		return override != nil && override(w, r)
	})
}
func TestRecoveryPreflightRejectsWrongAccountAndForeignRecordedIDs(t *testing.T) {
	for _, mode := range []string{"valid owner", "wrong account", "foreign current", "wrong labels", "inaccessible current", "missing current without checkpoint", "expired without checkpoint", "expired with checkpoint", "deleted with checkpoint", "missing saved point", "changed saved artifact", "changed saved name", "changed saved source", "unfinished saved point", "previous foreign", "previous wrong labels", "previous deleted", "previous owned unlabeled"} {
		t.Run(mode, func(t *testing.T) {
			f := fixture()
			m, _ := testManager(t, f)
			id := createKitty(t, m)
			if err := m.Stop(context.Background(), id); err != nil {
				t.Fatal(err)
			}
			r, _ := m.lookup(id)
			ok := mode == "valid owner" || mode == "expired with checkpoint" || mode == "deleted with checkpoint" || mode == "previous deleted" || mode == "previous owned unlabeled"
			switch mode {
			case "foreign current":
				s := f.computers[id]
				s.Access = "use"
				f.computers[id] = s
			case "wrong labels":
				s := f.computers[id]
				s.Labels = map[string]string{ownerLabel: "another-deployment"}
				f.computers[id] = s
			case "missing current without checkpoint":
				delete(f.computers, id)
				r.CheckpointID = ""
				_ = m.put(r)
			case "expired without checkpoint", "expired with checkpoint":
				s := f.computers[id]
				s.DataExpiredAt = "2026-10-01T00:00:00Z"
				f.computers[id] = s
				if mode == "expired without checkpoint" {
					r.CheckpointID = ""
					_ = m.put(r)
				}
			case "deleted with checkpoint":
				delete(f.computers, id)
			case "missing saved point":
				delete(f.snapshots, r.CheckpointName)
			case "changed saved artifact", "changed saved name", "changed saved source", "unfinished saved point":
				s := f.snapshots[r.CheckpointName]
				switch mode {
				case "changed saved artifact":
					s.SnapshotID = "another-artifact"
				case "changed saved name":
					s.Name = "another-name"
				case "changed saved source":
					s.SourceSandboxID = "bx_unrecorded"
				case "unfinished saved point":
					s.Status = "saving"
				}
				f.snapshots[r.CheckpointName] = s
			case "previous foreign", "previous wrong labels", "previous deleted", "previous owned unlabeled":
				previous := f.computers[id]
				r.PreviousIDs = []string{id}
				r.RemoteID = "bx_current"
				r.Generation = 2
				current := previous
				current.ID = r.RemoteID
				current.Labels = map[string]string{ownerLabel: m.ownerID, kittyLabel: r.Name, generationLabel: "2"}
				f.computers[current.ID] = current
				_ = m.put(r)
				switch mode {
				case "previous foreign":
					previous.Access = "use"
					f.computers[id] = previous
				case "previous wrong labels":
					previous.Labels = map[string]string{ownerLabel: "other"}
					f.computers[id] = previous
				case "previous deleted":
					delete(f.computers, id)
				case "previous owned unlabeled":
					previous.Labels = nil
					f.computers[id] = previous
				}
			}
			preflightHandler(t, m, f, func(w http.ResponseWriter, q *http.Request) bool {
				if mode == "wrong account" {
					if q.URL.Path == "/sandboxes" {
						_, _ = w.Write([]byte(`{"sandboxes":[]}`))
					} else {
						http.NotFound(w, q)
					}
					return true
				}
				if mode == "inaccessible current" && q.URL.Path == "/sandboxes/"+id {
					http.Error(w, "forbidden", 403)
					return true
				}
				return false
			})
			before, err := os.ReadFile(filepath.Join(m.dir, "state.json"))
			if err != nil {
				t.Fatal(err)
			}
			err = m.CheckAccess(context.Background())
			if (err == nil) != ok {
				t.Fatalf("got %v; expected readiness=%v", err, ok)
			}
			after, err := os.ReadFile(filepath.Join(m.dir, "state.json"))
			if err != nil || string(before) != string(after) {
				t.Fatal("preflight modified restored runtime state")
			}
		})
	}
}

func TestLostDeleteResponseReconcilesOnlyExactRetainedRecovery(t *testing.T) {
	f := fixture()
	m, o := testManager(t, f)
	id := createKitty(t, m)
	lost := false
	overrideLifecycleAPI(t, m, f, func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method == "DELETE" && strings.HasPrefix(r.URL.Path, "/sandboxes/") && !lost {
			lost = true
			f.mu.Lock()
			delete(f.computers, id)
			f.mu.Unlock()
			http.Error(w, "response lost", 503)
			return true
		}
		return false
	})
	if err := m.Remove(context.Background(), id); err == nil {
		t.Fatal("lost deletion response was ignored")
	}
	pending, _ := m.lookup(id)
	if pending.Pending == nil || pending.Pending.Kind != "delete" || pending.Pending.ID != "" || pending.Removed {
		t.Fatal("lost durable delete intent")
	}
	m.Close()
	again, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if err = again.Remove(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	removed, _ := again.lookup(id)
	if !removed.Removed || removed.Pending != nil || removed.CheckpointID != pending.CheckpointID {
		t.Fatal("reconciliation lost recovery or left deletion stuck")
	}
}
func TestDelete404CannotEraseIntentWithoutVerifiedAbsenceAndCheckpoint(t *testing.T) {
	for _, mode := range []string{"still present", "foreign present", "checkpoint absent", "checkpoint replaced", "checkpoint old source", "inspection unavailable"} {
		t.Run(mode, func(t *testing.T) {
			f := fixture()
			m, _ := testManager(t, f)
			id := createKitty(t, m)
			if err := m.Stop(context.Background(), id); err != nil {
				t.Fatal(err)
			}
			r, _ := m.lookup(id)
			r.Pending = &operation{Kind: "delete"}
			_ = m.put(r)
			if mode != "still present" && mode != "foreign present" {
				delete(f.computers, id)
			}
			switch mode {
			case "foreign present":
				s := f.computers[id]
				s.Access = "use"
				f.computers[id] = s
			case "checkpoint absent":
				delete(f.snapshots, r.CheckpointName)
			case "checkpoint replaced":
				s := f.snapshots[r.CheckpointName]
				s.SnapshotID = "newer"
				f.snapshots[r.CheckpointName] = s
			case "checkpoint old source":
				r.PreviousIDs = []string{"bx_previous"}
				_ = m.put(r)
				s := f.snapshots[r.CheckpointName]
				s.SourceSandboxID = "bx_previous"
				f.snapshots[r.CheckpointName] = s
			}
			overrideLifecycleAPI(t, m, f, func(w http.ResponseWriter, q *http.Request) bool {
				if q.Method == "DELETE" {
					http.NotFound(w, q)
					return true
				}
				if mode == "inspection unavailable" && q.URL.Path == "/sandboxes/"+id {
					http.Error(w, "unavailable", 503)
					return true
				}
				return false
			})
			if err := m.Remove(context.Background(), id); err == nil {
				t.Fatal("arbitrary 404 completed deletion")
			}
			after, _ := m.lookup(id)
			if after.Removed || after.Pending == nil {
				t.Fatal("ambiguous deletion lost retry state")
			}
		})
	}
}
func TestPurgedTombstoneAndEmptyStateNeedNoRecoveryObject(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	id := createKitty(t, m)
	if err := m.Remove(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if err := m.PurgeCheckpoint(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	preflightHandler(t, m, f, nil)
	if err := m.CheckAccess(context.Background()); err != nil {
		t.Fatal(err)
	}
	r := record{Name: "kitty-unstarted"}
	if err := m.checkRecordAccess(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if _, err := m.reconcileDeleted(context.Background(), r); err == nil {
		t.Fatal("missing deletion intent accepted")
	}
	if _, err := m.verifiedCheckpoint(context.Background(), r); err == nil {
		t.Fatal("missing checkpoint identity accepted")
	}
}

// The policy endpoint may succeed under a valid but unrelated account; ownership
// is established by exact artifact and machine reads, never by policy alone.
func TestRecoveryPreflightRejectsUnexpectedCurrentMachineIdentity(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	id := createKitty(t, m)
	preflightHandler(t, m, f, func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path == "/sandboxes/"+id {
			_ = json.NewEncoder(w).Encode(map[string]any{"sandbox": sandbox{ID: "bx_other", Access: "owner"}})
			return true
		}
		return false
	})
	if err := m.CheckAccess(context.Background()); err == nil {
		t.Fatal("foreign current identity passed readiness")
	}
}
