package gateway

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/madkoding/kitties/internal/kitty"
)

func TestListenCancelsRequestsAndDrainsHandlersBeforeReturning(t *testing.T) {
	s := New(&fakeFleet{kitties: map[string]*kitty.Kitty{}}, &fakeChats{}, "test-token", "")
	started, canceled, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	s.mux.HandleFunc("GET /shutdown-test", func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		close(canceled)
		<-release
		close(finished)
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	address := make(chan string, 1)
	done := make(chan error, 1)
	go func() {
		done <- s.Listen(ctx, "127.0.0.1:0", func(format string, args ...any) {
			line := fmt.Sprintf(format, args...)
			if _, url, ok := strings.Cut(line, " listening on "); ok {
				address <- url
			}
		})
	}()
	var url string
	select {
	case url = <-address:
	case <-time.After(3 * time.Second):
		t.Fatal("server did not start")
	}
	requestDone := make(chan struct{})
	go func() {
		defer close(requestDone)
		response, err := http.Get(url + "/shutdown-test")
		if err == nil {
			_ = response.Body.Close()
		}
	}()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("request did not start")
	}
	cancel()
	select {
	case <-canceled:
	case <-time.After(3 * time.Second):
		t.Fatal("request context was not canceled")
	}
	select {
	case err := <-done:
		t.Fatalf("Listen returned before handler drained: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("server did not finish")
	}
	select {
	case <-finished:
	default:
		t.Fatal("handler can still write after Listen returned")
	}
	<-requestDone
}
