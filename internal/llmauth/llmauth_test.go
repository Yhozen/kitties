package llmauth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madkoding/kitties/internal/provider"
)

func jwt(claims map[string]any) string {
	data, _ := json.Marshal(claims)
	return "h." + base64.RawURLEncoding.EncodeToString(data) + ".s"
}

// fakeServices answers as ChatGPT, GitHub, Copilot and Google would.
type fakeServices struct {
	mu        sync.Mutex
	polls     int
	refreshes int
	copilotOK bool
}

func (f *fakeServices) handler(base func() string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /oauth/token", func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		access := jwt(map[string]any{"https://api.openai.com/auth": map[string]any{"chatgpt_account_id": "acc-1"}, "exp": float64(time.Now().Add(time.Hour).Unix())})
		if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			var body map[string]string
			_ = json.Unmarshal(data, &body)
			if body["refresh_token"] != "r1" {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = io.WriteString(w, `{"error":"invalid_grant"}`)
				return
			}
			f.mu.Lock()
			f.refreshes++
			f.mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": access})
			return
		}
		q, _ := url.ParseQuery(string(data))
		switch q.Get("code") {
		case "good":
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": access, "refresh_token": "r1", "expires_in": 3600,
				"id_token": jwt(map[string]any{"email": "cat@example.com"})})
		case "noacct":
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "plain"})
		case "notoken":
			_ = json.NewEncoder(w).Encode(map[string]any{})
		default:
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":"invalid_grant","error_description":"nope"}`)
		}
	})
	mux.HandleFunc("POST /login/device/code", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"device_code":"dc","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","interval":1}`)
	})
	mux.HandleFunc("POST /login/oauth/access_token", func(w http.ResponseWriter, _ *http.Request) {
		f.mu.Lock()
		f.polls++
		n := f.polls
		f.mu.Unlock()
		switch n {
		case 1:
			_, _ = io.WriteString(w, `{"error":"authorization_pending"}`)
		case 2:
			_, _ = io.WriteString(w, `{"error":"slow_down"}`)
		default:
			_, _ = io.WriteString(w, `{"access_token":"gho_x"}`)
		}
	})
	mux.HandleFunc("GET /copilot_internal/v2/token", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		ok := f.copilotOK
		f.mu.Unlock()
		if !ok || r.Header.Get("Authorization") != "token gho_x" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"message":"no copilot"}`)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"token": "cop", "expires_at": time.Now().Add(30 * time.Minute).Unix(),
			"endpoints": map[string]string{"api": base() + "/copilot/"}})
	})
	mux.HandleFunc("GET /user", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"login":"octo"}`)
	})
	mux.HandleFunc("POST /google/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Form.Get("refresh_token") != "rt" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":"invalid_grant","error_description":"expired"}`)
			return
		}
		_, _ = io.WriteString(w, `{"access_token":"ya29","expires_in":3600}`)
	})
	mux.HandleFunc("GET /broken", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, "<html>down</html>")
	})
	return mux
}

type rig struct {
	m    *Manager
	srv  *httptest.Server
	fake *fakeServices
	dir  string
	addr chan string
}

func newRig(t *testing.T) *rig {
	t.Helper()
	r := &rig{fake: &fakeServices{copilotOK: true}, dir: t.TempDir(), addr: make(chan string, 4)}
	r.srv = httptest.NewServer(r.fake.handler(func() string { return r.srv.URL }))
	t.Cleanup(r.srv.Close)
	r.m = New(filepath.Join(r.dir, "accounts"))
	r.m.ep = Endpoints{CodexIssuer: r.srv.URL, CodexBackend: "https://backend", GitHub: r.srv.URL, GitHubAPI: r.srv.URL, GoogleToken: r.srv.URL + "/google/token"}
	r.m.httpDo = r.srv.Client().Do
	r.m.pollEvery = time.Millisecond
	r.m.listen = func(string) (net.Listener, error) {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err == nil {
			r.addr <- ln.Addr().String()
		}
		return ln, err
	}
	r.m.adcPath = func() string { return filepath.Join(r.dir, "adc.json") }
	r.m.findClaude = func() (string, error) { return "", provider.ErrNoClaude }
	return r
}

