package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestExampleParses(t *testing.T) {
	cfg, err := Load(filepath.Join("..", "..", "configs", "kitties.example.yaml"))
	if err != nil {
		t.Fatalf("the shipped example must load: %v", err)
	}
	if len(cfg.Providers) != 5 || cfg.Providers["plan"].Auth != "login" || cfg.DefaultProvider != "strong" || len(cfg.Kitties) != 3 || cfg.Kitties[1].Replicas != 3 {
		t.Errorf("config = %+v", cfg)
	}
	if cfg.ProviderFor(cfg.Kitties[0]) != "strong" || cfg.ProviderFor(Kitty{}) != "strong" {
		t.Error("ProviderFor")
	}
	if d := cfg.Kitties[2].Desktop; d == nil || *d {
		t.Error("desktop: false is kept")
	}
	o := cfg.Providers["fast"].Options()
	if o.Kind != "openai" || o.Temperature == nil || *o.Temperature != 0.7 {
		t.Errorf("Options = %+v", o)
	}
	t.Setenv("MY_KEY", "secret")
	if (Provider{APIKeyEnv: "MY_KEY"}).Options().APIKey != "secret" {
		t.Error("api_key_env is read")
	}
	if _, err := Load(filepath.Join(t.TempDir(), "none.yaml")); err == nil {
		t.Error("a missing file fails")
	}
	if _, err := Parse([]byte("a: [\n")); err == nil {
		t.Error("bad YAML fails")
	}
	if _, err := Parse([]byte("nope: 1\n")); err == nil {
		t.Error("an unknown key fails")
	}
}

func TestValidation(t *testing.T) {
	base := "providers:\n  p:\n    kind: ollama\n"
	cases := []struct{ text, want string }{
		{"providers:\n  Bad Name:\n    kind: ollama\n", "profile name"},
		{"providers:\n  p:\n    kind: nope\n", "is not one of"},
		{"providers:\n  p:\n    kind: openai\n    api_key: k\n    base_url: http://example.com/v1\n", "clear text"},
		{base + "default_provider: q\n", "not a configured profile"},
		{base + "kitties:\n  - name: Bad\n", "not a valid name"},
		{base + "kitties:\n  - name: a\n  - name: a\n", "used twice"},
		{base + "kitties:\n  - name: a\n    provider: q\n", "not a configured profile"},
		{base + "  q:\n    kind: ollama\nkitties:\n  - name: a\n", "no default_provider"},
		{base + "kitties:\n  - name: a\n    replicas: 1000\n", "between 0 and 999"},
		{base + "kitties:\n  - name: a\n    avatar:\n      breed: lion\n", "avatar.breed"},
		{"providers:\n  p:\n    kind: ollama\n    tools: magic\n", "not native or text"},
		{"providers:\n  p:\n    kind: codex\n    auth: oauth\n", "is not login"},
		{"providers:\n  p:\n    kind: openai\n    auth: login\n", "takes an API key"},
		{base + "kitties:\n  - name: a\n    connectors: [x]\n", "not a configured connector"},
		{base + "containers:\n  runtime: lxc\n", "not auto, docker, podman, lima or boat"},
		{base + "containers:\n  image: ''\n", "image cannot be empty"},
		{base + "containers:\n  cpus: -1\n", "cannot be negative"},
		{base + "gateway:\n  listen: ''\n", "listen cannot be empty"},
		{base + "connectors:\n  Bad:\n    kind: webhook\n", "connector name"},
		{base + "connectors:\n  w:\n    kind: webhook\n", "needs url"},
		{base + "connectors:\n  w:\n    kind: telegram\n", "needs bot token"},
		{base + "connectors:\n  w:\n    kind: shell\n", "needs command"},
		{base + "connectors:\n  w:\n    kind: motita\n", "needs a url"},
		{base + "connectors:\n  w:\n    kind: slack\n    token: t\n", "webhook url, or a channel"},
		{base + "connectors:\n  w:\n    kind: telegram\n    settings:\n      chat_id: \"1\"\n", "needs bot token"},
		{base + "connectors:\n  w:\n    kind: fax\n", "is not one of"},
	}
	for _, tc := range cases {
		_, err := Parse([]byte(tc.text))
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%q: err = %v, want %q", tc.text, err, tc.want)
		}
	}
	good := base + "  k:\n    kind: openai\n    api_key: k\n    base_url: http://localhost:8080/v1\n" +
		"kitties:\n  - name: a\n    provider: p\n    connectors: [t, s, m]\n" +
		"connectors:\n  t:\n    kind: telegram\n    token: x\n    chat_id: '1'\n  s:\n    kind: shell\n    command: echo\n  m:\n    kind: motita\nmotita:\n  url: http://127.0.0.1:7477\n"
	if _, err := Parse([]byte(good)); err != nil {
		t.Errorf("a good configuration parses: %v", err)
	}
	for _, u := range []string{"http://localhost/x", "http://127.0.0.1:1", "http://[::1]:5/", "http://host.docker.internal"} {
		if !isLocal(u) {
			t.Errorf("%s is local", u)
		}
	}
	if isLocal("http://example.com") {
		t.Error("example.com is remote")
	}
	cs := Connector{Kind: "x", URL: "u", Token: "t", ChatID: "c", Command: "cmd", Headers: map[string]string{"B": "2", "A": "1"}, Settings: map[string]string{"repo": "a/b", "url": "shadowed"}}.ConnectorSettings()
	if cs["url"] != "u" || cs["token"] != "t" || cs["chat_id"] != "c" || cs["command"] != "cmd" || cs["repo"] != "a/b" || cs["headers"] != "A: 1\nB: 2" {
		t.Errorf("ConnectorSettings = %v", cs)
	}
	good2 := base + "connectors:\n  gh:\n    kind: github\n    token: t\n  em:\n    kind: email\n    settings:\n      host: h:25\n      user: u\n      password: p\n      from: f\n"
	if _, err := Parse([]byte(good2)); err != nil {
		t.Errorf("catalogue connectors parse: %v", err)
	}
}

