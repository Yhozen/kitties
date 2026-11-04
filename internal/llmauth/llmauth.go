// Package llmauth signs the AI profiles in with an account instead of an API key, the way motita
// does: the person opens a link (and types a code), and the credential is kept on disk for the
// provider client to use and renew.
//
//   - codex:       "Sign in with ChatGPT", PKCE with a callback on localhost:1455 (or the address
//     pasted back); the plan pays, through the ChatGPT backend.
//   - copilot:     GitHub's device flow, then Copilot's session token.
//   - gemini:      the Google login of gcloud (application default credentials).
//   - claude-code: nothing is kept: the claude program holds its own login (`claude auth login`),
//     the only way Anthropic allows a Claude subscription.
//   - qwen:        ended by Qwen on 2026-04-15; a DashScope key is the way in.
package llmauth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/madkoding/kitties/internal/maintenance"
	"github.com/madkoding/kitties/internal/provider"
	"github.com/madkoding/kitties/internal/statefs"
)

// Endpoints are the services' addresses; tests point them at a fake.
type Endpoints struct {
	CodexIssuer  string
	CodexBackend string
	GitHub       string
	GitHubAPI    string
	GoogleToken  string
}

// Production are the real addresses.
var Production = Endpoints{
	CodexIssuer:  "https://auth.openai.com",
	CodexBackend: "https://chatgpt.com/backend-api/codex",
	GitHub:       "https://github.com",
	GitHubAPI:    "https://api.github.com",
	GoogleToken:  "https://oauth2.googleapis.com/token",
}

