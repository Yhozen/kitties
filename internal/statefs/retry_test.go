package statefs

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestRecoveryUploadRetriesTransientFailureWithoutChangingContent(t *testing.T) {
	for _, failure := range []string{"service unavailable", "rate limit", "lost acknowledgement"} {
		t.Run(failure, func(t *testing.T) {
			service := &stateService{blobs: map[string][]byte{}, commits: map[string]int64{}}
			var mu sync.Mutex
			var paths []string
			var bodies [][]byte
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPut {
					data, err := io.ReadAll(r.Body)
					if err != nil {
						t.Error(err)
						return
					}
					mu.Lock()
					paths = append(paths, r.URL.Path)
					bodies = append(bodies, data)
					count := len(paths)
					mu.Unlock()
					r.Body = io.NopCloser(bytes.NewReader(data))
					if count == 1 {
						switch failure {
						case "lost acknowledgement":
							service.serve(httptest.NewRecorder(), r)
							conn, _, err := w.(http.Hijacker).Hijack()
							if err != nil {
								t.Error(err)
								return
							}
							conn.Close()
						case "rate limit":
							http.Error(w, "try later", http.StatusTooManyRequests)
						default:
							http.Error(w, "temporary storage failure", http.StatusServiceUnavailable)
						}
						return
					}
				}
				service.serve(w, r)
			}))
			defer server.Close()
			source := t.TempDir()
			must(t, os.WriteFile(filepath.Join(source, "settings.json"), []byte("saved settings"), 0600))
			started := time.Now()
			must(t, Import(context.Background(), source, server.URL))
			mu.Lock()
			defer mu.Unlock()
			if len(paths) != 2 || paths[0] != paths[1] || string(bodies[0]) != "saved settings" || !bytes.Equal(bodies[0], bodies[1]) {
				t.Fatalf("immutable upload changed across retry: paths=%v bodies=%q", paths, bodies)
			}
			if time.Since(started) < time.Second {
				t.Fatal("storage retry did not wait out the per-key write window")
			}
			cache := filepath.Join(t.TempDir(), "restored")
			openTestState(t, cache, server.URL)
			got, err := os.ReadFile(filepath.Join(cache, "settings.json"))
			must(t, err)
			if string(got) != "saved settings" {
				t.Fatalf("recovered %q", got)
			}
		})
	}
}

func TestRecoveryUploadDoesNotRetryPermanentRejection(t *testing.T) {
	for _, status := range []int{400, 403, 409, 413} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var attempts atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet {
					io.WriteString(w, `{"revision":0,"files":[]}`)
					return
				}
				if r.Method != http.MethodPut {
					t.Error("import published after rejected upload")
				}
				attempts.Add(1)
				http.Error(w, "rejected", status)
			}))
			defer server.Close()
			source := t.TempDir()
			must(t, os.WriteFile(filepath.Join(source, "settings.json"), []byte("saved settings"), 0600))
			if err := Import(context.Background(), source, server.URL); err == nil || attempts.Load() != 1 {
				t.Fatalf("permanent rejection retried: attempts=%d err=%v", attempts.Load(), err)
			}
		})
	}
}

func TestRecoveryCancellationInterruptsUploadBackoff(t *testing.T) {
	attempted := make(chan struct{})
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			io.WriteString(w, `{"revision":0,"files":[]}`)
			return
		}
		if attempts.Add(1) == 1 {
			close(attempted)
		}
		http.Error(w, "temporary", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	source := t.TempDir()
	must(t, os.WriteFile(filepath.Join(source, "settings.json"), []byte("saved settings"), 0600))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- Import(ctx, source, server.URL) }()
	<-attempted
	time.AfterFunc(100*time.Millisecond, cancel)
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) || attempts.Load() != 1 {
			t.Fatalf("canceled recovery retried or succeeded: attempts=%d err=%v", attempts.Load(), err)
		}
	case <-time.After(900 * time.Millisecond):
		t.Fatal("cancellation waited for the upload backoff")
	}
}

func TestCommitDoesNotRetryPermanentRejectionOrInvalidRevision(t *testing.T) {
	for _, failure := range []struct {
		status int
		body   string
	}{
		{403, "forbidden"}, {409, "stale epoch"}, {200, `{"revision":99}`}, {200, `not JSON`},
	} {
		t.Run(failure.body, func(t *testing.T) {
			var attempts atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				attempts.Add(1)
				w.WriteHeader(failure.status)
				io.WriteString(w, failure.body)
			}))
			defer server.Close()
			store, err := newStore(t.TempDir(), server.URL)
			must(t, err)
			err = store.commit(context.Background(), []Mutation{{Op: "delete", Path: "removed"}})
			if err == nil || attempts.Load() != 1 || store.revision != 0 {
				t.Fatalf("permanent commit rejection retried or advanced: attempts=%d revision=%d err=%v", attempts.Load(), store.revision, err)
			}
		})
	}
}

func TestTransientCommitRetriesKeepOneReceiptAndNeverAdvanceOnExhaustion(t *testing.T) {
	for _, succeeds := range []bool{true, false} {
		t.Run(fmt.Sprintf("acknowledged=%v", succeeds), func(t *testing.T) {
			var mu sync.Mutex
			var requests [][]byte
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, err := io.ReadAll(r.Body)
				if err != nil {
					t.Error(err)
					return
				}
				mu.Lock()
				requests = append(requests, body)
				count := len(requests)
				mu.Unlock()
				if succeeds && count == 3 {
					io.WriteString(w, `{"revision":1}`)
					return
				}
				status := http.StatusServiceUnavailable
				if count == 2 {
					status = http.StatusTooManyRequests
				}
				http.Error(w, "temporary", status)
			}))
			defer server.Close()
			store, err := newStore(t.TempDir(), server.URL)
			must(t, err)
			start := time.Now()
			err = store.commit(context.Background(), []Mutation{{Op: "delete", Path: "removed"}})
			if (err == nil) != succeeds || time.Since(start) < 3*time.Second {
				t.Fatalf("bounded commit backoff outcome: success=%v err=%v elapsed=%s", succeeds, err, time.Since(start))
			}
			mu.Lock()
			defer mu.Unlock()
			if len(requests) != 3 || !bytes.Equal(requests[0], requests[1]) || !bytes.Equal(requests[0], requests[2]) {
				t.Fatalf("retry changed receipt or exceeded its bound: %q", requests)
			}
			wantRevision := int64(0)
			if succeeds {
				wantRevision = 1
			}
			if store.revision != wantRevision {
				t.Fatalf("revision=%d, want%d", store.revision, wantRevision)
			}
		})
	}
}
