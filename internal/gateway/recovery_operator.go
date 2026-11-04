package gateway

import (
	"context"
	"errors"
	"net"
	"net/http"

	"github.com/madkoding/kitties/internal/orchestrator"
)

type recoveryOperator interface {
	PrepareRecovery(context.Context, string) error
	ReleaseRecovery(string) error
}

func (s *Server) recoveryOperatorRoutes() {
	s.mux.Handle("POST /v1/operator/recovery/prepare", s.auth(s.handleRecoveryOperator))
	s.mux.Handle("POST /v1/operator/recovery/release", s.auth(s.handleRecoveryOperator))
}

func (s *Server) handleRecoveryOperator(w http.ResponseWriter, r *http.Request) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() || r.Header.Get("Authorization") != "Bearer "+s.token {
		fail(w, http.StatusForbidden, errors.New("recovery control requires a local authenticated operator"))
		return
	}
	fleet, ok := s.fleet.(recoveryOperator)
	if !ok {
		fail(w, http.StatusNotImplemented, errors.New("recovery control is unavailable"))
		return
	}
	var body struct {
		OperationID string `json:"operation_id"`
	}
	if err := decode(r, &body); err != nil {
		fail(w, http.StatusBadRequest, err)
		return
	}
	if r.URL.Path == "/v1/operator/recovery/prepare" {
		err = fleet.PrepareRecovery(r.Context(), body.OperationID)
		if err == nil && s.backups != nil {
			err = s.backups.WaitIdle(r.Context())
		}
	} else {
		err = fleet.ReleaseRecovery(body.OperationID)
	}
	if err != nil {
		code := http.StatusServiceUnavailable
		if errors.Is(err, orchestrator.ErrRecoveryConflict) {
			code = http.StatusConflict
		}
		fail(w, code, err)
		return
	}
	reply(w, http.StatusOK, map[string]bool{"ok": true})
}
