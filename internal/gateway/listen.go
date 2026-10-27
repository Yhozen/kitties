package gateway

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/madkoding/kitties/internal/config"
)

// Listen serves on addr until ctx ends (https when a certificate was given). It says where the
// page is, and warns when the token would cross a network in the clear.
func (s *Server) Listen(ctx context.Context, addr string, logf func(string, ...any)) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", addr, err)
	}
	tls := s.tlsCert != ""
	if !config.IsLoopbackAddr(addr) && !tls && !s.trustProxy && !strings.HasPrefix(s.publicURL, "https://") {
		logf("warning: the gateway listens on %s without https; the token and the chats cross the network in the clear. Set gateway.tls_cert and tls_key, or put it behind a TLS proxy (trust_proxy)", addr)
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var requests sync.WaitGroup
	var requestMu sync.Mutex
	closing := false
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestMu.Lock()
		if closing {
			requestMu.Unlock()
			http.Error(w, "gateway is shutting down", http.StatusServiceUnavailable)
			return
		}
		requests.Add(1)
		requestMu.Unlock()
		defer requests.Done()
		s.ServeHTTP(w, r)
	})
	srv := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute, BaseContext: func(net.Listener) context.Context { return ctx }}
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		<-ctx.Done()
		requestMu.Lock()
		closing = true
		requestMu.Unlock()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdown); err != nil {
			_ = srv.Close()
		}
		requests.Wait()
	}()
	scheme := "http"
	if tls {
		scheme = "https"
	}
	where := s.publicURL
	if where == "" {
		where = scheme + "://" + ln.Addr().String()
	}
	what := "gateway"
	if s.web != nil {
		what = "gateway and web interface"
	}
	logf("%s listening on %s", what, where)
	if tls {
		err = srv.ServeTLS(ln, s.tlsCert, s.tlsKey)
	} else {
		err = srv.Serve(ln)
	}
	cancel()
	<-stopped
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
