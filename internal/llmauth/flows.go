package llmauth

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madkoding/kitties/internal/oauth"
)

// --- ChatGPT (codex) -----------------------------------------------------------------------

// The public client of the Codex CLI: its registration only accepts the localhost:1455 callback.
const (
	codexClientID = "app_EMoamEEZ73f0CkXaXp7hrann"
	codexRedirect = "http://localhost:1455/auth/callback"
	codexListen   = "127.0.0.1:1455"
)

type pkce struct{ verifier, challenge, state string }

func newPKCE() pkce {
	v := randomText(32)
	sum := sha256.Sum256([]byte(v))
	return pkce{verifier: v, challenge: base64.RawURLEncoding.EncodeToString(sum[:]), state: randomText(16)}
}

func (m *Manager) startCodex(ctx context.Context) (Flow, error) {
	p := newPKCE()
	q := url.Values{
		"response_type": {"code"}, "client_id": {codexClientID}, "redirect_uri": {codexRedirect},
		"scope": {"openid profile email offline_access"}, "code_challenge": {p.challenge}, "code_challenge_method": {"S256"},
		"id_token_add_organizations": {"true"}, "codex_cli_simplified_flow": {"true"}, "state": {p.state}, "originator": {"codex_cli_rs"},
	}
	link := m.ep.CodexIssuer + "/oauth/authorize?" + q.Encode()
	// The callback is caught here when the browser runs on this machine; a busy port (the Codex
	// CLI signing in) or a gateway elsewhere leaves the pasted address.
	callbacks := make(chan callback, 1)
	ln, err := m.listen(codexListen)
	for try := 0; err != nil && try < 5; try++ {
		// A replaced sign-in may still be closing its callback.
		time.Sleep(100 * time.Millisecond)
		ln, err = m.listen(codexListen)
	}
	var srv *http.Server
	if err == nil {
		srv = serveCallback(ln, p.state, callbacks)
	}
	paste := make(chan string, 1)
	return m.track(ctx, Flow{Kind: "codex", Method: "browser", URL: link, Paste: true}, paste, func(ctx context.Context) (Credential, error) {
		if srv != nil {
			// Shutdown, not Close: the page the browser is being sent finishes first.
			defer func() {
				stop, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				defer cancel()
				_ = srv.Shutdown(stop)
			}()
		}
		code, err := waitCode(ctx, p.state, callbacks, paste)
		if err != nil {
			return Credential{}, err
		}
		form := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {codexRedirect},
			"client_id": {codexClientID}, "code_verifier": {p.verifier}}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.ep.CodexIssuer+"/oauth/token", strings.NewReader(form.Encode()))
		if err != nil {
			return Credential{}, err
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		return m.codexToken(req, Credential{Kind: "codex"})
	}), nil
}