func TestPaths(t *testing.T) {
	c := Config{DataDir: "/x"}
	if c.DataDirOr() != "/x" {
		t.Error("explicit data_dir")
	}
	c.DataDir = ""
	if !strings.HasSuffix(c.DataDirOr(), ".kitties") {
		t.Errorf("DataDirOr = %s", c.DataDirOr())
	}
	t.Setenv("HOME", "")
	if c.DataDirOr() != ".kitties" {
		t.Errorf("no home: %s", c.DataDirOr())
	}
	if DefaultPath() != "kitties.yaml" {
		t.Errorf("no home: %s", DefaultPath())
	}
	t.Setenv("HOME", t.TempDir())
	if !strings.HasSuffix(DefaultPath(), filepath.Join(".kitties", "kitties.yaml")) {
		t.Errorf("DefaultPath = %s", DefaultPath())
	}
	dir := t.TempDir()
	wd, _ := os.Getwd()
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(wd)
	_ = os.WriteFile("kitties.yaml", nil, 0o600)
	if DefaultPath() != "kitties.yaml" {
		t.Error("a file in the working directory wins")
	}
	t.Setenv("KITTIES_CONFIG", "/etc/k.yaml")
	if DefaultPath() != "/etc/k.yaml" {
		t.Error("the variable wins")
	}
	if (&Config{}).ProviderFor(Kitty{}) != "" {
		t.Error("no providers, no name")
	}
}

func TestGatewayServerSettings(t *testing.T) {
	base := "providers:\n  p:\n    kind: ollama\n"
	cfg, err := Parse([]byte(base + "gateway:\n  listen: 0.0.0.0:7488\n  public_url: https://kitties.example.com\n  trust_proxy: true\n  tls_cert: c.pem\n  tls_key: k.pem\n  local_token: true\n"))
	if err != nil {
		t.Fatal(err)
	}
	g := cfg.Gateway
	if g.PublicURL != "https://kitties.example.com" || !g.TrustProxy || g.TLSCert != "c.pem" || g.LocalToken == nil || !g.LocalTokenAllowed() {
		t.Errorf("gateway = %+v", g)
	}
	for _, bad := range []string{
		"gateway:\n  tls_cert: c.pem\n",
		"gateway:\n  tls_key: k.pem\n",
		"gateway:\n  public_url: kitties.example.com\n",
		"gateway:\n  public_url: ftp://x\n",
		"gateway:\n  public_url: https://x/app\n",
		"gateway:\n  public_url: https://x?y=1\n",
	} {
		if _, err := Parse([]byte(base + bad)); err == nil || !strings.Contains(err.Error(), "gateway.") {
			t.Errorf("%q must be refused: %v", bad, err)
		}
	}
	if _, err := Parse([]byte(base + "gateway:\n  public_url: https://x.example/\n")); err != nil {
		t.Errorf("a trailing slash is fine: %v", err)
	}
}

