package boat

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/madkoding/kitties/internal/computer"
)

type inputBoundary struct {
	mu                sync.Mutex
	machine           sandbox
	inventory         []sandbox
	paginate          bool
	missing           bool
	registrationError string
	requests          []string
}

func preparedBoundary(t *testing.T) (*Manager, record, computer.Reference, *inputBoundary) {
	t.Helper()
	f := &inputBoundary{}
	m := apiBoundary(t, func(w http.ResponseWriter, q *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.requests = append(f.requests, q.Method+" "+q.URL.Path)
		switch {
		case q.URL.Path == "/sandboxes":
			if f.paginate && q.URL.Query().Get("cursor") == "" {
				_ = json.NewEncoder(w).Encode(map[string]any{"sandboxes": []sandbox{}, "pageInfo": map[string]any{"hasMore": true, "nextCursor": "next"}})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"sandboxes": f.inventory})
		case strings.HasSuffix(q.URL.Path, "/sshkey"):
			if f.registrationError != "" {
				w.WriteHeader(409)
				_ = json.NewEncoder(w).Encode(map[string]string{"code": f.registrationError})
				return
			}
			_ = json.NewEncoder(w).Encode(validAccess())
		default:
			if f.missing {
				w.WriteHeader(404)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"sandbox": f.machine})
		}
	})
	r := record{Name: "kitty-mimi", KittyName: "mimi", RemoteID: "bx_current", PreviousIDs: []string{"bx_old"}, Generation: 2, CheckpointID: "snapshot-fixture"}
	r.CheckpointName = checkpointName(m.ownerID, r.Name)
	if err := m.put(r); err != nil {
		t.Fatal(err)
	}
	f.machine = sandbox{ID: r.RemoteID, Name: r.Name, Access: "owner", State: "ready", Hydrated: true, Labels: map[string]string{ownerLabel: m.ownerID, kittyLabel: r.Name, generationLabel: "2"}}
	f.inventory = []sandbox{f.machine}
	fakeKey(t, m)
	ref, err := m.Resolve(context.Background(), r.Name)
	if err != nil {
		t.Fatal(err)
	}
	return m, r, ref, f
}