type codexAnswer struct {
	IDToken      string `json:"id_token"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	Error        any    `json:"error"`
	Description  string `json:"error_description"`
}

func (m *Manager) codexRefresh(ctx context.Context, old Credential) (Credential, error) {
	body, _ := json.Marshal(map[string]string{"client_id": codexClientID, "grant_type": "refresh_token",
		"refresh_token": old.RefreshToken, "scope": "openid profile email"})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.ep.CodexIssuer+"/oauth/token", bytes.NewReader(body))
	if err != nil {
		return Credential{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	return m.codexToken(req, old)
}

func (m *Manager) codexToken(req *http.Request, old Credential) (Credential, error) {
	var a codexAnswer
	err := m.call(req, &a)
	if a.Error != nil {
		return Credential{}, fmt.Errorf("ChatGPT refused: %s", strings.TrimSpace(fmt.Sprint(a.Error)+" "+a.Description))
	}
	if err != nil {
		return Credential{}, err
	}
	if a.AccessToken == "" {
		return Credential{}, errors.New("ChatGPT returned no token")
	}
	c := old
	c.AccessToken = a.AccessToken
	if a.RefreshToken != "" {
		c.RefreshToken = a.RefreshToken
	}
	c.ExpiresAt = time.Time{}
	if a.ExpiresIn > 0 {
		c.ExpiresAt = m.now().Add(time.Duration(a.ExpiresIn) * time.Second)
	} else if exp, ok := jwtClaims(a.AccessToken)["exp"].(float64); ok {
		c.ExpiresAt = time.Unix(int64(exp), 0)
	}
	for _, tok := range []string{a.IDToken, a.AccessToken} {
		claims := jwtClaims(tok)
		if auth, ok := claims["https://api.openai.com/auth"].(map[string]any); ok && c.AccountID == "" {
			c.AccountID, _ = auth["chatgpt_account_id"].(string)
		}
		if email, ok := claims["email"].(string); ok && c.Who == "" {
			c.Who = email
		}
	}
	if c.AccountID == "" {
		return Credential{}, errors.New("the ChatGPT login names no account: a ChatGPT plan (Plus, Pro, Team...) is needed")
	}
	return c, nil
}

// callback is what the browser brought back to the callback address.
type callback struct{ code, state, err string }

// serveCallback answers the browser on ln and hands the code of the sign-in with state on.
func serveCallback(ln net.Listener, state string, out chan<- callback) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/callback", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		cb := callback{code: q.Get("code"), state: q.Get("state"), err: strings.TrimSpace(q.Get("error") + " " + q.Get("error_description"))}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		title, msg := "Signed in", "Kitties can think with your ChatGPT plan now. You can close this window."
		switch {
		case cb.state != state:
			w.WriteHeader(http.StatusBadRequest)
			title, msg = "Not this sign-in", "This page belongs to another sign-in. Start again from Kitties."
		case cb.err != "" || cb.code == "":
			w.WriteHeader(http.StatusBadRequest)
			title, msg = "Sign-in refused", cb.err
		}
		_, _ = fmt.Fprintf(w, oauth.CallbackHTML, html.EscapeString(title), html.EscapeString(msg))
		if cb.state == state {
			select {
			case out <- cb:
			default:
			}
		}
	})
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	return srv
}

// waitCode waits for the browser's callback or for the address the person pastes.
func waitCode(ctx context.Context, state string, callbacks <-chan callback, paste <-chan string) (string, error) {
	for {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case cb := <-callbacks:
			if cb.err != "" {
				return "", fmt.Errorf("the sign-in was refused: %s", cb.err)
			}
			return cb.code, nil
		case text := <-paste:
			return ParseCode(text, state)
		}
	}
}

// ParseCode reads the code out of what the person pasted: the whole address the browser landed
// on, its query, "code#state", or the bare code.
func ParseCode(text, state string) (string, error) {
	s := strings.TrimSpace(text)
	var code, got string
	checks := true
	switch {
	case s == "":
		return "", errors.New("nothing was pasted")
	case strings.Contains(s, "://"):
		u, err := url.Parse(s)
		if err != nil {
			return "", errors.New("the pasted address is not valid")
		}
		if e := u.Query().Get("error"); e != "" {
			return "", fmt.Errorf("the sign-in was refused: %s", e)
		}
		code, got = u.Query().Get("code"), u.Query().Get("state")
	case strings.Contains(s, "code="):
		q, err := url.ParseQuery(strings.TrimPrefix(s, "?"))
		if err != nil {
			return "", errors.New("the pasted text is not an address")
		}
		code, got = q.Get("code"), q.Get("state")
	case strings.Contains(s, "#"):
		code, got, _ = strings.Cut(s, "#")
	default:
		code, checks = s, false
	}
	if code == "" {
		return "", errors.New("the pasted text has no code")
	}
	if checks && got != state {
		return "", errors.New("the pasted address belongs to another sign-in: start again")
	}
	return code, nil
}

// --- GitHub Copilot ------------------------------------------------------------------------

// The public client of the Copilot editor plugins.
const copilotClientID = "Iv1.b507a08c87ecfe98"

// copilotEditor is how Copilot's API wants its callers to introduce themselves.
var copilotEditor = map[string]string{
	"Editor-Version": "vscode/1.99.3", "Editor-Plugin-Version": "copilot-chat/0.26.7", "User-Agent": "GitHubCopilotChat/0.26.7",
}

func copilotHeaders(session string) map[string]string {
	h := map[string]string{"Authorization": "Bearer " + session, "Copilot-Integration-Id": "vscode-chat",
		"Openai-Intent": "conversation-panel", "X-Github-Api-Version": "2025-01-21"}
	for k, v := range copilotEditor {
		h[k] = v
	}
	return h
}

func (m *Manager) startCopilot(parent context.Context) (Flow, error) {
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	var dc struct {
		DeviceCode string `json:"device_code"`
		UserCode   string `json:"user_code"`
		VerifyURI  string `json:"verification_uri"`
		Interval   int    `json:"interval"`
	}
	if err := m.postJSON(ctx, m.ep.GitHub+"/login/device/code", map[string]string{"client_id": copilotClientID, "scope": "read:user"}, &dc); err != nil {
		return Flow{}, fmt.Errorf("GitHub did not start the sign-in: %w", err)
	}
	if dc.DeviceCode == "" {
		return Flow{}, errors.New("GitHub returned no code")
	}
	f := Flow{Kind: "copilot", Method: "device", URL: dc.VerifyURI, Code: dc.UserCode}
	return m.track(parent, f, nil, func(ctx context.Context) (Credential, error) {
		token, err := m.pollGitHub(ctx, dc.DeviceCode, dc.Interval)
		if err != nil {
			return Credential{}, err
		}
		c, err := m.copilotSession(ctx, Credential{Kind: "copilot", RefreshToken: token})
		if err != nil {
			return Credential{}, err
		}
		var user struct {
			Login string `json:"login"`
		}
		if req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.ep.GitHubAPI+"/user", nil); err == nil {
			req.Header.Set("Authorization", "token "+token)
			if m.call(req, &user) == nil {
				c.Who = user.Login
			}
		}
		return c, nil
	}), nil
}

// pollGitHub waits until the person typed the code, honouring GitHub's pace.
func (m *Manager) pollGitHub(ctx context.Context, deviceCode string, interval int) (string, error) {
	if interval <= 0 {
		interval = 5
	}
	for {
		var a struct {
			AccessToken string `json:"access_token"`
			Error       string `json:"error"`
		}
		err := m.postJSON(ctx, m.ep.GitHub+"/login/oauth/access_token", map[string]string{"client_id": copilotClientID,
			"device_code": deviceCode, "grant_type": "urn:ietf:params:oauth:grant-type:device_code"}, &a)
		perr := pollError(a.Error)
		switch {
		case perr == nil && err == nil && a.AccessToken != "":
			return a.AccessToken, nil
		case errors.Is(perr, errSlowDown):
			interval += 5
		case errors.Is(perr, errPending):
		case perr != nil:
			return "", perr
		case err != nil:
			return "", err
		default:
			return "", errors.New("GitHub returned no token")
		}
		wait := time.Duration(interval) * time.Second
		if m.pollEvery > 0 {
			wait = m.pollEvery
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(wait):
		}
	}
}

// copilotSession trades the GitHub token (kept as the refresh token) for a Copilot session.
func (m *Manager) copilotSession(ctx context.Context, c Credential) (Credential, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.ep.GitHubAPI+"/copilot_internal/v2/token", nil)
	if err != nil {
		return Credential{}, err
	}
	for k, v := range copilotEditor {
		req.Header.Set(k, v)
	}
	req.Header.Set("Authorization", "token "+c.RefreshToken)
	var a struct {
		Token     string `json:"token"`
		ExpiresAt int64  `json:"expires_at"`
		Endpoints struct {
			API string `json:"api"`
		} `json:"endpoints"`
	}
	if err := m.call(req, &a); err != nil {
		return Credential{}, fmt.Errorf("Copilot refused (is the Copilot subscription active?): %w", err)
	}
	if a.Token == "" {
		return Credential{}, errors.New("Copilot returned no token: is the Copilot subscription active?")
	}
	c.AccessToken = a.Token
	c.ExpiresAt = time.Unix(a.ExpiresAt, 0)
	c.BaseURL = strings.TrimRight(a.Endpoints.API, "/")
	if c.BaseURL == "" {
		c.BaseURL = "https://api.individual.githubcopilot.com"
	}
	return c, nil
}

func (m *Manager) postJSON(ctx context.Context, link string, body any, dest any) error {
	data, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, link, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	return m.call(req, dest)
}

// --- Google (gemini) -----------------------------------------------------------------------

// adcPath is where gcloud keeps the application default credentials.
func adcPath() string {
	if p := os.Getenv("GOOGLE_APPLICATION_CREDENTIALS"); p != "" {
		return p
	}
	if appData := os.Getenv("APPDATA"); appData != "" {
		return filepath.Join(appData, "gcloud", "application_default_credentials.json")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "gcloud", "application_default_credentials.json")
}

// GcloudCommand is what the person runs once to sign gcloud in for Gemini.
const GcloudCommand = "gcloud auth application-default login --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/generative-language.retriever"

// startGoogle takes the Google login gcloud already holds, and checks it with a renewal.
func (m *Manager) startGoogle(parent context.Context, opts StartOptions) (Flow, error) {
	path := m.adcPath()
	data, err := os.ReadFile(path)
	if err != nil {
		return Flow{}, fmt.Errorf("there is no Google login on this computer yet: install gcloud and run `%s`, then try again", GcloudCommand)
	}
	var adc struct {
		Type         string `json:"type"`
		ClientID     string `json:"client_id"`
		ClientSecret string `json:"client_secret"`
		RefreshToken string `json:"refresh_token"`
		Project      string `json:"quota_project_id"`
	}
	if json.Unmarshal(data, &adc) != nil || adc.Type != "authorized_user" || adc.RefreshToken == "" {
		return Flow{}, fmt.Errorf("the gcloud credentials at %s are not a personal Google login: run `%s`", path, GcloudCommand)
	}
	project := strings.TrimSpace(opts.Project)
	if project == "" {
		project = adc.Project
	}
	if project == "" {
		return Flow{}, errors.New("Google bills Gemini to a Cloud project: type its id (Project ID), or run `gcloud auth application-default set-quota-project <id>`")
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	c, err := m.googleRefresh(ctx, Credential{Kind: "gemini", RefreshToken: adc.RefreshToken, ClientID: adc.ClientID,
		ClientSecret: adc.ClientSecret, ProjectID: project, Who: "gcloud, project " + project})
	if err != nil {
		return Flow{}, fmt.Errorf("the gcloud Google login does not work: %w", err)
	}
	c.UpdatedAt = m.now()
	if err := m.store.Save(c); err != nil {
		return Flow{}, err
	}
	return Flow{ID: randomText(12), Kind: "gemini", Method: "instant", Status: Connected, Who: c.Who}, nil
}

func (m *Manager) googleRefresh(ctx context.Context, old Credential) (Credential, error) {
	form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {old.RefreshToken}, "client_id": {old.ClientID}}
	if old.ClientSecret != "" {
		form.Set("client_secret", old.ClientSecret)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.ep.GoogleToken, strings.NewReader(form.Encode()))
	if err != nil {
		return Credential{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	var a struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
		Error        string `json:"error"`
		Description  string `json:"error_description"`
	}
	err = m.call(req, &a)
	if a.Error != "" {
		return Credential{}, fmt.Errorf("Google refused: %s", strings.TrimSpace(a.Error+" "+a.Description))
	}
	if err != nil {
		return Credential{}, err
	}
	if a.AccessToken == "" {
		return Credential{}, errors.New("Google returned no token")
	}
	c := old
	c.AccessToken = a.AccessToken
	if a.RefreshToken != "" {
		c.RefreshToken = a.RefreshToken
	}
	c.ExpiresAt = m.now().Add(time.Hour)
	if a.ExpiresIn > 0 {
		c.ExpiresAt = m.now().Add(time.Duration(a.ExpiresIn) * time.Second)
	}
	return c, nil
}
