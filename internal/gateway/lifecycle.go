package gateway

import (
	"context"
	"errors"
	"net/http"

	"github.com/madkoding/kitties/internal/computer"
	"github.com/madkoding/kitties/internal/kitty"
)

type lifecycleFleet interface {
	LifecycleInBackground(ref, action string) (*kitty.Kitty, error)
}

type recoveryFleet interface {
	Recoveries() ([]computer.Recovery, error)
	PurgeRetained(ctx context.Context, ref string) error
}

func (s *Server) lifecycleRoutes() {
	s.mux.Handle("POST /v1/kitties/{ref}/sleep", s.auth(s.handleSleepKitty))
	s.mux.Handle("GET /v1/recoveries", s.auth(s.handleRecoveries))
	s.mux.Handle("POST /v1/recoveries/{ref}/purge", s.auth(s.handlePurgeRecovery))
}

func (s *Server) asyncLifecycle(w http.ResponseWriter, r *http.Request, action string) bool {
	fleet, ok := s.fleet.(lifecycleFleet)
	if !ok {
		return false
	}
	k, err := fleet.LifecycleInBackground(r.PathValue("ref"), action)
	if err != nil {
		fail(w, codeFor(err), err)
		return true
	}
	reply(w, http.StatusAccepted, map[string]any{"kitty": k})
	return true
}

func (s *Server) handleSleepKitty(w http.ResponseWriter, r *http.Request) {
	if !s.asyncLifecycle(w, r, "sleep") {
		fail(w, http.StatusNotImplemented, errors.New("this gateway does not support sleeping computers"))
	}
}

func (s *Server) handlePurgeRecovery(w http.ResponseWriter, r *http.Request) {
	fleet, ok := s.fleet.(recoveryFleet)
	if !ok {
		fail(w, http.StatusNotImplemented, errors.New("this gateway does not support recovery deletion"))
		return
	}
	if err := fleet.PurgeRetained(r.Context(), r.PathValue("ref")); err != nil {
		fail(w, codeFor(err), err)
		return
	}
	reply(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleRecoveries(w http.ResponseWriter, r *http.Request) {
	fleet, ok := s.fleet.(recoveryFleet)
	if !ok {
		fail(w, http.StatusNotImplemented, errors.New("this gateway does not support retained recovery"))
		return
	}
	points, err := fleet.Recoveries()
	if err != nil {
		fail(w, codeFor(err), err)
		return
	}
	reply(w, http.StatusOK, map[string]any{"recoveries": points})
}
