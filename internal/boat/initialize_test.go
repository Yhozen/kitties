package boat

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestStartupReconcilesLostCheckpointPromotionButRecoveryPreflightDoesNot(t *testing.T) {
	f := fixture()
	m, o := testManager(t, f)
	id := createKitty(t, m)
	if err := m.Stop(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	before, _ := m.lookup(id)
	if err := m.Start(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	overrideLifecycleAPI(t, m, f, func(w http.ResponseWriter, q *http.Request) bool {
		if q.Method == "POST" && q.URL.Path == "/saved-snapshots" {
			f.snapshots[before.CheckpointName] = savedSnapshot{Name: before.CheckpointName, Status: "ready", SnapshotID: "promoted-before-crash", SourceSandboxID: id}
			http.Error(w, "response lost", 503)
			return true
		}
		return false
	})
	if err := m.Stop(context.Background(), id); err == nil {
		t.Fatal("lost promotion response ignored")
	}
	pending, _ := m.lookup(id)
	if pending.Pending == nil || pending.Pending.Kind != "checkpoint" || pending.CheckpointID != before.CheckpointID {
		t.Fatal("checkpoint intent or previous recovery lost")
	}
	m.Close()
	again, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	preflightHandler(t, again, f, nil)
	saved, err := os.ReadFile(filepath.Join(again.dir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err = again.CheckAccess(context.Background()); err == nil {
		t.Fatal("strict recovery preflight adopted pending promotion")
	}
	unchanged, _ := os.ReadFile(filepath.Join(again.dir, "state.json"))
	if string(unchanged) != string(saved) {
		t.Fatal("read-only preflight changed runtime state")
	}
	if err = again.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	restored, _ := again.lookup(id)
	if restored.Pending != nil || restored.CheckpointID != "promoted-before-crash" || restored.RemoteID != id {
		t.Fatal("normal startup failed to finish exact pending promotion")
	}
	if err = again.CheckAccess(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err = again.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(f.creates) != 1 {
		t.Fatal("checkpoint reconciliation created a replacement machine")
	}
}

func TestStartupRetriesOnlyUnfinishedPromotionFromOwnedArchivedSource(t *testing.T) {
	for _, mode := range []string{"old point", "missing point", "failed point", "foreign owner", "running source", "unrelated new point", "snapshot expired"} {
		t.Run(mode, func(t *testing.T) {
			f := fixture()
			m, _ := testManager(t, f)
			id := createKitty(t, m)
			if err := m.Stop(context.Background(), id); err != nil {
				t.Fatal(err)
			}
			r, _ := m.lookup(id)
			r.Pending = &operation{Kind: "checkpoint"}
			if err := m.put(r); err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "missing point":
				delete(f.snapshots, r.CheckpointName)
			case "failed point":
				p := f.snapshots[r.CheckpointName]
				p.Status = "failed"
				f.snapshots[r.CheckpointName] = p
			case "foreign owner":
				s := f.computers[id]
				s.Access = "use"
				f.computers[id] = s
			case "running source":
				s := f.computers[id]
				s.State = "ready"
				f.computers[id] = s
			case "unrelated new point":
				p := f.snapshots[r.CheckpointName]
				p.SnapshotID = "someone-elses-point"
				p.SourceSandboxID = "bx_other"
				f.snapshots[r.CheckpointName] = p
			case "snapshot expired":
				s := f.computers[id]
				s.DataExpiredAt = "2026-10-01"
				f.computers[id] = s
			}
			writes := 0
			overrideLifecycleAPI(t, m, f, func(w http.ResponseWriter, q *http.Request) bool {
				if q.Method == "GET" {
					switch q.URL.Path {
					case "/account/data-retention":
						_, _ = w.Write([]byte(`{}`))
						return true
					case "/saved-snapshots":
						_, _ = w.Write([]byte(`{"allowance":{"included":10}}`))
						return true
					}
					return false
				}
				if q.Method != "POST" || q.URL.Path != "/saved-snapshots" {
					t.Fatalf("unexpected startup mutation: %s %s", q.Method, q.URL.Path)
				}
				var body map[string]string
				_ = json.NewDecoder(q.Body).Decode(&body)
				if body["sandboxId"] != id || body["name"] != r.CheckpointName {
					t.Fatal("reconciled a different source")
				}
				writes++
				f.snapshots[r.CheckpointName] = savedSnapshot{Name: r.CheckpointName, Status: "ready", SnapshotID: "retried-promotion", SourceSandboxID: id}
				_, _ = w.Write([]byte(`{}`))
				return true
			})
			allowed := mode == "old point" || mode == "missing point" || mode == "failed point"
			err := m.Initialize(context.Background())
			if (err == nil) != allowed {
				t.Fatalf("got %v; allowed=%v", err, allowed)
			}
			current, _ := m.lookup(id)
			if allowed {
				if writes != 1 || current.Pending != nil || current.CheckpointID != "retried-promotion" {
					t.Fatal("did not finish interrupted checkpoint")
				}
			} else {
				if writes != 0 || current.Pending == nil {
					t.Fatal("unsafe checkpoint reconciliation mutated state")
				}
			}
		})
	}
}