// wait polls the flow until it is no longer pending.
func (r *rig) wait(t *testing.T, id string) Flow {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		f, ok := r.m.Get(id)
		if !ok {
			t.Fatalf("flow %s vanished", id)
		}
		if f.Status != Pending {
			return f
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("flow %s is still pending", id)
	return Flow{}
}

func stateOf(t *testing.T, link string) string {
	t.Helper()
	u, err := url.Parse(link)
	if err != nil {
		t.Fatal(err)
	}
	return u.Query().Get("state")
}

func TestCodexPaste(t *testing.T) {
	r := newRig(t)
	f, err := r.m.Start("codex", StartOptions{})
	if err != nil || f.Method != "browser" || !f.Paste || !strings.Contains(f.URL, "client_id=app_") || f.Status != Pending {
		t.Fatalf("start = %+v, %v", f, err)
	}
	if err := r.m.Paste(f.ID, codexRedirect+"?code=good&state="+stateOf(t, f.URL)); err != nil {
		t.Fatal(err)
	}
	done := r.wait(t, f.ID)
	if done.Status != Connected || done.Who != "cat@example.com" {
		t.Fatalf("done = %+v", done)
	}
	if err := r.m.Paste(f.ID, "x"); err == nil {
		t.Error("a finished sign-in takes no paste")
	}
	if !r.m.SignedIn("codex") {
		t.Error("codex is signed in")
	}
	acc, err := r.m.Source("codex")(context.Background())
	if err != nil || !acc.ChatGPT || acc.BaseURL != "https://backend" || acc.Headers["chatgpt-account-id"] != "acc-1" || !strings.HasPrefix(acc.Headers["Authorization"], "Bearer ") {
		t.Fatalf("account = %+v, %v", acc, err)
	}
}

func TestCodexCallback(t *testing.T) {
	r := newRig(t)
	f, err := r.m.Start("codex", StartOptions{})
	if err != nil {
		t.Fatal(err)
	}
	addr := <-r.addr
	state := stateOf(t, f.URL)
	resp, err := http.Get("http://" + addr + "/auth/callback?code=good&state=other")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("another sign-in's callback = %d", resp.StatusCode)
	}
	resp, err = http.Get("http://" + addr + "/auth/callback?code=good&state=" + state)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), "Signed in") {
		t.Errorf("callback = %d %s", resp.StatusCode, body)
	}
	if done := r.wait(t, f.ID); done.Status != Connected {
		t.Fatalf("done = %+v", done)
	}
}

func TestCodexRefused(t *testing.T) {
	r := newRig(t)
	for code, want := range map[string]string{"bad": "ChatGPT refused: invalid_grant nope", "noacct": "names no account", "notoken": "no token"} {
		f, err := r.m.Start("codex", StartOptions{})
		if err != nil {
			t.Fatal(err)
		}
		<-r.addr
		_ = r.m.Paste(f.ID, "code="+code+"&state="+stateOf(t, f.URL))
		if done := r.wait(t, f.ID); done.Status != Failed || !strings.Contains(done.Error, want) {
			t.Errorf("%s: done = %+v", code, done)
		}
	}
	// The browser's own refusal.
	f, _ := r.m.Start("codex", StartOptions{})
	addr := <-r.addr
	resp, err := http.Get("http://" + addr + "/auth/callback?error=access_denied&state=" + stateOf(t, f.URL))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if done := r.wait(t, f.ID); done.Status != Failed || !strings.Contains(done.Error, "access_denied") {
		t.Errorf("refused = %+v", done)
	}
}

func TestCodexPortBusy(t *testing.T) {
	r := newRig(t)
	r.m.listen = func(string) (net.Listener, error) { return nil, errors.New("in use") }
	f, err := r.m.Start("codex", StartOptions{})
	if err != nil || !f.Paste {
		t.Fatalf("start = %+v, %v", f, err)
	}
	_ = r.m.Paste(f.ID, "good#"+stateOf(t, f.URL))
	if done := r.wait(t, f.ID); done.Status != Connected {
		t.Fatalf("done = %+v", done)
	}
}

