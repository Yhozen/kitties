package boat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madkoding/kitties/internal/container"
)

type boatFixture struct {
	failedExport                                  bool
	mu                                            sync.Mutex
	computers                                     map[string]sandbox
	snapshots                                     map[string]savedSnapshot
	creates                                       []createRequest
	keys                                          []string
	deleted                                       []string
	failedCreate, failedInventory, failedSnapshot bool
	dropRestoreLabels                             bool
	nextID                                        int
}

func fixture() *boatFixture {
	return &boatFixture{computers: map[string]sandbox{}, snapshots: map[string]savedSnapshot{}}
}
func (f *boatFixture) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	write := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	fail := func(status int, code string) {
		w.WriteHeader(status)
		write(map[string]any{"code": code, "message": code})
	}
	if r.Header.Get("Authorization") != "Bearer test-key" {
		fail(401, "unauthorized")
		return
	}
	switch {
	case r.URL.Path == "/sandboxes" && r.Method == "GET":
		if f.failedInventory {
			fail(503, "unavailable")
			return
		}
		list := []sandbox{}
		for _, s := range f.computers {
			list = append(list, s)
		}
		write(map[string]any{"sandboxes": list, "pageInfo": map[string]any{"hasMore": false}})
	case r.URL.Path == "/sandboxes" && r.Method == "POST":
		var body createRequest
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.creates = append(f.creates, body)
		f.keys = append(f.keys, r.Header.Get("Idempotency-Key"))
		f.nextID++
		id := fmt.Sprintf("bx_test%d", f.nextID)
		s := sandbox{Access: "owner", ID: id, Name: body.Name, State: "ready", Hydrated: true, Labels: body.Labels}
		if f.dropRestoreLabels && body.From != "" {
			s.Labels = map[string]string{}
		}
		f.computers[id] = s
		if f.failedCreate {
			f.failedCreate = false
			fail(503, "lost_response")
			return
		}
		write(map[string]any{"sandbox": s})
	case r.URL.Path == "/saved-snapshots" && r.Method == "POST":
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		snap := savedSnapshot{Name: body["name"], Status: "ready", SnapshotID: "snapshot-" + body["sandboxId"], SourceSandboxID: body["sandboxId"]}
		if f.failedSnapshot {
			snap.Status = "failed"
			snap.Error = "capture failed"
		}
		f.snapshots[body["name"]] = snap
		write(map[string]any{"snapshot": snap})
	case strings.HasPrefix(r.URL.Path, "/saved-snapshots/"):
		name := strings.TrimPrefix(r.URL.Path, "/saved-snapshots/")
		snap, ok := f.snapshots[name]
		if !ok {
			fail(404, "not_found")
			return
		}
		if r.Method == "DELETE" {
			delete(f.snapshots, name)
			write(map[string]bool{"ok": true})
			return
		}
		write(map[string]any{"snapshot": snap})
	case strings.HasPrefix(r.URL.Path, "/deletion-operations/"):
		write(map[string]any{"operation": map[string]string{"status": "completed"}})
	case strings.HasPrefix(r.URL.Path, "/snapshots/") && strings.HasSuffix(r.URL.Path, "/files"):
		if f.failedExport {
			fail(404, "content_unavailable")
			return
		}
		if r.URL.Query().Get("path") != "__system__/home/kitty" {
			fail(400, "wrong_home")
			return
		}
		w.Header().Set("X-Snapshot-Entry-Kind", "dir")
		w.Header().Set("Content-Type", "application/x-tar")
		_, _ = io.WriteString(w, "home archive")
	case strings.HasPrefix(r.URL.Path, "/sandboxes/"):
		rest := strings.TrimPrefix(r.URL.Path, "/sandboxes/")
		parts := strings.Split(rest, "/")
		s, ok := f.computers[parts[0]]
		if !ok {
			fail(404, "not_found")
			return
		}
		if len(parts) == 1 {
			if r.Method == "DELETE" {
				f.deleted = append(f.deleted, s.ID)
				delete(f.computers, s.ID)
				write(map[string]any{"operation": map[string]string{"id": "bdop_test"}})
				return
			}
			write(map[string]any{"sandbox": s})
			return
		}
		switch parts[1] {
		case "stop":
			s.State = "archived"
			s.SnapshotAvailable = true
			s.LastSnapshotStatus = "completed"
			f.computers[s.ID] = s
			write(map[string]bool{"ok": true})
		case "resume":
			s.State = "ready"
			s.Hydrated = true
			f.computers[s.ID] = s
			write(map[string]bool{"ok": true})
		case "sshkey":
			write(map[string]string{"machineIp": "127.0.0.1", "sshUser": "user", "hostKey": "ssh-ed25519 YWJj"})
		default:
			fail(404, "unknown_action")
		}
	default:
		fail(404, "unknown_path")
	}
}
func testManager(t *testing.T, f *boatFixture) (*Manager, Options) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("Boat gateway requires Linux or macOS")
	}
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(server.Close)
	o := Options{StateDir: t.TempDir(), APIKey: "test-key", BaseURL: server.URL}
	m, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	m.poll = time.Millisecond
	name := m.templateName()
	template := record{Name: name, KittyName: "clean-template", Template: true, RemoteID: "bx_template", Generation: 1, CheckpointName: checkpointName(m.ownerID, name), CheckpointID: "template-snapshot", Removed: true}
	if err := m.put(template); err != nil {
		t.Fatal(err)
	}
	f.snapshots[template.CheckpointName] = savedSnapshot{Name: template.CheckpointName, Status: "ready", SnapshotID: template.CheckpointID, SourceSandboxID: template.RemoteID}
	m.runGuest = func(context.Context, record, string, bool, ...string) ([]byte, error) { return []byte("ready"), nil }
	t.Cleanup(func() { m.Close() })
	return m, o
}
func createKitty(t *testing.T, m *Manager) string {
	t.Helper()
	id, err := m.Up(context.Background(), container.Spec{Name: "kitty-mimi", KittyName: "mimi"})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestLostCreateResponseRecoversSameComputerAfterRestart(t *testing.T) {
	f := fixture()
	f.failedCreate = true
	m, o := testManager(t, f)
	if _, err := m.Up(context.Background(), container.Spec{Name: "kitty-mimi", KittyName: "mimi"}); err == nil {
		t.Fatal("expected uncertain create")
	}
	before, _ := m.lookup("kitty-mimi")
	if before.Pending == nil || before.Pending.Key == "" {
		t.Fatal("create intent was not saved")
	}
	m.Close()
	m, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	m.runGuest = func(context.Context, record, string, bool, ...string) ([]byte, error) { return nil, nil }
	if err = m.Start(context.Background(), "kitty-mimi"); err != nil {
		t.Fatal(err)
	}
	after, _ := m.Resolve(context.Background(), "kitty-mimi")
	if after.ID != "bx_test1" || len(f.creates) != 1 {
		t.Fatalf("duplicated or lost computer: %+v creates=%d", after, len(f.creates))
	}
	body := f.creates[0]
	if !body.NoEnv || !body.Snapshots || body.Visibility != "private" || body.TTLSeconds != 3600 || body.Type != "small" {
		t.Fatalf("unsafe create body: %+v", body)
	}
	if f.keys[0] != before.Pending.Key {
		t.Fatal("idempotency key changed")
	}
}
func TestExpiredIdempotencyAndInventoryFailureNeverCreateBlankComputer(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	r := record{Name: "kitty-mimi", KittyName: "mimi", Generation: 1, CheckpointName: checkpointName(m.ownerID, "kitty-mimi"), Pending: &operation{Kind: "create", Key: "old", Body: json.RawMessage(`{}`), StartedAt: time.Now().Add(-25 * time.Hour)}}
	if err := m.put(r); err != nil {
		t.Fatal(err)
	}
	if err := m.Start(context.Background(), r.Name); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("got %v", err)
	}
	f.failedInventory = true
	if _, err := m.Up(context.Background(), container.Spec{Name: "kitty-other", KittyName: "other"}); err == nil {
		t.Fatal("inventory outage ignored")
	}
	if len(f.creates) != 0 {
		t.Fatal("created during ambiguity")
	}
}
func TestDurableStopFailurePreservesLastVerifiedCheckpoint(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	id := createKitty(t, m)
	if err := m.Stop(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	before, _ := m.Resolve(context.Background(), id)
	if err := m.Start(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	f.failedSnapshot = true
	if err := m.Stop(context.Background(), id); err == nil {
		t.Fatal("failed permanent checkpoint reported as stopped")
	}
	after, _ := m.Resolve(context.Background(), id)
	if before.CheckpointID == "" || after.CheckpointID != before.CheckpointID {
		t.Fatal("discarded previous recovery point")
	}
	r, _ := m.lookup(id)
	if r.Pending == nil || r.Pending.Kind != "checkpoint" {
		t.Fatal("lost checkpoint retry intent")
	}
}
func TestExpiredMachineRestoresCheckpointAndKeepsOldIDAlias(t *testing.T) {
	f := fixture()
	m, o := testManager(t, f)
	oldID := createKitty(t, m)
	if err := m.Stop(context.Background(), oldID); err != nil {
		t.Fatal(err)
	}
	s := f.computers[oldID]
	s.DataExpiredAt = time.Now().Format(time.RFC3339)
	f.computers[oldID] = s
	if err := m.Start(context.Background(), oldID); err != nil {
		t.Fatal(err)
	}
	ref, _ := m.Resolve(context.Background(), oldID)
	if ref.ID == oldID || ref.Generation != 2 || len(f.creates) != 2 || f.creates[1].From == "" {
		t.Fatalf("incorrect restore: %+v", ref)
	}
	m.Close()
	m, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	again, err := m.Resolve(context.Background(), oldID)
	if err != nil || again != ref {
		t.Fatalf("alias lost across restart: %+v %v", again, err)
	}
}
func TestMissingMachineWithoutCheckpointFailsClosed(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	id := createKitty(t, m)
	delete(f.computers, id)
	if err := m.Start(context.Background(), id); err == nil {
		t.Fatal("missing durable work became a blank desktop")
	}
	if len(f.creates) != 1 {
		t.Fatal("created blank computer")
	}
}
func TestRemoveRetainsRecoveryUntilExplicitPurge(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	id := createKitty(t, m)
	if err := m.PurgeCheckpoint(context.Background(), id); err == nil {
		t.Fatal("purged active computer recovery")
	}
	if err := m.Remove(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	r, _ := m.lookup(id)
	if !r.Removed || len(f.snapshots) != 2 || !reflect.DeepEqual(f.deleted, []string{id}) {
		t.Fatal("removal lost recovery")
	}
	var archive strings.Builder
	if err := m.ExportHome(context.Background(), id, &archive); err != nil || archive.String() != "home archive" {
		t.Fatalf("export: %s %v", archive.String(), err)
	}
	if err := m.PurgeCheckpoint(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if len(f.snapshots) != 1 {
		t.Fatal("purge did not delete checkpoint")
	}
}
func TestOwnershipMismatchCannotExecute(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	id := createKitty(t, m)
	s := f.computers[id]
	s.Labels = map[string]string{ownerLabel: "someone-else"}
	f.computers[id] = s
	m.runGuest = m.sshRun
	if _, err := m.Exec(context.Background(), id, "true"); err == nil || !strings.Contains(err.Error(), "ownership") {
		t.Fatalf("got %v", err)
	}
}
func TestStateHasOneWriterAndPrivatePermissions(t *testing.T) {
	f := fixture()
	m, o := testManager(t, f)
	if second, err := New(o); err == nil {
		second.Close()
		t.Fatal("allowed competing state writer")
	}
	info, err := os.Stat(filepath.Join(m.dir, "state.json"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("state permissions: %v %v", info, err)
	}
}
func TestCapacityIsBounded(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	m.maxRunning = 1
	createKitty(t, m)
	if _, err := m.Up(context.Background(), container.Spec{Name: "kitty-second", KittyName: "second"}); err == nil {
		t.Fatal("capacity ignored")
	}
	if len(f.creates) != 1 {
		t.Fatal("created above capacity")
	}
}
func TestQuiesceFailureDoesNotStopOrReportCheckpoint(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	id := createKitty(t, m)
	m.runGuest = func(context.Context, record, string, bool, ...string) ([]byte, error) {
		return nil, errors.New("browser did not close")
	}
	if err := m.Stop(context.Background(), id); err == nil {
		t.Fatal("ignored unsafe browser state")
	}
	if !f.computers[id].running() || len(f.snapshots) != 1 {
		t.Fatal("stopped despite quiesce failure")
	}
}

func TestRemovedRecoveryRemainsDiscoverableWithoutKitty(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	id := createKitty(t, m)
	if err := m.Remove(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	points := m.Recoveries()
	if len(points) != 1 || !points[0].Removed || points[0].Name != "kitty-mimi" || points[0].Computer.CheckpointID == "" {
		t.Fatalf("lost recovery metadata: %+v", points)
	}
	if err := m.PurgeCheckpoint(context.Background(), points[0].Name); err != nil {
		t.Fatal(err)
	}
	if len(m.Recoveries()) != 0 {
		t.Fatal("purged checkpoint still advertised")
	}
}

func TestNameReuseDoesNotImplicitlyRestoreRemovedComputer(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	id := createKitty(t, m)
	if err := m.Remove(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Up(context.Background(), container.Spec{Name: "kitty-mimi", KittyName: "mimi"}); err == nil {
		t.Fatal("name reuse silently restored removed work")
	}
	if len(f.creates) != 1 {
		t.Fatal("name reuse created a machine")
	}
}

func TestRestoreWithoutProviderLabelsRequiresExactReceiptAndStillCountsCapacity(t *testing.T) {
	f := fixture()
	f.dropRestoreLabels = true
	m, _ := testManager(t, f)
	m.maxRunning = 1
	oldID := createKitty(t, m)
	if err := m.Remove(context.Background(), oldID); err != nil {
		t.Fatal(err)
	}
	if err := m.Start(context.Background(), oldID); err != nil {
		t.Fatal(err)
	}
	ref, _ := m.Resolve(context.Background(), oldID)
	list, err := m.List(context.Background())
	if err != nil || len(list) != 1 || list[0].ID != ref.ID {
		t.Fatalf("restored computer disappeared: %+v %v", list, err)
	}
	if _, err = m.Up(context.Background(), container.Spec{Name: "kitty-second", KittyName: "second"}); err == nil {
		t.Fatal("unlabeled restore escaped capacity limit")
	}
	r, _ := m.lookup(ref.ID)
	s := f.computers[ref.ID]
	r.Receipt = nil
	if err = m.checkOwner(r, s); err == nil {
		t.Fatal("unlabeled computer trusted without creation receipt")
	}
	r, _ = m.lookup(ref.ID)
	s.Access = "use"
	if err = m.checkOwner(r, s); err == nil {
		t.Fatal("shared computer trusted as owned")
	}
	s.Access = "owner"
	s.ID = "bx_other"
	if err = m.checkOwner(r, s); err == nil {
		t.Fatal("receipt accepted different remote ID")
	}
}

func TestCanceledLifecycleDoesNotWaitBehindAnotherComputer(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	id := createKitty(t, m)
	if err := m.lockLifecycle(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() { <-m.lifecycle }()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan error, 1)
	go func() { done <- m.Stop(ctx, id) }()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("canceled operation blocked on lifecycle lock")
	}
}
func TestCannotPurgeCheckpointDuringPendingRestore(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	id := createKitty(t, m)
	if err := m.Remove(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	r, _ := m.lookup(id)
	r.Pending = &operation{Kind: "create", StartedAt: time.Now()}
	if err := m.put(r); err != nil {
		t.Fatal(err)
	}
	if err := m.PurgeCheckpoint(context.Background(), id); err == nil {
		t.Fatal("purged recovery needed by a pending restore")
	}
	if len(f.snapshots) != 2 {
		t.Fatal("deleted pending recovery")
	}
}