func TestLocalTokenAllowed(t *testing.T) {
	no, yes := false, true
	for _, tc := range []struct {
		g    Gateway
		want bool
	}{
		{Gateway{Listen: "127.0.0.1:7488"}, true},
		{Gateway{Listen: "localhost:7488"}, true},
		{Gateway{Listen: "[::1]:7488"}, true},
		{Gateway{Listen: "0.0.0.0:7488"}, false},
		{Gateway{Listen: ":7488"}, false},
		{Gateway{Listen: "10.0.0.5:7488"}, false},
		{Gateway{Listen: "127.0.0.1:7488", PublicURL: "https://k.example"}, false},
		{Gateway{Listen: "127.0.0.1:7488", TrustProxy: true}, false},
		{Gateway{Listen: "127.0.0.1:7488", TLSCert: "c", TLSKey: "k"}, false},
		{Gateway{Listen: "127.0.0.1:7488", PublicURL: "https://k.example", LocalToken: &yes}, true},
		{Gateway{Listen: "127.0.0.1:7488", LocalToken: &no}, false},
		{Gateway{Listen: "nonsense"}, false},
	} {
		if got := tc.g.LocalTokenAllowed(); got != tc.want {
			t.Errorf("%+v: %v, want %v", tc.g, got, tc.want)
		}
	}
}

func TestApplyEnv(t *testing.T) {
	cfg := Defaults()
	env := map[string]string{"KITTIES_LISTEN": "0.0.0.0:9000", "KITTIES_TOKEN": "tok", "KITTIES_PUBLIC_URL": "https://k.example", "KITTIES_DATA_DIR": "/data"}
	if err := cfg.ApplyEnv(func(k string) string { return env[k] }); err != nil {
		t.Fatal(err)
	}
	if cfg.Gateway.Listen != "0.0.0.0:9000" || cfg.Gateway.Token != "tok" || cfg.Gateway.PublicURL != "https://k.example" || cfg.DataDir != "/data" {
		t.Errorf("env not applied: %+v", cfg)
	}
	// A proxy in front is said with KITTIES_TRUST_PROXY.
	cfg = Defaults()
	for _, v := range []string{"true", "1", "YES"} {
		cfg = Defaults()
		_ = cfg.ApplyEnv(func(k string) string {
			if k == "KITTIES_TRUST_PROXY" {
				return v
			}
			return ""
		})
		if !cfg.Gateway.TrustProxy {
			t.Errorf("KITTIES_TRUST_PROXY=%s ignored", v)
		}
	}
	cfg = Defaults()
	_ = cfg.ApplyEnv(func(k string) string {
		if k == "KITTIES_TRUST_PROXY" {
			return "no"
		}
		return ""
	})
	if cfg.Gateway.TrustProxy {
		t.Error("no is no")
	}
	// Nothing set: nothing changes. A bad value is refused.
	cfg = Defaults()
	if err := cfg.ApplyEnv(func(string) string { return "" }); err != nil || cfg.Gateway.Listen != "127.0.0.1:7488" {
		t.Errorf("empty env: %v %+v", err, cfg.Gateway)
	}
	if err := cfg.ApplyEnv(func(k string) string {
		if k == "KITTIES_PUBLIC_URL" {
			return "nope"
		}
		return ""
	}); err == nil {
		t.Error("a bad public url is refused")
	}
}

func TestKittyLimitsBackupAndGoals(t *testing.T) {
	base := "providers:\n  p:\n    kind: ollama\nconnectors:\n  gh:\n    kind: github\n    settings:\n      token: t\n"
	cfg, err := Parse([]byte(base + "kitties:\n  - name: ana\n    backup: bob\n    limits:\n      max_tokens: 5000\n      max_seconds: 600\n      retries: 2\n    goals:\n      - title: Triage\n        text: Look at new issues\n        on: [gh]\n      - title: Report\n        every: '@weekly'\n  - name: bob\n"))
	if err != nil {
		t.Fatal(err)
	}
	ana := cfg.Kitties[0]
	if ana.Backup != "bob" || ana.Limits.MaxTokens != 5000 || ana.Limits.Retries != 2 || len(ana.Goals) != 2 || ana.Goals[0].On[0] != "gh" || ana.Goals[1].Every != "@weekly" {
		t.Errorf("ana = %+v", ana)
	}
	if _, err := Parse([]byte(base + "kitties:\n  - name: ana\n    backup: team-2\n  - name: team\n    replicas: 2\n")); err != nil {
		t.Errorf("a replica backs up: %v", err)
	}
	for _, bad := range []string{
		"kitties:\n  - name: ana\n    backup: team-3\n  - name: team\n    replicas: 2\n",
		"kitties:\n  - name: ana\n    backup: team-x\n  - name: team\n    replicas: 2\n",
		"kitties:\n  - name: ana\n    backup: ana\n",
		"kitties:\n  - name: ana\n    backup: nobody\n",
		"kitties:\n  - name: ana\n    limits:\n      max_tokens: -1\n",
		"kitties:\n  - name: ana\n    goals:\n      - text: no title\n        every: '@daily'\n",
		"kitties:\n  - name: ana\n    goals:\n      - title: nothing runs it\n",
		"kitties:\n  - name: ana\n    goals:\n      - title: bad cron\n        every: 'x y'\n",
		"kitties:\n  - name: ana\n    goals:\n      - title: unknown connector\n        on: [nope]\n",
	} {
		if _, err := Parse([]byte(base + bad)); err == nil || !strings.Contains(err.Error(), "kitties[0]") {
			t.Errorf("%q must be refused: %v", bad, err)
		}
	}
}