func TestParseCode(t *testing.T) {
	for in, want := range map[string]string{
		"http://localhost:1455/auth/callback?code=c1&state=s": "c1",
		"?code=c2&state=s": "c2",
		"c3#s":             "c3",
		"  c4  ":           "c4",
	} {
		if got, err := ParseCode(in, "s"); err != nil || got != want {
			t.Errorf("ParseCode(%q) = %q, %v", in, got, err)
		}
	}
	for _, in := range []string{"", "http://x/?code=c&state=other", "http://x/?error=denied", "http://x/?state=s", "code=%zz", "c#other", "http://[::1"} {
		if _, err := ParseCode(in, "s"); err == nil {
			t.Errorf("ParseCode(%q) passes", in)
		}
	}
}

func TestCodexRefresh(t *testing.T) {
	r := newRig(t)
	_ = r.m.store.Save(Credential{Kind: "codex", AccessToken: "old", RefreshToken: "r1", AccountID: "acc-1", ExpiresAt: time.Now().Add(-time.Minute)})
	acc, err := r.m.Source("codex")(context.Background())
	if err != nil || acc.Headers["Authorization"] == "Bearer old" {
		t.Fatalf("renewed = %+v, %v", acc, err)
	}
	if c, _, _ := r.m.store.Load("codex"); c.AccessToken == "old" || c.ExpiresAt.Before(time.Now()) {
		t.Errorf("saved = %+v", c)
	}
	_ = r.m.store.Save(Credential{Kind: "codex", AccessToken: "old", RefreshToken: "gone", ExpiresAt: time.Now().Add(-time.Minute)})
	if _, err := r.m.Source("codex")(context.Background()); err == nil || !strings.Contains(err.Error(), "sign in again") {
		t.Errorf("a refused renewal = %v", err)
	}
	_ = r.m.store.Save(Credential{Kind: "codex", ExpiresAt: time.Now().Add(-time.Minute)})
	if _, err := r.m.Source("codex")(context.Background()); err == nil || !strings.Contains(err.Error(), "no refresh token") {
		t.Errorf("no refresh token = %v", err)
	}
}

func TestCopilot(t *testing.T) {
	r := newRig(t)
	f, err := r.m.Start("copilot", StartOptions{})
	if err != nil || f.Method != "device" || f.Code != "ABCD-1234" || f.URL == "" {
		t.Fatalf("start = %+v, %v", f, err)
	}
	if err := r.m.Paste(f.ID, "x"); err == nil {
		t.Error("a device sign-in takes no paste")
	}
	done := r.wait(t, f.ID)
	if done.Status != Connected || done.Who != "octo" {
		t.Fatalf("done = %+v", done)
	}
	acc, err := r.m.Source("copilot")(context.Background())
	if err != nil || acc.BaseURL != r.srv.URL+"/copilot" || acc.Headers["Authorization"] != "Bearer cop" || acc.Headers["Copilot-Integration-Id"] == "" {
		t.Fatalf("account = %+v, %v", acc, err)
	}
	// The session expires and is traded again; a lapsed subscription says so.
	c, _, _ := r.m.store.Load("copilot")
	c.ExpiresAt = time.Now()
	_ = r.m.store.Save(c)
	if _, err := r.m.Source("copilot")(context.Background()); err != nil {
		t.Fatal(err)
	}
	c.ExpiresAt = time.Now()
	_ = r.m.store.Save(c)
	r.fake.mu.Lock()
	r.fake.copilotOK = false
	r.fake.mu.Unlock()
	if _, err := r.m.Source("copilot")(context.Background()); err == nil || !strings.Contains(err.Error(), "Copilot subscription") {
		t.Errorf("lapsed = %v", err)
	}
}

