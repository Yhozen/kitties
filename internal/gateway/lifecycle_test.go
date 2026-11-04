package gateway

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/madkoding/kitties/internal/computer"
	"github.com/madkoding/kitties/internal/kitty"
	"github.com/madkoding/kitties/internal/orchestrator"
)

type asyncFleet struct {
	*fakeFleet
	actions []string
	purged  bool
	removed bool
}

func (f *asyncFleet) LifecycleInBackground(ref, action string) (*kitty.Kitty, error) {
	k, err := f.Get(ref)
	if err != nil {
		return nil, err
	}
	f.actions = append(f.actions, action)
	pending := *k
	pending.Status = "stopping"
	if action == "start" {
		pending.Status = kitty.StatusStarting
	}
	kind := action
	if action == "sleep" {
		kind = "stop"
		pending.Availability = "sleeping"
	}
	pending.Operation = kitty.Operation{Kind: kind, StartedAt: time.Now()}
	return &pending, nil
}

func (f *asyncFleet) Recoveries() ([]computer.Recovery, error) {
	if f.purged {
		return nil, nil
	}
	return []computer.Recovery{{Name: "kitty-ana", CheckpointName: "recovery-ana", Removed: f.removed}}, nil
}

func (f *asyncFleet) PurgeRetained(ctx context.Context, ref string) error {
	if ref != "kitty-ana" {
		return orchestrator.ErrNotFound
	}
	if !f.removed {
		return orchestrator.ErrRecoveryBusy
	}
	f.purged = true
	return nil
}

func TestLifecycleHTTPAcceptsPendingWorkAndProtectsRecovery(t *testing.T) {
	f := &asyncFleet{fakeFleet: &fakeFleet{kitties: map[string]*kitty.Kitty{
		"a1": {ID: "a1", Name: "ana", Status: kitty.StatusRunning},
	}}}
	srv := httptest.NewServer(New(f, &fakeChats{}, "tok", "test"))
	defer srv.Close()
	for _, action := range []string{"start", "stop", "sleep"} {
		path := "/v1/kitties/ana/" + action
		code, body, _ := call(t, srv, "POST", path, "tok", nil)
		if code != http.StatusAccepted {
			t.Fatalf("%s: %d %v", action, code, body)
		}
		op := body["kitty"].(map[string]any)["operation"].(map[string]any)
		kind := action
		if action == "sleep" {
			kind = "stop"
		}
		if op["kind"] != kind {
			t.Fatalf("pending operation lost: %v", body)
		}
		if code, _, _ := call(t, srv, "POST", path, "", nil); code != http.StatusUnauthorized {
			t.Fatalf("unauthorized %s: %d", action, code)
		}
	}
	if len(f.actions) != 3 {
		t.Fatalf("unauthorized lifecycle reached runtime: %v", f.actions)
	}
	if code, _, _ := call(t, srv, "POST", "/v1/kitties/missing/sleep", "tok", nil); code != http.StatusNotFound {
		t.Fatalf("unknown computer: %d", code)
	}
	if code, _, _ := call(t, srv, "GET", "/v1/recoveries", "", nil); code != http.StatusUnauthorized {
		t.Fatalf("unauthorized recovery inventory: %d", code)
	}
	purge := "/v1/recoveries/kitty-ana/purge"
	if code, _, _ := call(t, srv, "POST", purge, "", nil); code != http.StatusUnauthorized || f.purged {
		t.Fatalf("unauthorized recovery deletion: %d, %v", code, f.purged)
	}
	if code, _, _ := call(t, srv, "POST", purge, "tok", nil); code != http.StatusConflict || f.purged {
		t.Fatalf("active recovery deletion: %d, %v", code, f.purged)
	}
	delete(f.kitties, "a1")
	f.removed = true
	if code, body, _ := call(t, srv, "GET", "/v1/recoveries", "tok", nil); code != http.StatusOK || len(body["recoveries"].([]any)) != 1 {
		t.Fatalf("removed recovery must remain addressable: %d, %v", code, body)
	}
	if code, _, _ := call(t, srv, "POST", purge, "tok", nil); code != http.StatusOK || !f.purged {
		t.Fatalf("retained recovery deletion: %d, %v", code, f.purged)
	}
}

type leasedScreenshotFleet struct {
	*fakeFleet
	active   atomic.Int32
	acquired atomic.Int32
	observed atomic.Int32
	fail     bool
}

func (f *leasedScreenshotFleet) Acquire(ctx context.Context, ref string) (func(), error) {
	if _, err := f.Get(ref); err != nil {
		return nil, err
	}
	f.acquired.Add(1)
	f.active.Add(1)
	return func() { f.active.Add(-1) }, nil
}
func (f *leasedScreenshotFleet) Screenshot(ctx context.Context, ref string) ([]byte, error) {
	f.observed.Store(f.active.Load())
	if f.fail {
		return nil, errors.New("capture failed")
	}
	return f.fakeFleet.Screenshot(ctx, ref)
}
func TestOnlyExplicitLiveScreenshotPollingKeepsComputerAwake(t *testing.T) {
	f := &leasedScreenshotFleet{fakeFleet: &fakeFleet{kitties: map[string]*kitty.Kitty{"a1": {ID: "a1", Name: "ana", Status: kitty.StatusRunning}}}}
	srv := httptest.NewServer(New(f, &fakeChats{}, "tok", "test"))
	defer srv.Close()
	path := "/v1/kitties/ana/screenshot"
	if code, _, _ := call(t, srv, "GET", path, "tok", nil); code != http.StatusOK || f.acquired.Load() != 0 {
		t.Fatalf("passive screenshot woke the computer: %d, %d", code, f.acquired.Load())
	}
	if code, _, _ := call(t, srv, "GET", path+"?live=1", "tok", nil); code != http.StatusOK || f.observed.Load() != 1 || f.active.Load() != 0 {
		t.Fatalf("viewer lease missing or leaked: %d, observed %d, active %d", code, f.observed.Load(), f.active.Load())
	}
	f.fail = true
	if code, _, _ := call(t, srv, "GET", path+"?live=2", "tok", nil); code != http.StatusInternalServerError || f.active.Load() != 0 {
		t.Fatalf("failed capture leaked viewer lease: %d, %d", code, f.active.Load())
	}
}
