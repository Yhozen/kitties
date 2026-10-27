package main

import (
	"context"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/madkoding/kitties/internal/agenda"
	"github.com/madkoding/kitties/internal/config"
	"github.com/madkoding/kitties/internal/orchestrator"
)

func TestGatewayToken(t *testing.T) {
	dir := t.TempDir()
	cfg := config.Defaults()
	cfg.DataDir = dir
	// Nothing yet: a new token, not kept until the gateway writes it.
	tok, path, fresh := gatewayToken(cfg)
	if !fresh || len(tok) != 32 || path != filepath.Join(dir, "gateway.token") {
		t.Errorf("first run: %q %q %v", tok, path, fresh)
	}
	// A previous run's token is reused, so a restart signs nobody out.
	_ = os.WriteFile(path, []byte("0123456789abcdef0123456789abcdef\n"), 0o600)
	if got, _, fresh := gatewayToken(cfg); fresh || got != "0123456789abcdef0123456789abcdef" {
		t.Errorf("reuse: %q %v", got, fresh)
	}
	// A short or damaged file is not a token.
	_ = os.WriteFile(path, []byte("abc\n"), 0o600)
	if _, _, fresh := gatewayToken(cfg); !fresh {
		t.Error("a damaged file is replaced")
	}
	// The configured token wins.
	cfg.Gateway.Token = "from-the-config"
	if got, _, fresh := gatewayToken(cfg); fresh || got != "from-the-config" {
		t.Errorf("configured: %q %v", got, fresh)
	}
}

func TestTokenCommand(t *testing.T) {
	dir := t.TempDir()
	cfg := filepath.Join(dir, "kitties.yaml")
	_ = os.WriteFile(cfg, []byte("data_dir: "+dir+"\n"), 0o600)
	if code, _, errOut := exec(t, "", "-config", cfg, "token"); code != 1 || !strings.Contains(errOut, "no token yet") {
		t.Errorf("before the gateway ran: %d %s", code, errOut)
	}
	_ = os.WriteFile(filepath.Join(dir, "gateway.token"), []byte("0123456789abcdef0123456789abcdef\n"), 0o600)
	if code, out, _ := exec(t, "", "-config", cfg, "token"); code != 0 || strings.TrimSpace(out) != "0123456789abcdef0123456789abcdef" {
		t.Errorf("token = %d %q", code, out)
	}
	t.Setenv("KITTIES_TOKEN", "from-the-environment-12345")
	if code, out, _ := exec(t, "", "-config", cfg, "token"); code != 0 || strings.TrimSpace(out) != "from-the-environment-12345" {
		t.Errorf("the environment's token = %d %q", code, out)
	}
}

// serve starts `kitties gateway` with args and returns its address once it listens.
func serve(t *testing.T, args ...string) (addr string, out *syncBuffer, errOut *syncBuffer, stop func() int) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	notifyContext = func() (context.Context, context.CancelFunc) { return ctx, func() {} }
	out, errOut = &syncBuffer{}, &syncBuffer{}
	done := make(chan int, 1)
	go func() { done <- run(args, strings.NewReader(""), out, errOut) }()
	deadline := time.Now().Add(10 * time.Second)
	for !strings.Contains(out.String(), "listening on") && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	line := out.String()
	i := strings.Index(line, "listening on ")
	if i < 0 {
		cancel()
		<-done
		t.Fatalf("the gateway never listened: %s %s", out.String(), errOut.String())
	}
	addr = strings.TrimSpace(strings.SplitN(line[i+len("listening on "):], "\n", 2)[0])
	addr = strings.TrimPrefix(addr, "http://")
	return addr, out, errOut, func() int { cancel(); return <-done }
}

func get(t *testing.T, url string) (int, string, http.Header) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body), resp.Header
}