func TestCopilotFails(t *testing.T) {
	r := newRig(t)
	r.fake.copilotOK = false
	f, _ := r.m.Start("copilot", StartOptions{})
	if done := r.wait(t, f.ID); done.Status != Failed || !strings.Contains(done.Error, "Copilot refused") {
		t.Errorf("done = %+v", done)
	}
	r.m.ep.GitHub = r.srv.URL + "/broken"
	if _, err := r.m.Start("copilot", StartOptions{}); err == nil {
		t.Error("a GitHub that does not answer fails")
	}
	for code, want := range map[string]string{"access_denied": "refused", "expired_token": "expired", "weird": "weird"} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasSuffix(r.URL.Path, "/device/code") {
				_, _ = io.WriteString(w, `{"device_code":"dc","user_code":"U"}`)
				return
			}
			_, _ = io.WriteString(w, `{"error":"`+code+`"}`)
		}))
		r.m.ep.GitHub = srv.URL
		f, _ := r.m.Start("copilot", StartOptions{})
		if done := r.wait(t, f.ID); done.Status != Failed || !strings.Contains(done.Error, want) {
			t.Errorf("%s: %+v", code, done)
		}
		srv.Close()
	}
	empty := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, `{}`) }))
	defer empty.Close()
	r.m.ep.GitHub = empty.URL
	if _, err := r.m.Start("copilot", StartOptions{}); err == nil || !strings.Contains(err.Error(), "no code") {
		t.Errorf("no device code = %v", err)
	}
}

func TestCancelAndReplace(t *testing.T) {
	r := newRig(t)
	block := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/device/code") {
			_, _ = io.WriteString(w, `{"device_code":"dc","user_code":"U"}`)
			return
		}
		_, _ = io.WriteString(w, `{"error":"authorization_pending"}`)
	}))
	defer block.Close()
	r.m.ep.GitHub = block.URL
	first, _ := r.m.Start("copilot", StartOptions{})
	second, _ := r.m.Start("copilot", StartOptions{})
	if _, ok := r.m.Get(first.ID); ok {
		t.Error("a new sign-in replaces the waiting one")
	}
	r.m.Cancel(second.ID)
	if _, ok := r.m.Get(second.ID); ok {
		t.Error("a cancelled sign-in is gone")
	}
	third, _ := r.m.Start("copilot", StartOptions{})
	r.m.now = func() time.Time { return time.Now().Add(time.Hour) }
	if _, ok := r.m.Get(third.ID); ok {
		t.Error("an old sign-in is forgotten")
	}
	if err := r.m.Paste("nope", "x"); err == nil {
		t.Error("an unknown sign-in takes no paste")
	}
}

func TestFlowOutcomes(t *testing.T) {
	r := newRig(t)
	paste := make(chan string, 1)
	f := r.m.track(context.Background(), Flow{Kind: "codex", Method: "browser"}, paste, func(ctx context.Context) (Credential, error) {
		<-ctx.Done()
		return Credential{}, context.DeadlineExceeded
	})
	paste <- "busy"
	if err := r.m.Paste(f.ID, "again"); err == nil {
		t.Error("a second paste while one is checked fails")
	}
	r.m.mu.Lock()
	r.m.flows[f.ID].cancel()
	r.m.mu.Unlock()
	if done := r.wait(t, f.ID); !strings.Contains(done.Error, "too long") {
		t.Errorf("deadline = %+v", done)
	}
	g := r.m.track(context.Background(), Flow{Kind: "codex"}, nil, func(context.Context) (Credential, error) { return Credential{}, context.Canceled })
	if done := r.wait(t, g.ID); !strings.Contains(done.Error, "cancelled") {
		t.Errorf("cancelled = %+v", done)
	}
	h := r.m.track(context.Background(), Flow{Kind: "codex"}, nil, func(context.Context) (Credential, error) { return Credential{Kind: "nope"}, nil })
	if done := r.wait(t, h.ID); done.Status != Failed {
		t.Errorf("an unsavable credential fails = %+v", done)
	}
}

