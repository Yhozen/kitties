package gateway

import (
	"errors"
	"net/http"

	"github.com/madkoding/kitties/internal/llmauth"
)

// accountRoutes are the sign-ins an AI profile can think on instead of a key: start one, follow
// it, paste the address the browser landed on, cancel it, sign out.
func (s *Server) accountRoutes() {
	api := s.auth
	s.mux.Handle("POST /v1/settings/accounts/{kind}/login", api(s.handleAccountLogin))
	s.mux.Handle("DELETE /v1/settings/accounts/{kind}", api(s.handleAccountSignOut))
	s.mux.Handle("GET /v1/settings/logins/{id}", api(s.handleLoginFlow))
	s.mux.Handle("POST /v1/settings/logins/{id}/paste", api(s.handleLoginPaste))
	s.mux.Handle("DELETE /v1/settings/logins/{id}", api(s.handleLoginCancel))
}

func (s *Server) handleAccountLogin(w http.ResponseWriter, r *http.Request) {
	var opts llmauth.StartOptions
	if err := decode(r, &opts); err != nil {
		fail(w, http.StatusBadRequest, err)
		return
	}
	f, err := s.fleet.Accounts().StartContext(r.Context(), r.PathValue("kind"), opts)
	if err != nil {
		// A sign-in that cannot start is the person's to fix (install a program, pick a key).
		fail(w, http.StatusBadRequest, err)
		return
	}
	reply(w, http.StatusOK, f)
}

func (s *Server) handleAccountSignOut(w http.ResponseWriter, r *http.Request) {
	if err := s.fleet.Accounts().SignOut(r.PathValue("kind")); err != nil {
		fail(w, http.StatusInternalServerError, err)
		return
	}
	reply(w, http.StatusOK, s.fleet.Settings())
}

func (s *Server) handleLoginFlow(w http.ResponseWriter, r *http.Request) {
	f, ok := s.fleet.Accounts().Get(r.PathValue("id"))
	if !ok {
		fail(w, http.StatusNotFound, errors.New("no such sign-in: it ended or took too long, start again"))
		return
	}
	reply(w, http.StatusOK, f)
}

func (s *Server) handleLoginPaste(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Code string `json:"code"`
	}
	if err := decode(r, &body); err != nil {
		fail(w, http.StatusBadRequest, err)
		return
	}
	if err := s.fleet.Accounts().Paste(r.PathValue("id"), body.Code); err != nil {
		fail(w, http.StatusBadRequest, err)
		return
	}
	f, _ := s.fleet.Accounts().Get(r.PathValue("id"))
	reply(w, http.StatusOK, f)
}

func (s *Server) handleLoginCancel(w http.ResponseWriter, r *http.Request) {
	s.fleet.Accounts().Cancel(r.PathValue("id"))
	reply(w, http.StatusOK, map[string]bool{"ok": true})
}
