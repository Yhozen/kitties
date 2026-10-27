package boat

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func apiBoundary(t *testing.T, handler http.HandlerFunc) *Manager {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	m, err := New(Options{StateDir: t.TempDir(), APIKey: "fixture-api-secret", BaseURL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Close() })
	m.poll = time.Millisecond
	return m
}

func TestProviderDiagnosticsRedactCredentialsAndKeepErrorIdentity(t *testing.T) {
	m := apiBoundary(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(map[string]string{"code": "quota", "requestId": "request-fixture", "message": "invalid credential fixture-api-secret"})
	})
	_, err := m.request(context.Background(), "GET", "/sandboxes", nil, nil)
	var failure *APIError
	if !errors.As(err, &failure) || !isStatus(err, 429) || !isCode(err, "quota") || failure.RequestID != "request-fixture" {
		t.Fatalf("lost provider failure identity: %v", err)
	}
	if strings.Contains(err.Error(), "fixture-api-secret") {
		t.Fatal("provider diagnostic leaked a credential")
	}
}

func TestProviderRedirectNeverForwardsGatewayCredential(t *testing.T) {
	var reached atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached.Store(true); w.WriteHeader(200) }))
	defer target.Close()
	m := apiBoundary(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	})
	_, err := m.request(context.Background(), "GET", "/sandboxes", nil, nil)
	if !isStatus(err, http.StatusTemporaryRedirect) || reached.Load() {
		t.Fatalf("credential-bearing redirect followed: %v", err)
	}
	if !strings.Contains(err.Error(), "Temporary Redirect") {
		t.Fatalf("non-JSON failure lost status: %v", err)
	}
}

func TestInventoryFiltersForeignMachinesAcrossPagesAndRejectsCursorLoops(t *testing.T) {
	var m *Manager
	var loop atomic.Bool
	m = apiBoundary(t, func(w http.ResponseWriter, r *http.Request) {
		cursor := r.URL.Query().Get("cursor")
		id := "bx_first"
		more := true
		if cursor != "" {
			id = "bx_second"
			more = loop.Load()
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"sandboxes": []sandbox{{ID: id, Labels: map[string]string{ownerLabel: m.ownerID}}, {ID: "bx_foreign", Labels: map[string]string{ownerLabel: "someone-else"}}}, "pageInfo": map[string]any{"hasMore": more, "nextCursor": "page-two"}})
	})
	all, err := m.inventory(context.Background())
	if err != nil || len(all) != 2 || !reflect.DeepEqual([]string{all[0].ID, all[1].ID}, []string{"bx_first", "bx_second"}) {
		t.Fatalf("inventory ownership or pagination failed: %+v %v", all, err)
	}
	loop.Store(true)
	if _, err = m.inventory(context.Background()); err == nil || !strings.Contains(err.Error(), "did not advance") {
		t.Fatalf("inventory cursor loop accepted: %v", err)
	}
}

func TestReadinessRejectsWrongIdentityAndTerminalStates(t *testing.T) {
	for _, state := range []string{"different-id", "foreign-owner", "error", "cancelled", "archived", "malformed"} {
		t.Run(state, func(t *testing.T) {
			var m *Manager
			r := record{Name: "kitty-mimi", RemoteID: "bx_owned", Generation: 1}
			m = apiBoundary(t, func(w http.ResponseWriter, req *http.Request) {
				if state == "malformed" {
					_, _ = w.Write([]byte("broken json"))
					return
				}
				s := sandbox{ID: r.RemoteID, Access: "owner", State: state, Labels: map[string]string{ownerLabel: m.ownerID, kittyLabel: r.Name, generationLabel: "1"}}
				if state == "different-id" {
					s.ID = "bx_other"
				}
				if state == "foreign-owner" {
					s.Access = "read"
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"sandbox": s})
			})
			if _, err := m.waitReady(context.Background(), r); err == nil {
				t.Fatal("unsafe or terminal computer became ready")
			}
		})
	}
}

func TestReadinessWaitsForHydrationAndRespondsToCancellation(t *testing.T) {
	var m *Manager
	var hydrated atomic.Bool
	requested := make(chan struct{}, 1)
	r := record{Name: "kitty-mimi", RemoteID: "bx_owned", Generation: 1}
	m = apiBoundary(t, func(w http.ResponseWriter, req *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"sandbox": sandbox{ID: r.RemoteID, Access: "owner", State: "ready", Hydrated: hydrated.Load(), Labels: map[string]string{ownerLabel: m.ownerID, kittyLabel: r.Name, generationLabel: "1"}}})
		select {
		case requested <- struct{}{}:
		default:
		}
	})
	m.poll = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() { _, err := m.waitReady(ctx, r); result <- err }()
	<-requested
	cancel()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("hydration wait ignored cancellation: %v", err)
	}
	hydrated.Store(true)
	if _, err := m.waitReady(context.Background(), r); err != nil {
		t.Fatalf("hydrated computer rejected: %v", err)
	}
}