func TestGoogle(t *testing.T) {
	r := newRig(t)
	if _, err := r.m.Start("gemini", StartOptions{}); err == nil || !strings.Contains(err.Error(), "gcloud auth application-default login") {
		t.Errorf("no gcloud login = %v", err)
	}
	adc := filepath.Join(r.dir, "adc.json")
	_ = os.WriteFile(adc, []byte(`{"type":"service_account"}`), 0o600)
	if _, err := r.m.Start("gemini", StartOptions{}); err == nil || !strings.Contains(err.Error(), "not a personal") {
		t.Errorf("service account = %v", err)
	}
	_ = os.WriteFile(adc, []byte(`{"type":"authorized_user","client_id":"cid","client_secret":"sec","refresh_token":"rt"}`), 0o600)
	if _, err := r.m.Start("gemini", StartOptions{}); err == nil || !strings.Contains(err.Error(), "Cloud project") {
		t.Errorf("no project = %v", err)
	}
	f, err := r.m.Start("gemini", StartOptions{Project: "my-proj"})
	if err != nil || f.Status != Connected || f.Method != "instant" || !strings.Contains(f.Who, "my-proj") {
		t.Fatalf("start = %+v, %v", f, err)
	}
	acc, err := r.m.Source("gemini")(context.Background())
	if err != nil || acc.Headers["Authorization"] != "Bearer ya29" || acc.Headers["x-goog-user-project"] != "my-proj" || acc.BaseURL != "" {
		t.Fatalf("account = %+v, %v", acc, err)
	}
	_ = os.WriteFile(adc, []byte(`{"type":"authorized_user","client_id":"cid","refresh_token":"old","quota_project_id":"q"}`), 0o600)
	if _, err := r.m.Start("gemini", StartOptions{}); err == nil || !strings.Contains(err.Error(), "Google refused: invalid_grant expired") {
		t.Errorf("an expired gcloud login = %v", err)
	}
	if err := r.m.SignOut("gemini"); err != nil || r.m.SignedIn("gemini") {
		t.Errorf("sign out = %v", err)
	}
	if _, err := r.m.Source("gemini")(context.Background()); !errors.Is(err, provider.ErrNotSignedIn) {
		t.Errorf("signed out = %v", err)
	}
}

func TestClaudeAndOthers(t *testing.T) {
	r := newRig(t)
	if _, err := r.m.Start("claude-code", StartOptions{}); !errors.Is(err, provider.ErrNoClaude) {
		t.Errorf("no claude = %v", err)
	}
	r.m.findClaude = func() (string, error) { return "/bin/claude", nil }
	f, err := r.m.Start("claude-code", StartOptions{})
	if err != nil || f.Status != Connected || f.Who != "/bin/claude" {
		t.Fatalf("claude = %+v, %v", f, err)
	}
	if _, err := r.m.Start("qwen", StartOptions{}); !errors.Is(err, ErrQwenUnavailable) {
		t.Errorf("qwen = %v", err)
	}
	if _, err := r.m.Start("openai", StartOptions{}); err == nil || !strings.Contains(err.Error(), "API key") {
		t.Errorf("openai = %v", err)
	}
	accounts := map[string]Account{}
	for _, a := range r.m.Accounts() {
		accounts[a.Kind] = a
	}
	if !accounts["claude-code"].SignedIn || accounts["qwen"].Available || accounts["codex"].SignedIn || len(accounts) != len(Kinds) {
		t.Errorf("accounts = %+v", accounts)
	}
	if r.m.SignedIn("openai") {
		t.Error("openai has no account")
	}
	r.m.findClaude = func() (string, error) { return "", provider.ErrNoClaude }
	for _, a := range r.m.Accounts() {
		if a.Kind == "claude-code" && (a.SignedIn || a.Note == "") {
			t.Errorf("claude missing = %+v", a)
		}
	}
	if _, err := r.m.refresh(context.Background(), Credential{Kind: "qwen", RefreshToken: "x"}); err == nil {
		t.Error("qwen does not renew")
	}
}