// The desktops keep themselves on the newest image unless told not to, looking every six hours.
func TestAutoUpdateDefaultsAndChecks(t *testing.T) {
	c, err := Parse([]byte("providers:\n  p:\n    kind: ollama\n    model: m\ndefault_provider: p\n"))
	if err != nil {
		t.Fatal(err)
	}
	if !c.Containers.AutoUpdate || c.Containers.UpdateCheckHours != 6 {
		t.Errorf("defaults = %+v", c.Containers)
	}
	off, err := Parse([]byte("providers:\n  p:\n    kind: ollama\n    model: m\ndefault_provider: p\ncontainers:\n  auto_update: false\n  update_check_hours: 24\n"))
	if err != nil || off.Containers.AutoUpdate || off.Containers.UpdateCheckHours != 24 {
		t.Errorf("off = %+v, %v", off.Containers, err)
	}
	for _, hours := range []string{"0", "721", "-1"} {
		_, err := Parse([]byte("providers:\n  p:\n    kind: ollama\n    model: m\ndefault_provider: p\ncontainers:\n  update_check_hours: " + hours + "\n"))
		if err == nil || !strings.Contains(err.Error(), "update_check_hours") {
			t.Errorf("update_check_hours %s = %v", hours, err)
		}
	}
}

func TestUpdatesWindowAndDefaults(t *testing.T) {
	c, err := Parse([]byte("providers:\n  p:\n    kind: ollama\n    model: m\ndefault_provider: p\n"))
	if err != nil {
		t.Fatal(err)
	}
	if u := c.Updates; u.Gateway != UpdateNotify || u.CheckHours != 12 || u.Repo != "madkoding/kitties" || u.Window != "" {
		t.Errorf("defaults = %+v", u)
	}
	at := func(h, m int) time.Time { return time.Date(2026, 1, 1, h, m, 0, 0, time.UTC) }
	for _, c := range []struct {
		window string
		in     map[time.Time]bool
	}{
		{"", map[time.Time]bool{at(3, 0): true, at(15, 0): true}},
		{"02:00-06:00", map[time.Time]bool{at(1, 59): false, at(2, 0): true, at(5, 59): true, at(6, 0): false, at(15, 0): false}},
		{"22:00-04:00", map[time.Time]bool{at(21, 59): false, at(22, 0): true, at(23, 30): true, at(0, 0): true, at(3, 59): true, at(4, 0): false, at(12, 0): false}},
		{"09:00-09:00", map[time.Time]bool{at(3, 0): true}},
	} {
		w, err := ParseWindow(c.window)
		if err != nil {
			t.Fatal(err)
		}
		for when, want := range c.in {
			if got := w.Contains(when); got != want {
				t.Errorf("window %q at %s = %v, want %v", c.window, when.Format("15:04"), got, want)
			}
		}
	}
	for _, bad := range []string{"2-6", "02:00", "25:00-06:00", "02:00-xx", "a-b"} {
		if _, err := ParseWindow(bad); err == nil {
			t.Errorf("window %q was accepted", bad)
		}
	}
	for yaml, want := range map[string]string{
		"updates:\n  window: nope\n":                 "updates.window",
		"updates:\n  gateway: maybe\n":               "updates.gateway",
		"updates:\n  check_hours: 0\n":               "updates.check_hours",
		"updates:\n  repo: justaname\n":              "updates.repo",
		"updates:\n  api: http://evil.example.com\n": "updates.api",
	} {
		if _, err := Parse([]byte("providers:\n  p:\n    kind: ollama\n    model: m\ndefault_provider: p\n" + yaml)); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q = %v, want %s", yaml, err, want)
		}
	}
	if _, err := Parse([]byte("providers:\n  p:\n    kind: ollama\n    model: m\ndefault_provider: p\nupdates:\n  window: 02:00-06:00\n  gateway: auto\n  api: http://127.0.0.1:9\n")); err != nil {
		t.Errorf("a good block = %v", err)
	}
}

func TestUpdatesPublicKey(t *testing.T) {
	base := "providers:\n  p:\n    kind: ollama\n    model: m\ndefault_provider: p\nupdates:\n  public_key: "
	good := "A" + strings.Repeat("A", 42) + "="
	if _, err := Parse([]byte(base + good + "\n")); err != nil {
		t.Errorf("a 32-byte key = %v", err)
	}
	for _, bad := range []string{"short", "not-base64$", strings.Repeat("A", 64)} {
		if _, err := Parse([]byte(base + bad + "\n")); err == nil || !strings.Contains(err.Error(), "updates.public_key") {
			t.Errorf("key %q = %v", bad, err)
		}
	}
}
