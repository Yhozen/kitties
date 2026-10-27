package boat

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestRestoredGatewayStateCannotDuplicateNewerProviderGeneration(t *testing.T) {
	for _, unlabeled := range []bool{false, true} {
		t.Run(map[bool]string{false: "labeled", true: "restore lost labels"}[unlabeled], func(t *testing.T) {
			f := fixture()
			m, _ := testManager(t, f)
			id := createKitty(t, m)
			if e := m.Stop(context.Background(), id); e != nil {
				t.Fatal(e)
			}
			r, _ := m.lookup(id)
			delete(f.computers, id)
			labels := map[string]string{ownerLabel: m.ownerID, kittyLabel: r.Name, generationLabel: "2"}
			if unlabeled {
				labels = map[string]string{}
			}
			f.computers["bx_newer"] = sandbox{ID: "bx_newer", Access: "owner", Name: r.Name, State: "ready", Hydrated: true, Labels: labels}
			if e := m.Start(context.Background(), id); e == nil || !strings.Contains(e.Error(), "reconcile") {
				t.Fatalf("got %v", e)
			}
			if len(f.creates) != 1 {
				t.Fatal("old gateway created duplicate VM")
			}
		})
	}
}
func TestUnknownUnlabeledComputerAllowsOnlyExactUnexpiredCreateReplay(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	r := record{Name: "kitty-pending", Generation: 1, Pending: &operation{Kind: "create", Key: "exact-key", Body: json.RawMessage(`{"name":"kitty-pending"}`), StartedAt: time.Now()}}
	f.computers["bx_pending"] = sandbox{ID: "bx_pending", Name: r.Name, Access: "owner", Labels: map[string]string{}}
	if e := m.guardGeneration(context.Background(), r); e != nil {
		t.Fatal(e)
	}
	r.Pending.StartedAt = time.Now().Add(-25 * time.Hour)
	if e := m.guardGeneration(context.Background(), r); e == nil {
		t.Fatal("expired replay accepted unknown VM")
	}
	r.Pending = nil
	if e := m.guardGeneration(context.Background(), r); e == nil {
		t.Fatal("name alone authorized create")
	}
}

func TestGenerationConflictGuardPaginatesAndRejectsLoops(t *testing.T) {
	for _, mode := range []string{"newer later page", "broken pagination", "loop"} {
		t.Run(mode, func(t *testing.T) {
			f := fixture()
			m, _ := testManager(t, f)
			r := record{Name: "kitty-mimi", RemoteID: "bx_old", Generation: 1}
			calls := 0
			overrideLifecycleAPI(t, m, f, func(w http.ResponseWriter, q *http.Request) bool {
				calls++
				next := "next"
				if mode == "broken pagination" {
					next = ""
				}
				if mode == "newer later page" && q.URL.Query().Get("cursor") == "next" {
					_ = json.NewEncoder(w).Encode(map[string]any{"sandboxes": []sandbox{{ID: "bx_new", Name: r.Name, Access: "owner", Labels: map[string]string{ownerLabel: m.ownerID, kittyLabel: r.Name, generationLabel: "2"}}}})
					return true
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"pageInfo": map[string]any{"hasMore": true, "nextCursor": next}})
				return true
			})
			if e := m.guardGeneration(context.Background(), r); e == nil {
				t.Fatal("accepted ambiguous paginated inventory")
			}
			if calls > 2 {
				t.Fatal("pagination loop did not terminate")
			}
		})
	}
}

func TestOldRecoveryCannotPurgeNewerSavedCheckpointAfterRemoteDeletion(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	id := createKitty(t, m)
	if e := m.Remove(context.Background(), id); e != nil {
		t.Fatal(e)
	}
	r, _ := m.lookup(id)
	point := f.snapshots[r.CheckpointName]
	point.SnapshotID = "newer-permanent-point"
	f.snapshots[r.CheckpointName] = point
	if e := m.PurgeCheckpoint(context.Background(), id); e == nil {
		t.Fatal("old gateway purged newer work")
	}
	if _, ok := f.snapshots[r.CheckpointName]; !ok {
		t.Fatal("newer checkpoint was deleted")
	}
}

func TestStaleProviderGenerationBlocksStartupAndMutations(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	id := createKitty(t, m)
	r, _ := m.lookup(id)
	f.computers["bx_newer"] = sandbox{ID: "bx_newer", Name: r.Name, Access: "owner", Labels: map[string]string{ownerLabel: m.ownerID, kittyLabel: r.Name, generationLabel: "2"}}
	overrideLifecycleAPI(t, m, f, func(w http.ResponseWriter, q *http.Request) bool {
		switch q.URL.Path {
		case "/account/data-retention":
			_, _ = w.Write([]byte(`{}`))
			return true
		case "/saved-snapshots":
			if q.Method == "GET" {
				_, _ = w.Write([]byte(`{"allowance":{"included":10}}`))
				return true
			}
		}
		return false
	})
	for _, action := range []func() error{func() error { return m.CheckAccess(context.Background()) }, func() error { return m.Stop(context.Background(), id) }, func() error { return m.Remove(context.Background(), id) }} {
		if e := action(); e == nil || !strings.Contains(e.Error(), "reconcile") {
			t.Fatalf("stale gateway action got %v", e)
		}
	}
	if !f.computers[id].running() || len(f.deleted) != 0 {
		t.Fatal("stale gateway mutated provider computers")
	}
	r.Removed = true
	_ = m.put(r)
	if e := m.PurgeCheckpoint(context.Background(), id); e == nil {
		t.Fatal("stale gateway purged recovery")
	}
}
func TestPurgeMissingPointIsIdempotentButProviderOutageRetainsReference(t *testing.T) {
	for _, missing := range []bool{false, true} {
		t.Run(map[bool]string{false: "outage", true: "already absent"}[missing], func(t *testing.T) {
			f := fixture()
			m, _ := testManager(t, f)
			id := createKitty(t, m)
			if e := m.Remove(context.Background(), id); e != nil {
				t.Fatal(e)
			}
			r, _ := m.lookup(id)
			if missing {
				delete(f.snapshots, r.CheckpointName)
			} else {
				overrideLifecycleAPI(t, m, f, func(w http.ResponseWriter, q *http.Request) bool {
					if strings.HasPrefix(q.URL.Path, "/saved-snapshots/") {
						http.Error(w, "unavailable", 503)
						return true
					}
					return false
				})
			}
			e := m.PurgeCheckpoint(context.Background(), id)
			if (e == nil) != missing {
				t.Fatalf("got %v", e)
			}
			after, _ := m.lookup(id)
			if (after.CheckpointID == "") != missing {
				t.Fatal("recovery reference lost on failed purge")
			}
		})
	}
}