func TestStore(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(filepath.Join(dir, "a"))
	if _, ok, err := s.Load("nope"); ok || err != nil {
		t.Error("an unknown kind has nothing")
	}
	if _, ok, err := s.Load("codex"); ok || err != nil {
		t.Error("nothing is saved yet")
	}
	if err := s.Save(Credential{Kind: "../x"}); err == nil {
		t.Error("an unknown kind is not saved")
	}
	if err := s.Save(Credential{Kind: "codex", AccessToken: "a"}); err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(filepath.Join(dir, "a", "codex.json")); st.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v", st.Mode())
	}
	if c, ok, err := s.Load("codex"); !ok || err != nil || c.AccessToken != "a" {
		t.Errorf("load = %+v %v %v", c, ok, err)
	}
	_ = os.WriteFile(filepath.Join(dir, "a", "codex.json"), []byte("{"), 0o600)
	if _, _, err := s.Load("codex"); err == nil {
		t.Error("a broken file fails")
	}
	m := New(filepath.Join(dir, "a"))
	if _, err := m.Source("codex")(context.Background()); err == nil {
		t.Error("a broken file fails the source")
	}
	if err := s.Delete("codex"); err != nil || s.Delete("codex") != nil || s.Delete("nope") != nil {
		t.Error("delete is idempotent")
	}
	_ = os.MkdirAll(filepath.Join(dir, "a", "copilot.json", "x"), 0o700)
	if err := s.Delete("copilot"); err == nil {
		t.Error("a folder in the way fails the delete")
	}
	if _, _, err := s.Load("copilot"); err == nil {
		t.Error("a folder in the way fails the load")
	}
	blocked := NewStore(filepath.Join(dir, "a", "codex.json.tmp"))
	_ = os.WriteFile(filepath.Join(dir, "a", "codex.json.tmp"), nil, 0o600)
	if err := blocked.Save(Credential{Kind: "codex"}); err == nil {
		t.Error("a file in place of the folder fails the save")
	}
}

func TestCall(t *testing.T) {
	r := newRig(t)
	req, _ := http.NewRequest(http.MethodGet, r.srv.URL+"/broken", nil)
	var v map[string]any
	if err := r.m.call(req, &v); err == nil || err.Error() != "HTTP 502" {
		t.Errorf("an HTML error = %v", err)
	}
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/long" {
			w.WriteHeader(http.StatusTeapot)
			_, _ = io.WriteString(w, `{"message":"`+strings.Repeat("x", 300)+`"}`)
			return
		}
		_, _ = io.WriteString(w, "not json")
	}))
	defer ok.Close()
	req, _ = http.NewRequest(http.MethodGet, ok.URL, nil)
	if err := r.m.call(req, &v); err == nil || !strings.Contains(err.Error(), "unreadable") {
		t.Errorf("unreadable = %v", err)
	}
	req, _ = http.NewRequest(http.MethodGet, ok.URL+"/long", nil)
	if err := r.m.call(req, &v); err == nil || !strings.HasSuffix(err.Error(), "…") {
		t.Errorf("long = %v", err)
	}
	req, _ = http.NewRequest(http.MethodGet, "http://127.0.0.1:1/", nil)
	if err := r.m.call(req, &v); err == nil {
		t.Error("no server fails")
	}
	if jwtClaims("a.b") != nil || jwtClaims("a.!!.c") != nil || jwtClaims("a."+base64.RawURLEncoding.EncodeToString([]byte("x"))+".c") != nil {
		t.Error("broken JWTs have no claims")
	}
}

func TestDefaults(t *testing.T) {
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", "/x/adc.json")
	if adcPath() != "/x/adc.json" {
		t.Error("GOOGLE_APPLICATION_CREDENTIALS wins")
	}
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", "")
	t.Setenv("APPDATA", "/appdata")
	if !strings.HasPrefix(adcPath(), "/appdata") {
		t.Error("APPDATA on Windows")
	}
	t.Setenv("APPDATA", "")
	if !strings.HasSuffix(adcPath(), filepath.Join(".config", "gcloud", "application_default_credentials.json")) {
		t.Error("gcloud's own folder")
	}
	m := New(t.TempDir())
	if m.ep != Production || m.findClaude == nil {
		t.Error("production endpoints")
	}
	ln, err := m.listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ln.Close()
}