func TestGatewayServesTheWebInterface(t *testing.T) {
	withRuntime(t, false)
	old := webFS
	t.Cleanup(func() { webFS = old })
	webFS = func() (fs.FS, bool) {
		return fstest.MapFS{"index.html": {Data: []byte("<!doctype html><title>Kitties web</title>")}}, true
	}
	cfg := writeConfig(t, "http://127.0.0.1:1")
	addr, _, _, stop := serve(t, "-config", cfg, "gateway")
	code, body, hdr := get(t, "http://"+addr+"/")
	if code != 200 || !strings.Contains(body, "Kitties web") || hdr.Get("Content-Security-Policy") == "" {
		t.Errorf("the embedded interface = %d %q", code, body)
	}
	// On this machine alone the page may take the token; the session says so.
	if code, body, _ := get(t, "http://"+addr+"/v1/session"); code != 200 || !strings.Contains(body, `"local_token":true`) {
		t.Errorf("session = %d %s", code, body)
	}
	if c := stop(); c != 0 {
		t.Errorf("exit %d", c)
	}

	// Without a build inside, the gateway says so and serves its built-in page. A connection of
	// the file that signs in but has no account is said too.
	webFS = func() (fs.FS, bool) { return nil, false }
	f, err := os.OpenFile(cfg, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString("connectors:\n  music:\n    kind: spotify\n  code:\n    kind: github\n    token: ghp_x\n")
	_ = f.Close()
	addr, _, errOut, stop := serve(t, "-config", cfg, "gateway")
	if code, body, _ := get(t, "http://"+addr+"/"); code != 200 || !strings.Contains(body, "<title>Kitties</title>") {
		t.Errorf("built-in page = %d", code)
	}
	stop()
	if !strings.Contains(errOut.String(), "no web interface inside") {
		t.Errorf("the missing build is reported: %s", errOut.String())
	}
	if !strings.Contains(errOut.String(), "the connection music (Spotify) has no account yet") || strings.Contains(errOut.String(), "connection code") {
		t.Errorf("the connection without an account is reported, and only it: %s", errOut.String())
	}
}

func TestGatewayAsAServer(t *testing.T) {
	withRuntime(t, false)
	cfg := writeConfig(t, "http://127.0.0.1:1")
	// -listen overrides the file, the environment sets the public address and the token, and a
	// server with a public address never hands its token out.
	t.Setenv("KITTIES_PUBLIC_URL", "https://kitties.example.com")
	t.Setenv("KITTIES_TOKEN", "server-token-0123456789")
	addr, out, _, stop := serve(t, "-config", cfg, "gateway", "-listen", "127.0.0.1:0")
	if !strings.Contains(out.String(), "listening on https://kitties.example.com") || strings.Contains(out.String(), "server-token-0123456789") {
		t.Errorf("output: %s", out.String())
	}
	_ = addr
	stop()
	// The listen flag is validated like the file.
	if code, _, errOut := exec(t, "", "-config", cfg, "gateway", "-listen", ""); code == 2 {
		t.Errorf("an empty -listen keeps the file's: %d %s", code, errOut)
	}
	if code, _, _ := exec(t, "", "-config", cfg, "gateway", "-bogus"); code != 1 {
		t.Errorf("a bad gateway flag: %d", code)
	}
}

func TestGatewayWithoutAConfigurationFile(t *testing.T) {
	withRuntime(t, false)
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	_ = os.MkdirAll(home, 0o700)
	t.Setenv("HOME", home)
	t.Setenv("KITTIES_CONFIG", "")
	t.Setenv("KITTIES_DATA_DIR", filepath.Join(dir, "data"))
	t.Setenv("KITTIES_LISTEN", "127.0.0.1:0")
	wd, _ := os.Getwd()
	_ = os.Chdir(dir)
	t.Cleanup(func() { _ = os.Chdir(wd) })
	addr, _, errOut, stop := serve(t, "gateway")
	if code, body, _ := get(t, "http://"+addr+"/v1/health"); code != 200 || !strings.Contains(body, `"ok"`) {
		t.Errorf("an empty gateway answers: %d %s", code, body)
	}
	stop()
	if !strings.Contains(errOut.String(), "no configuration file") || !strings.Contains(errOut.String(), "starting empty") {
		t.Errorf("the empty start is announced: %s", errOut.String())
	}
	if _, err := os.Stat(filepath.Join(dir, "data", "gateway.token")); err != nil {
		t.Errorf("the token is kept: %v", err)
	}
	// A file that was named but is missing is still an error, and so is any other command.
	if code, _, errOut := exec(t, "", "-config", filepath.Join(dir, "nope.yaml"), "gateway"); code != 1 || !strings.Contains(errOut, "kitties init") {
		t.Errorf("a named file must exist: %d %s", code, errOut)
	}
	if code, _, errOut := exec(t, "", "ls"); code != 1 || !strings.Contains(errOut, "kitties init") {
		t.Errorf("ls needs a file: %d %s", code, errOut)
	}
	// A bad value in the environment is refused before anything starts.
	t.Setenv("KITTIES_PUBLIC_URL", "nope")
	if code, _, errOut := exec(t, "", "gateway"); code != 1 || !strings.Contains(errOut, "public_url") {
		t.Errorf("a bad environment: %d %s", code, errOut)
	}
}

func TestGatewayGoalsAndWatchdog(t *testing.T) {
	withRuntime(t, true)
	cfg := writeConfig(t, chatServer(t, "ok"))
	text := mustRead(t, cfg)
	text = strings.Replace(text, "kitties:\n  - name: mimi\n  - name: team\n    replicas: 2\n    desktop: false\n",
		"kitties:\n  - name: mimi\n    backup: team-1\n    limits:\n      retries: 2\n    goals:\n      - title: Inbox\n        text: Look at the inbox\n        every: '@hourly'\n  - name: team\n    replicas: 2\n    desktop: false\n    goals:\n      - title: Standup\n        every: '0 9 * * 1-5'\n", 1)
	_ = os.WriteFile(cfg, []byte(text), 0o600)
	old := watchEvery
	watchEvery = 20 * time.Millisecond
	t.Cleanup(func() { watchEvery = old })
	addr, _, _, stop := serve(t, "-config", cfg, "gateway")
	tokenConfig, err := config.Load(cfg)
	if err != nil {
		t.Fatal(err)
	}
	tok := strings.TrimSpace(mustRead(t, filepath.Join(tokenConfig.DataDirOr(), "gateway.token")))
	req, _ := http.NewRequest("GET", "http://"+addr+"/v1/goals", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := http.Get("http://" + addr + "/v1/goals?token=" + tok)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	// mimi's goal and one per team replica.
	if resp.StatusCode != 200 || strings.Count(string(body), `"title":"Inbox"`) != 1 || strings.Count(string(body), `"title":"Standup"`) != 2 || !strings.Contains(string(body), `"from_file":true`) {
		t.Errorf("goals = %d %s", resp.StatusCode, body)
	}
	resp, _ = http.Get("http://" + addr + "/v1/kitties/mimi?token=" + tok)
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(body), `"backup":"team-1"`) || !strings.Contains(string(body), `"retries":2`) {
		t.Errorf("mimi = %s", body)
	}
	time.Sleep(80 * time.Millisecond) // the watchdog looks a few times and finds nothing wrong
	stop()
	// A kitty of the file that was never created (no bootstrap yet) has its goals skipped.
	loaded, err := config.Load(cfg)
	if err != nil {
		t.Fatal(err)
	}
	loaded.DataDir = t.TempDir()
	fleet, err := orchestrator.New(loaded)
	if err != nil {
		t.Fatal(err)
	}
	ag, _ := agenda.Open(t.TempDir(), nil)
	a := &app{cfg: loaded, fleet: fleet, agenda: ag}
	if err := a.syncGoals(); err != nil || len(ag.Goals("")) != 0 {
		t.Errorf("sync without kitties: %v %d", err, len(ag.Goals("")))
	}
}

func TestGatewayServesApprovalsMemoryAndNotifications(t *testing.T) {
	withRuntime(t, false)
	cfg := writeConfig(t, "http://127.0.0.1:1")
	addr, _, _, stop := serve(t, "-config", cfg, "gateway")
	tokenConfig, err := config.Load(cfg)
	if err != nil {
		t.Fatal(err)
	}
	tok := strings.TrimSpace(mustRead(t, filepath.Join(tokenConfig.DataDirOr(), "gateway.token")))
	get := func(path string) (int, string) {
		resp, err := http.Get("http://" + addr + path + "?token=" + tok)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body)
	}
	if code, body := get("/v1/approvals"); code != 200 || !strings.Contains(body, `"approvals":[]`) {
		t.Errorf("approvals = %d %s", code, body)
	}
	if code, body := get("/v1/approvals/rules"); code != 200 || !strings.Contains(body, `"rules":[]`) {
		t.Errorf("rules = %d %s", code, body)
	}
	if code, body := get("/v1/kitties/mimi/memory"); code != 200 || !strings.Contains(body, `"demand":3`) || !strings.Contains(body, "balanced") {
		t.Errorf("memory = %d %s", code, body)
	}
	if code, body := get("/v1/settings"); code != 200 || !strings.Contains(body, `"notify":{"connector":"","on":[]}`) || !strings.Contains(body, `"notify_events"`) {
		t.Errorf("settings = %d %s", code, body)
	}
	// The daily summary is built from the journal, the approvals and the budget, and sent through
	// the channel: a webhook cannot carry a notification, so the failure comes back as the answer.
	put := func(method, path, body string) (int, string) {
		req, _ := http.NewRequest(method, "http://"+addr+path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+tok)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		data, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(data)
	}
	if code, body := put("POST", "/v1/settings/notify/digest", ""); code != 200 || !strings.Contains(body, "choose a notification channel") {
		t.Errorf("digest without a channel = %d %s", code, body)
	}
	if code, body := put("PUT", "/v1/settings/connectors/hook", `{"kind":"webhook","url":"http://127.0.0.1:1/x"}`); code != 200 {
		t.Fatalf("connector = %d %s", code, body)
	}
	if code, body := put("PUT", "/v1/settings/notify", `{"connector":"hook","digest":"08:30"}`); code != 200 || !strings.Contains(body, `"digest":"08:30"`) {
		t.Fatalf("notify = %d %s", code, body)
	}
	if code, body := put("POST", "/v1/settings/notify/digest", ""); code != 200 || !strings.Contains(body, "cannot carry a notification") {
		t.Errorf("digest = %d %s", code, body)
	}
	stop()
}