func TestWarmInputChecksFreshProviderProofWithoutLifecycleWork(t *testing.T) {
	m, _, ref, f := preparedBoundary(t)
	before, err := os.ReadFile(filepath.Join(m.dir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	payload := "not-an-argument: ' \" $(touch /no)\nsecond line"
	m.runGuest = func(context.Context, record, string, bool, ...string) ([]byte, error) {
		t.Fatal("warm input called lifecycle/bootstrap execution")
		return nil, nil
	}
	m.command = func(ctx context.Context, name string, args ...string) *exec.Cmd {
		calls++
		joined := strings.Join(args, "\n")
		for _, required := range []string{"StrictHostKeyChecking=yes", "IdentityAgent=none", "ForwardAgent=no", "ControlMaster=no", "HostKeyAlias=bx_current", "'sudo' '-n' '-H' '-u' 'kitty'", "kitty-ready"} {
			if !strings.Contains(joined, required) {
				t.Fatalf("missing SSH/guest boundary %s", required)
			}
		}
		if name != "ssh" || strings.Contains(joined, payload) {
			t.Fatal("input payload escaped stdin or wrong process boundary")
		}
		return exec.CommandContext(ctx, "cat")
	}
	for i := 0; i < 3; i++ {
		out, err := m.ExecPreparedInput(context.Background(), ref, payload, "xdotool", "type", "--file", "-")
		if err != nil || out != payload {
			t.Fatalf("input changed: %q %v", out, err)
		}
	}
	want := []string{}
	for i := 0; i < 3; i++ {
		want = append(want, "GET /sandboxes", "GET /sandboxes/bx_current", "POST /sandboxes/bx_current/sshkey")
	}
	if !reflect.DeepEqual(f.requests, want) || calls != 3 {
		t.Fatalf("warm dispatch count: HTTP=%v SSH=%d", f.requests, calls)
	}
	after, err := os.ReadFile(filepath.Join(m.dir, "state.json"))
	if err != nil || string(before) != string(after) {
		t.Fatal("warm input changed lifecycle state")
	}
	hosts, err := os.ReadFile(filepath.Join(m.dir, "bx_current.known_hosts"))
	if err != nil || string(hosts) != "bx_current ssh-ed25519 YWJj\n" {
		t.Fatal("host key was not pinned before dispatch")
	}
}

func TestWarmInputRejectsChangedIdentityOrProviderBeforeGuestExecution(t *testing.T) {
	for _, mode := range []string{"previous-id", "logical-name", "runtime", "owner", "generation", "checkpoint", "removed", "template", "pending", "missing", "stopped", "unhydrated", "expired", "foreign-access", "foreign-labels", "missing-labels", "wrong-id", "newer-generation", "unrecorded-generation", "registration-restoring"} {
		t.Run(mode, func(t *testing.T) {
			m, r, ref, f := preparedBoundary(t)
			switch mode {
			case "previous-id":
				ref.ID = "bx_old"
			case "logical-name":
				ref.ID = r.Name
			case "runtime":
				ref.Runtime = "lima"
			case "owner":
				ref.OwnerID = "different-owner"
			case "generation":
				ref.Generation--
			case "checkpoint":
				ref.CheckpointID = "older-snapshot"
			case "removed":
				r.Removed = true
			case "template":
				r.Template = true
			case "pending":
				r.Pending = &operation{Kind: "resume"}
			case "missing":
				f.missing = true
			case "stopped":
				f.machine.State = "archived"
			case "unhydrated":
				f.machine.Hydrated = false
			case "expired":
				f.machine.DataExpiredAt = "2026-01-01T00:00:00Z"
			case "foreign-access":
				f.machine.Access = "viewer"
			case "foreign-labels":
				f.machine.Labels = map[string]string{ownerLabel: "other", kittyLabel: r.Name, generationLabel: "2"}
			case "missing-labels":
				f.machine.Labels = nil
			case "wrong-id":
				f.machine.ID = "bx_wrong"
			case "newer-generation":
				f.inventory = []sandbox{{ID: "bx_new", Name: r.Name, Access: "owner", Labels: map[string]string{ownerLabel: m.ownerID, kittyLabel: r.Name, generationLabel: "3"}}}
			case "unrecorded-generation":
				f.inventory = []sandbox{{ID: "bx_unknown", Name: r.Name, Access: "owner"}}
			case "registration-restoring":
				f.registrationError = "sandbox_restoring"
			}
			if err := m.put(r); err != nil {
				t.Fatal(err)
			}
			var commands atomic.Int32
			m.command = func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
				commands.Add(1)
				return exec.CommandContext(ctx, "true")
			}
			if _, err := m.ExecPreparedInput(context.Background(), ref, "", "xdotool", "click", "1"); err == nil {
				t.Fatal("changed prepared identity was accepted")
			}
			if commands.Load() != 0 {
				t.Fatal("rejected input crossed guest boundary")
			}
			if mode == "registration-restoring" && len(f.requests) != 3 {
				t.Fatalf("warm access retried or restored: %v", f.requests)
			}
		})
	}
}

func TestWarmInputAcceptsOnlyExactRecordedRestoreReceipt(t *testing.T) {
	m, r, ref, f := preparedBoundary(t)
	r.Receipt = &creationReceipt{ID: r.RemoteID, Generation: r.Generation, SourceCheckpointID: r.CheckpointID}
	if err := m.put(r); err != nil {
		t.Fatal(err)
	}
	f.machine.Labels = nil
	f.inventory = []sandbox{f.machine}
	m.command = func(ctx context.Context, _ string, _ ...string) *exec.Cmd { return exec.CommandContext(ctx, "true") }
	if _, err := m.ExecPreparedInput(context.Background(), ref, "", "xdotool", "click", "1"); err != nil {
		t.Fatal(err)
	}
	r.Receipt.Generation--
	if err := m.put(r); err != nil {
		t.Fatal(err)
	}
	if _, err := m.ExecPreparedInput(context.Background(), ref, "", "xdotool", "click", "1"); err == nil {
		t.Fatal("stale receipt authorized input")
	}
}

func TestWarmInputValidatesEveryInventoryPage(t *testing.T) {
	m, _, ref, f := preparedBoundary(t)
	f.paginate = true
	f.inventory = []sandbox{{ID: "bx_new", Name: "kitty-mimi", Access: "owner", Labels: map[string]string{ownerLabel: m.ownerID, kittyLabel: "kitty-mimi", generationLabel: "3"}}}
	m.command = func(context.Context, string, ...string) *exec.Cmd {
		t.Fatal("later-page generation conflict dispatched input")
		return nil
	}
	if _, err := m.ExecPreparedInput(context.Background(), ref, "", "xdotool", "click", "1"); err == nil {
		t.Fatal("later-page generation conflict ignored")
	}
}

func TestWarmInputNeverReplaysUnknownDeliveryAndReleasesGlobalLifecycleGate(t *testing.T) {
	m, _, ref, _ := preparedBoundary(t)
	dir := t.TempDir()
	delivered := filepath.Join(dir, "delivered")
	var calls atomic.Int32
	m.command = func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
		calls.Add(1)
		return exec.CommandContext(ctx, "sh", "-c", `printf x >> "$1"; exec sleep 60`, "sh", delivered)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := m.ExecPreparedInput(ctx, ref, "", "xdotool", "click", "1"); done <- err }()
	deadline := time.After(5 * time.Second)
	for {
		if _, err := os.Stat(delivered); err == nil {
			break
		}
		select {
		case <-deadline:
			t.Fatal("input was not dispatched")
		case <-time.After(time.Millisecond):
		}
	}
	lockCtx, release := context.WithTimeout(context.Background(), time.Second)
	defer release()
	if err := m.lockLifecycle(lockCtx); err != nil {
		t.Fatal("running input blocked unrelated runtime lifecycle", err)
	}
	<-m.lifecycle
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("lost acknowledgement reported success")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("canceled input was not reaped")
	}
	data, err := os.ReadFile(delivered)
	if err != nil || string(data) != "x" || calls.Load() != 1 {
		t.Fatal("uncertain input was replayed")
	}
	if _, err := m.ExecPreparedInput(ctx, ref, "", "xdotool", "click", "1"); !errors.Is(err, context.Canceled) {
		t.Fatal("canceled input admission did not fail closed", err)
	}
	if calls.Load() != 1 {
		t.Fatal("canceled context dispatched input")
	}
}