// Credential is one signed-in account, kept in its own file.
type Credential struct {
	Kind         string    `json:"kind"`
	AccessToken  string    `json:"access_token,omitempty"`
	RefreshToken string    `json:"refresh_token,omitempty"`
	ExpiresAt    time.Time `json:"expires_at,omitempty"`
	// AccountID is the ChatGPT account the Codex requests are billed to.
	AccountID string `json:"account_id,omitempty"`
	// Who is the account for people (an email, a GitHub login).
	Who string `json:"who,omitempty"`
	// BaseURL is where the token is valid (Copilot names its own host).
	BaseURL      string    `json:"base_url,omitempty"`
	ProjectID    string    `json:"project_id,omitempty"`
	ClientID     string    `json:"client_id,omitempty"`
	ClientSecret string    `json:"client_secret,omitempty"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// expirySkew renews a token this long before it expires, not after it failed.
const expirySkew = 2 * time.Minute

func (c Credential) needsRefresh(now time.Time) bool {
	if c.AccessToken == "" {
		return true
	}
	return !c.ExpiresAt.IsZero() && now.Add(expirySkew).After(c.ExpiresAt)
}

// Kinds are the provider kinds an account signs in, in the order the page lists them.
var Kinds = []string{"claude-code", "codex", "copilot", "gemini", "qwen"}

func known(kind string) bool {
	for _, k := range Kinds {
		if k == kind {
			return true
		}
	}
	return false
}

// Store keeps one file per kind, readable by its owner only.
type Store struct {
	dir string
	mu  sync.Mutex
}

// NewStore keeps the credentials in dir.
func NewStore(dir string) *Store { return &Store{dir: dir} }

func (s *Store) path(kind string) string { return filepath.Join(s.dir, kind+".json") }

// Load returns the kind's credential, and whether there is one.
func (s *Store) Load(kind string) (Credential, bool, error) {
	if !known(kind) {
		return Credential{}, false, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := os.ReadFile(s.path(kind))
	if errors.Is(err, os.ErrNotExist) {
		return Credential{}, false, nil
	}
	if err != nil {
		return Credential{}, false, err
	}
	var c Credential
	if err := json.Unmarshal(data, &c); err != nil {
		return Credential{}, false, fmt.Errorf("the %s login is unreadable: %w", kind, err)
	}
	return c, true, nil
}

// Save writes the credential.
func (s *Store) Save(c Credential) error {
	if !known(c.Kind) {
		return fmt.Errorf("%q does not sign in with an account", c.Kind)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := statefs.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path(c.Kind) + ".tmp"
	if err := statefs.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return statefs.Rename(tmp, s.path(c.Kind))
}

// Delete forgets the kind's credential.
func (s *Store) Delete(kind string) error {
	if !known(kind) {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := statefs.Remove(s.path(kind)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// Manager runs the sign-ins and hands the provider clients their credentials.
type Manager struct {
	admission  *maintenance.Gate
	flowWG     sync.WaitGroup
	closed     bool
	store      *Store
	ep         Endpoints
	httpDo     func(*http.Request) (*http.Response, error)
	now        func() time.Time
	listen     func(addr string) (net.Listener, error)
	adcPath    func() string
	findClaude func() (string, error)
	// pollEvery overrides a device flow's interval (tests).
	pollEvery time.Duration

	mu    sync.Mutex
	flows map[string]*flow
	// refreshing makes one renewal at a time per kind: a second caller waits and reads the result.
	refreshing sync.Mutex
}

// New creates the manager over the credentials in dir.
func New(dir string) *Manager {
	return &Manager{
		store: NewStore(dir), ep: Production, httpDo: (&http.Client{Timeout: 30 * time.Second}).Do,
		now: time.Now, listen: func(addr string) (net.Listener, error) { return net.Listen("tcp", addr) },
		adcPath: adcPath, findClaude: provider.FindClaude, flows: map[string]*flow{},
	}
}

// SetAdmission configures the backup barrier before login requests are served.
func (m *Manager) SetAdmission(g *maintenance.Gate) { m.admission = g }

// Close drains credential writes before the durable state service closes.
func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	for _, f := range m.flows {
		f.cancel()
	}
	m.mu.Unlock()
	m.flowWG.Wait()
}

// Account is what the settings page shows of one kind's sign-in.
type Account struct {
	Kind     string `json:"kind"`
	SignedIn bool   `json:"signed_in"`
	Who      string `json:"who,omitempty"`
	// Available is false when the sign-in cannot be used (Qwen's ended).
	Available bool   `json:"available"`
	Note      string `json:"note,omitempty"`
}

// Accounts lists every kind that signs in with an account.
func (m *Manager) Accounts() []Account {
	out := make([]Account, 0, len(Kinds))
	for _, k := range Kinds {
		a := Account{Kind: k, Available: true}
		switch k {
		case "claude-code":
			if p, err := m.findClaude(); err == nil {
				a.SignedIn, a.Who = true, p
				a.Note = "uses the login of the claude program (claude auth login)"
			} else {
				a.Note = ErrNoClaudeText
			}
		case "qwen":
			a.Available, a.Note = false, ErrQwenUnavailable.Error()
		default:
			if c, ok, _ := m.store.Load(k); ok {
				a.SignedIn, a.Who = true, c.Who
			}
		}
		out = append(out, a)
	}
	return out
}

// ErrNoClaudeText says how to get the claude program.
var ErrNoClaudeText = provider.ErrNoClaude.Error()

// ErrQwenUnavailable is Qwen's ended sign-in.
var ErrQwenUnavailable = errors.New("Qwen ended its account sign-in on 2026-04-15: use a DashScope (Alibaba Cloud Model Studio) API key")

// SignedIn reports whether kind has a usable account.
func (m *Manager) SignedIn(kind string) bool {
	for _, a := range m.Accounts() {
		if a.Kind == kind {
			return a.SignedIn
		}
	}
	return false
}

// SignOut forgets kind's account.
func (m *Manager) SignOut(kind string) error { return m.store.Delete(kind) }

// labels name the accounts for people.
var labels = map[string]string{"codex": "ChatGPT", "copilot": "GitHub Copilot", "gemini": "Google", "qwen": "Qwen", "claude-code": "Claude"}

// Source is the provider.LoginSource of kind: the stored credential, renewed when it is about to
// expire, as the headers its service wants.
func (m *Manager) Source(kind string) provider.LoginSource {
	return func(ctx context.Context) (provider.Account, error) {
		c, err := m.fresh(ctx, kind)
		if err != nil {
			return provider.Account{}, err
		}
		bearer := "Bearer " + c.AccessToken
		switch kind {
		case "codex":
			return provider.Account{BaseURL: m.ep.CodexBackend, ChatGPT: true, Headers: map[string]string{
				"Authorization": bearer, "chatgpt-account-id": c.AccountID, "OpenAI-Beta": "responses=experimental",
				"originator": "codex_cli_rs", "Accept": "text/event-stream"}}, nil
		case "copilot":
			return provider.Account{BaseURL: c.BaseURL, Headers: copilotHeaders(c.AccessToken)}, nil
		default:
			h := map[string]string{"Authorization": bearer}
			if c.ProjectID != "" {
				h["x-goog-user-project"] = c.ProjectID
			}
			return provider.Account{Headers: h}, nil
		}
	}
}

// fresh returns kind's credential with a valid access token.
func (m *Manager) fresh(ctx context.Context, kind string) (Credential, error) {
	if m.admission != nil {
		admitted, release, err := m.admission.Enter(ctx)
		if err != nil {
			return Credential{}, err
		}
		defer release()
		ctx = admitted
	}
	c, ok, err := m.store.Load(kind)
	if err != nil {
		return Credential{}, err
	}
	if !ok {
		return Credential{}, fmt.Errorf("%w to %s: sign in from Settings, Models", provider.ErrNotSignedIn, labels[kind])
	}
	if !c.needsRefresh(m.now()) {
		return c, nil
	}
	m.refreshing.Lock()
	defer m.refreshing.Unlock()
	// Another caller may have renewed it while this one waited.
	if c, ok, _ = m.store.Load(kind); ok && !c.needsRefresh(m.now()) {
		return c, nil
	}
	fresh, err := m.refresh(ctx, c)
	if err != nil {
		return Credential{}, fmt.Errorf("the %s sign-in could not be renewed (sign in again from Settings): %w", labels[kind], err)
	}
	fresh.UpdatedAt = m.now()
	return fresh, m.store.Save(fresh)
}

func (m *Manager) refresh(ctx context.Context, c Credential) (Credential, error) {
	if c.RefreshToken == "" {
		return Credential{}, errors.New("there is no refresh token")
	}
	switch c.Kind {
	case "codex":
		return m.codexRefresh(ctx, c)
	case "copilot":
		return m.copilotSession(ctx, c)
	case "gemini":
		return m.googleRefresh(ctx, c)
	}
	return Credential{}, fmt.Errorf("%s does not renew", c.Kind)
}

// --- flows ---------------------------------------------------------------------------------

// Flow is a sign-in in progress, as the page polls it.
type Flow struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	// Method is device (open URL, type Code), browser (open URL; Paste allowed) or instant.
	Method string `json:"method"`
	URL    string `json:"url,omitempty"`
	Code   string `json:"code,omitempty"`
	// Paste is true when the address the browser lands on can be pasted back (a gateway on
	// another machine never sees the localhost callback).
	Paste  bool   `json:"paste,omitempty"`
	Status string `json:"status"` // pending | connected | failed
	Error  string `json:"error,omitempty"`
	Who    string `json:"who,omitempty"`
}

// Flow statuses.
const (
	Pending   = "pending"
	Connected = "connected"
	Failed    = "failed"
)

type flow struct {
	Flow
	started time.Time
	cancel  context.CancelFunc
	paste   chan string
}

// flowTTL is how long a sign-in may wait for the person.
const flowTTL = 15 * time.Minute

// StartOptions are what a sign-in may need from the page.
type StartOptions struct {
	// Project is the Google Cloud project the Gemini requests are billed to.
	Project string `json:"project,omitempty"`
}

// Start begins kind's sign-in. An instant one (Google, Claude) is done or failed on return.
func (m *Manager) Start(kind string, opts StartOptions) (Flow, error) {
	return m.StartContext(context.Background(), kind, opts)
}

func (m *Manager) StartContext(ctx context.Context, kind string, opts StartOptions) (Flow, error) {
	ctx = context.WithoutCancel(ctx)
	if m.admission != nil {
		admitted, release, err := m.admission.Enter(ctx)
		if err != nil {
			return Flow{}, err
		}
		defer release()
		ctx = admitted
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return Flow{}, errors.New("gateway is shutting down")
	}
	m.flowWG.Add(1)
	m.mu.Unlock()
	defer m.flowWG.Done()
	m.prune()
	// A new sign-in replaces the one of the same kind still waiting.
	m.mu.Lock()
	for id, f := range m.flows {
		if f.Kind == kind && f.Status == Pending {
			f.cancel()
			delete(m.flows, id)
		}
	}
	m.mu.Unlock()
	switch kind {
	case "codex":
		return m.startCodex(ctx)
	case "copilot":
		return m.startCopilot(ctx)
	case "gemini":
		return m.startGoogle(ctx, opts)
	case "claude-code":
		p, err := m.findClaude()
		if err != nil {
			return Flow{}, err
		}
		return Flow{ID: randomText(12), Kind: kind, Method: "instant", Status: Connected, Who: p}, nil
	case "qwen":
		return Flow{}, ErrQwenUnavailable
	}
	return Flow{}, fmt.Errorf("%s has no account to sign in with: it takes an API key", kind)
}

// Get returns the flow called id.
func (m *Manager) Get(id string) (Flow, bool) {
	m.prune()
	m.mu.Lock()
	defer m.mu.Unlock()
	f, ok := m.flows[id]
	if !ok {
		return Flow{}, false
	}
	return f.Flow, true
}

// Paste hands a flow the address (or code) the browser landed on.
func (m *Manager) Paste(id, text string) error {
	m.mu.Lock()
	f, ok := m.flows[id]
	m.mu.Unlock()
	if !ok || f.Status != Pending {
		return errors.New("there is no such sign-in waiting: start again")
	}
	if f.paste == nil {
		return errors.New("this sign-in takes no pasted code")
	}
	select {
	case f.paste <- text:
		return nil
	default:
		return errors.New("a code is already being checked")
	}
}

// Cancel stops and forgets a flow.
func (m *Manager) Cancel(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if f, ok := m.flows[id]; ok {
		f.cancel()
		delete(m.flows, id)
	}
}

func (m *Manager) prune() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, f := range m.flows {
		if m.now().Sub(f.started) > flowTTL {
			f.cancel()
			delete(m.flows, id)
		}
	}
}

// track registers a pending flow and runs it; run's credential is saved and the flow ends.
func (m *Manager) track(parent context.Context, f Flow, paste chan string, run func(ctx context.Context) (Credential, error)) Flow {
	ctx, cancel := context.WithTimeout(parent, flowTTL)
	release := func() {}
	if m.admission != nil {
		admitted, done, err := m.admission.Enter(ctx)
		if err != nil {
			cancel()
			f.Status, f.Error = Failed, err.Error()
			return f
		}
		ctx, release = admitted, done
	}
	f.ID, f.Status = randomText(12), Pending
	fl := &flow{Flow: f, started: m.now(), cancel: cancel, paste: paste}
	m.mu.Lock()
	if m.closed {
		cancel()
	}
	m.flows[f.ID] = fl
	m.flowWG.Add(1)
	m.mu.Unlock()
	go func() {
		defer m.flowWG.Done()
		defer release()
		defer cancel()
		c, err := run(ctx)
		if err == nil {
			err = ctx.Err()
		}
		if err == nil {
			c.UpdatedAt = m.now()
			err = m.store.Save(c)
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		if err != nil {
			fl.Status, fl.Error = Failed, err.Error()
			if errors.Is(err, context.Canceled) {
				fl.Error = "the sign-in was cancelled"
			} else if errors.Is(err, context.DeadlineExceeded) {
				fl.Error = "the sign-in took too long: start again"
			}
			return
		}
		fl.Status, fl.Who = Connected, c.Who
	}()
	return fl.Flow
}

// --- HTTP ----------------------------------------------------------------------------------

// errPending and errSlowDown are a device poll that must wait.
var (
	errPending  = errors.New("authorization pending")
	errSlowDown = errors.New("slow down")
)

func pollError(code string) error {
	switch code {
	case "":
		return nil
	case "authorization_pending":
		return errPending
	case "slow_down":
		return errSlowDown
	case "access_denied":
		return errors.New("the sign-in was refused")
	case "expired_token":
		return errors.New("the code expired before it was entered: start again")
	}
	return fmt.Errorf("the service answered %s", code)
}

// call sends req and decodes the JSON answer into dest, whatever the status: an OAuth error
// arrives as JSON with a 400. A failed status the answer does not explain is an error.
func (m *Manager) call(req *http.Request, dest any) error {
	req.Header.Set("Accept", "application/json")
	resp, err := m.httpDo(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	jerr := json.Unmarshal(data, dest)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if jerr != nil {
			return fmt.Errorf("the answer is unreadable: %w", jerr)
		}
		return nil
	}
	if jerr != nil || !json.Valid(data) {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return &statusError{code: resp.StatusCode, body: strings.TrimSpace(string(data))}
}

type statusError struct {
	code int
	body string
}

func (e *statusError) Error() string {
	b := e.body
	if len(b) > 200 {
		b = b[:200] + "…"
	}
	return fmt.Sprintf("HTTP %d: %s", e.code, b)
}

func randomText(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// jwtClaims reads a JWT's claims without checking it: only what the service itself sent.
func jwtClaims(token string) map[string]any {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return nil
	}
	var claims map[string]any
	if json.Unmarshal(raw, &claims) != nil {
		return nil
	}
	return claims
}
