package gateway

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/madkoding/kitties/internal/backup"
	"github.com/madkoding/kitties/internal/maintenance"
)

type Backups interface {
	Status() backup.Status
	Trigger() (backup.Status, error)
	WaitIdle(context.Context) error
}

func (s *Server) WithBackups(backups Backups) *Server          { s.backups = backups; return s }
func (s *Server) WithAdmission(gate *maintenance.Gate) *Server { s.admission = gate; return s }
func (s *Server) backupRoutes() {
	s.mux.Handle("GET /v1/backups/status", s.auth(s.handleBackupStatus))
	s.mux.Handle("POST /v1/backups", s.auth(s.handleRecoveryBackup))
}
func (s *Server) handleBackupStatus(w http.ResponseWriter, r *http.Request) {
	if s.backups == nil {
		reply(w, http.StatusOK, backup.Status{})
		return
	}
	reply(w, http.StatusOK, s.backups.Status())
}
func (s *Server) handleRecoveryBackup(w http.ResponseWriter, r *http.Request) {
	if s.backups == nil {
		fail(w, http.StatusServiceUnavailable, errors.New("recovery backups are unavailable"))
		return
	}
	status, err := s.backups.Trigger()
	if err != nil {
		fail(w, http.StatusConflict, err)
		return
	}
	reply(w, http.StatusAccepted, status)
}
func maintenanceExempt(r *http.Request) bool {
	path := r.URL.Path
	if r.Method == http.MethodPost && (path == "/v1/operator/recovery/prepare" || path == "/v1/operator/recovery/release") {
		return true
	}
	if r.Method == http.MethodGet {
		for _, suffix := range []string{"/stream", "/rects", "/clipboard", "/screenshot", "/desktop"} {
			if strings.HasPrefix(path, "/v1/kitties/") && strings.HasSuffix(path, suffix) {
				return false
			}
		}
		return true
	}
	return strings.HasPrefix(path, "/v1/settings/logins/") || strings.HasSuffix(path, "/cancel") || strings.HasSuffix(path, "/control") || strings.HasSuffix(path, "/help")
}
