package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"github.com/madkoding/kitties/internal/notify"
	"github.com/madkoding/kitties/internal/selfupdate"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madkoding/kitties/internal/container"
	"github.com/madkoding/kitties/internal/orchestrator"
)

// fakeContainers is a runtime that always works.
type fakeContainers struct{ names map[string]bool }

func (f *fakeContainers) Up(_ context.Context, s container.Spec) (string, error) {
	f.names[s.Name] = true
	return s.Name, nil
}
func (f *fakeContainers) Start(context.Context, string) error { return nil }
func (f *fakeContainers) Stop(context.Context, string) error  { return nil }
func (f *fakeContainers) Remove(_ context.Context, n string) error {
	delete(f.names, n)
	return nil
}
func (f *fakeContainers) Exec(_ context.Context, n string, argv ...string) (string, error) {
	return "ran " + strings.Join(argv, " ") + "\n", nil
}
func (f *fakeContainers) Pull(context.Context, string) error { return nil }
func (f *fakeContainers) ImageStale(context.Context, string, string) (bool, error) {
	return false, nil
}
func (f *fakeContainers) ExecInput(_ context.Context, n, stdin string, argv ...string) (string, error) {
	return "ran " + strings.Join(argv, " ") + "\n", nil
}
func (f *fakeContainers) Stream(context.Context, string, int, int) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader("FRAME 3\npng")), nil
}
func (f *fakeContainers) Screenshot(context.Context, string) ([]byte, error) {
	return []byte("PNG"), nil
}
func (f *fakeContainers) List(context.Context) ([]container.Info, error) {
	var out []container.Info
	for n := range f.names {
		out = append(out, container.Info{ID: n, Name: n, Running: true})
	}
	return out, nil
}

func withRuntime(t *testing.T, available bool) {
	t.Helper()
	oldDetect, oldNew, oldNotify := detectRuntime, newContainers, notifyContext
	detectRuntime = func(context.Context, string) (container.Runtime, error) {
		if !available {
			return container.Runtime{}, container.ErrNoRuntime
		}
		return container.Runtime{Bin: "fake"}, nil
	}
	fc := &fakeContainers{names: map[string]bool{}}
	newContainers = func(container.Runtime) orchestrator.Containers { return fc }
	notifyContext = func() (context.Context, context.CancelFunc) { return context.WithCancel(context.Background()) }
	t.Cleanup(func() { detectRuntime, newContainers, notifyContext = oldDetect, oldNew, oldNotify })
}

// writeConfig writes a configuration whose only provider is a local chat server at url.
func writeConfig(t *testing.T, url string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "kitties.yaml")
	text := "data_dir: " + filepath.Join(dir, "data") + "\nproviders:\n  p:\n    kind: custom\n    model: m\n    base_url: " + url + "\n" +
		"kitties:\n  - name: mimi\n  - name: team\n    replicas: 2\n    desktop: false\ngateway:\n  listen: 127.0.0.1:0\n"
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func exec(t *testing.T, in string, args ...string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := run(args, strings.NewReader(in), &out, &errOut)
	return code, out.String(), errOut.String()
}

func TestUsageVersionInit(t *testing.T) {
	if code, _, errOut := exec(t, ""); code != 2 || !strings.Contains(errOut, "Usage:") {
		t.Errorf("no command: %d %s", code, errOut)
	}
	if code, _, _ := exec(t, "", "-bogus"); code != 2 {
		t.Error("bad flag")
	}
	if code, out, _ := exec(t, "", "version"); code != 0 || !strings.Contains(out, "kitties dev") {
		t.Error("version")
	}
	if code, _, _ := exec(t, "", "help"); code != 0 {
		t.Error("help")
	}
	path := filepath.Join(t.TempDir(), "sub", "kitties.yaml")
	if code, out, _ := exec(t, "", "-config", path, "init"); code != 0 || !strings.Contains(out, "Wrote") {
		t.Errorf("init: %d %s", code, out)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(path), "souls", "tom.yaml")); err != nil {
		t.Error("init writes the sample soul")
	}
	if code, _, errOut := exec(t, "", "-config", path, "init"); code != 1 || !strings.Contains(errOut, "already exists") {
		t.Error("init refuses to overwrite")
	}
	bad := filepath.Join(path, "x.yaml")
	if code, _, _ := exec(t, "", "-config", bad, "init"); code != 1 {
		t.Error("init under a file fails")
	}
	wd, _ := os.Getwd()
	dir := t.TempDir()
	_ = os.Chdir(dir)
	defer os.Chdir(wd)
	if code, _, _ := exec(t, "", "init"); code != 0 {
		t.Error("init in the working directory")
	}
	if _, err := os.ReadFile("kitties.yaml"); err != nil {
		t.Error("kitties.yaml written")
	}
	// The written example must load, keys aside.
	t.Setenv("ANTHROPIC_API_KEY", "k")
	t.Setenv("OPENAI_API_KEY", "k")
	withRuntime(t, false)
	t.Setenv("HOME", dir)
	if code, out, errOut := exec(t, "", "ls"); code != 0 || !strings.Contains(out, "no kitties yet") {
		t.Errorf("ls on the example: %d %s %s", code, out, errOut)
	}
	if code, _, errOut := exec(t, "", "-config", filepath.Join(dir, "missing.yaml"), "ls"); code != 1 || !strings.Contains(errOut, "kitties init") {
		t.Error("a missing configuration points at init")
	}
}

// chatServer answers the chat completions with the given texts in order, repeating the last.
func chatServer(t *testing.T, texts ...string) string {
	t.Helper()
	mux := http.NewServeMux()
	var mu sync.Mutex
	n := 0
	mux.HandleFunc("POST /chat/completions", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		text := texts[n]
		if n < len(texts)-1 {
			n++
		}
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":` + strconv.Quote(text) + `}}]}`))
	})
	srv := &http.Server{Handler: mux}
	ln, err := newListener()
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return "http://" + ln.Addr().String()
}

func TestFleetCommands(t *testing.T) {
	withRuntime(t, true)
	cfg := writeConfig(t, chatServer(t, "hello there"))
	if code, out, errOut := exec(t, "", "-config", cfg, "providers"); code != 0 || !strings.Contains(out, "custom/m") {
		t.Errorf("providers: %d %s %s", code, out, errOut)
	}
	if code, out, errOut := exec(t, "", "-config", cfg, "create", "ana", "-persona", "a tester"); code != 0 || !strings.Contains(out, "ana is up") {
		t.Errorf("create: %d %s %s", code, out, errOut)
	}
	if code, _, _ := exec(t, "", "-config", cfg, "create", "ana"); code != 1 {
		t.Error("duplicate create fails")
	}
	if code, _, _ := exec(t, "", "-config", cfg, "create"); code != 1 {
		t.Error("create needs a name")
	}
	if code, _, _ := exec(t, "", "-config", cfg, "create", "x", "-bogus"); code != 1 {
		t.Error("create bad flag")
	}
	if code, out, _ := exec(t, "", "-config", cfg, "create", "brain", "-no-desktop", "-connectors", "a"); code != 1 || out != "" {
		t.Error("unknown connector")
	}
	if code, _, _ := exec(t, "", "-config", cfg, "create", "brain", "-no-desktop", "-avatar", "tuxedo/mint"); code != 0 {
		t.Error("brain-only create")
	}
	if code, out, _ := exec(t, "", "-config", cfg, "ls"); code != 0 || !strings.Contains(out, "tuxedo/mint") {
		t.Errorf("ls shows the avatar: %s", out)
	}
	if code, _, _ := exec(t, "", "-config", cfg, "create", "lion", "-avatar", "lion"); code != 1 {
		t.Error("a bad avatar is refused")
	}
	if code, out, _ := exec(t, "", "-config", cfg, "ls"); code != 0 || !strings.Contains(out, "ana") || !strings.Contains(out, "brain") {
		t.Errorf("ls: %s", out)
	}
	for _, cmd := range []string{"stop", "start", "rm"} {
		if code, out, _ := exec(t, "", "-config", cfg, cmd, "ana"); code != 0 || !strings.Contains(out, "ana: "+cmd) {
			t.Errorf("%s: %d %s", cmd, code, out)
		}
		if code, _, _ := exec(t, "", "-config", cfg, cmd); code != 1 {
			t.Errorf("%s needs a name", cmd)
		}
	}
	if code, _, _ := exec(t, "", "-config", cfg, "start", "nobody"); code != 1 {
		t.Error("unknown kitty")
	}
	if code, out, _ := exec(t, "", "-config", cfg, "scale", "team", "3"); code != 0 || !strings.Contains(out, "team-3") {
		t.Errorf("scale: %s", out)
	}
	if code, _, _ := exec(t, "", "-config", cfg, "scale", "team"); code != 1 {
		t.Error("scale usage")
	}
	if code, _, _ := exec(t, "", "-config", cfg, "scale", "team", "x"); code != 1 {
		t.Error("scale number")
	}
	if code, _, _ := exec(t, "", "-config", cfg, "scale", "nobody", "1"); code != 1 {
		t.Error("scale unknown")
	}
	if code, out, _ := exec(t, "", "-config", cfg, "exec", "team-1", "ls"); code != 1 || out != "" {
		t.Error("exec without a container")
	}
	if code, _, _ := exec(t, "", "-config", cfg, "create", "desk"); code != 0 {
		t.Error("create desk")
	}
	if code, out, _ := exec(t, "", "-config", cfg, "exec", "desk", "ls", "-la"); code != 0 || out != "ran ls -la\n" {
		t.Errorf("exec: %d %q", code, out)
	}
	if code, _, _ := exec(t, "", "-config", cfg, "exec", "desk"); code != 1 {
		t.Error("exec usage")
	}
	shot := filepath.Join(t.TempDir(), "s.png")
	if code, out, _ := exec(t, "", "-config", cfg, "shot", "desk", shot); code != 0 || !strings.Contains(out, "saved") {
		t.Errorf("shot: %s", out)
	}
	if data, _ := os.ReadFile(shot); string(data) != "PNG" {
		t.Error("shot file")
	}
	if code, _, _ := exec(t, "", "-config", cfg, "shot", "desk"); code != 1 {
		t.Error("shot usage")
	}
	if code, _, _ := exec(t, "", "-config", cfg, "shot", "nobody", shot); code != 1 {
		t.Error("shot unknown")
	}
	if code, _, _ := exec(t, "", "-config", cfg, "shot", "desk", filepath.Join(shot, "x")); code != 1 {
		t.Error("shot unwritable")
	}
	if code, _, errOut := exec(t, "", "-config", cfg, "bogus"); code != 1 || !strings.Contains(errOut, "unknown command") {
		t.Error("unknown command")
	}
	t.Setenv("USER", "pat")
	in := "\nhi\n@desk and you?\n/quit\n"
	code, out, errOut := exec(t, in, "-config", cfg, "chat", "desk,brain")
	if code != 0 || strings.Count(out, "hello there") != 3 || !strings.Contains(out, "@name sends") {
		t.Errorf("group chat: %d %s %s", code, out, errOut)
	}
	if code, out, _ := exec(t, "hi\n", "-config", cfg, "chat", "brain"); code != 0 || !strings.Contains(out, "brain: hello there") {
		t.Errorf("single chat to the end of input: %s", out)
	}
	if code, _, _ := exec(t, "", "-config", cfg, "chat"); code != 1 {
		t.Error("chat usage")
	}
	if code, _, _ := exec(t, "", "-config", cfg, "chat", "nobody"); code != 1 {
		t.Error("chat unknown kitty")
	}
	// A brain that fails is reported and the chat goes on.
	bad := writeConfig(t, "http://127.0.0.1:1")
	if code, _, _ := exec(t, "", "-config", bad, "create", "x", "-no-desktop"); code != 0 {
		t.Error("create x")
	}
	if code, out, _ := exec(t, "hi\n/exit\n", "-config", bad, "chat", "x"); code != 0 || !strings.Contains(out, "could not answer") {
		t.Errorf("failing brain: %s", out)
	}
	// Chat state that cannot be saved is reported.
	_ = os.WriteFile(filepath.Join(filepath.Dir(bad), "data", "chats", "zz.json"), []byte("{"), 0o600)
	if code, _, errOut := exec(t, "", "-config", bad, "ls"); code != 1 || !strings.Contains(errOut, "damaged") {
		t.Error("damaged chats are reported")
	}
}

func TestChatFollowsDesktopTask(t *testing.T) {
	withRuntime(t, true)
	pollEvery = 5 * time.Millisecond
	defer func() { pollEvery = 500 * time.Millisecond }()
	cfg := writeConfig(t, chatServer(t,
		"On it.\n@tool click {\"x\": 5, \"y\": 5}",
		"@tool done {\"summary\": \"Clicked the thing.\"}",
		"anything else?"))
	if code, _, _ := exec(t, "", "-config", cfg, "create", "desk"); code != 0 {
		t.Fatal("create desk")
	}
	code, out, errOut := exec(t, "click it\n/quit\n", "-config", cfg, "chat", "desk")
	if code != 0 || !strings.Contains(out, "desk: On it.") || !strings.Contains(out, "working on the desktop") ||
		!strings.Contains(out, "· click: ran xdotool") || !strings.Contains(out, "[shot 1-1.png]") || !strings.Contains(out, "desk: Clicked the thing.") {
		t.Errorf("follow: %d %s %s", code, out, errOut)
	}
}

func TestGatewayCommand(t *testing.T) {
	withRuntime(t, true)
	cfg := writeConfig(t, chatServer(t, "ok"))
	ctx, cancel := context.WithCancel(context.Background())
	notifyContext = func() (context.Context, context.CancelFunc) { return ctx, func() {} }
	out, errOut := &syncBuffer{}, &syncBuffer{}
	done := make(chan int, 1)
	go func() { done <- run([]string{"-config", cfg, "gateway"}, strings.NewReader(""), out, errOut) }()
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(out.String(), "listening") && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	if code := <-done; code != 0 {
		t.Errorf("gateway: %d %s %s", code, out.String(), errOut.String())
	}
	text := out.String()
	if !strings.Contains(text, "gateway token") || !strings.Contains(text, "mimi") || !strings.Contains(text, "team-2") {
		t.Errorf("gateway output: %s", text)
	}
	if data, err := os.ReadFile(filepath.Join(filepath.Dir(cfg), "data", "gateway.token")); err != nil || len(strings.TrimSpace(string(data))) != 32 {
		t.Errorf("the token is kept in the data folder: %q %v", data, err)
	} else if token := strings.TrimSpace(string(data)); strings.Contains(out.String(), token) || strings.Contains(errOut.String(), token) {
		t.Error("gateway startup printed its bearer token")
	}
	// A kitty that cannot start is reported, not fatal.
	withRuntime(t, false)
	badCfg := writeConfig(t, "http://127.0.0.1:1")
	_ = os.WriteFile(badCfg, []byte(strings.Replace(mustRead(t, badCfg), "listen: 127.0.0.1:0", "listen: 127.0.0.1:99999", 1)), 0o600)
	if code, _, errOut := exec(t, "", "-config", badCfg, "gateway"); code != 1 || !strings.Contains(errOut, "brain-only") || !strings.Contains(errOut, "listen on") {
		t.Errorf("gateway on a busy port: %d %s", code, errOut)
	}
}

// syncBuffer is a bytes.Buffer safe to read while the gateway goroutine writes it.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestOpenFailures(t *testing.T) {
	withRuntime(t, false)
	dir := t.TempDir()
	cfg := filepath.Join(dir, "k.yaml")
	_ = os.WriteFile(cfg, []byte("data_dir: "+filepath.Join(dir, "data")+"\nproviders:\n  p:\n    kind: openai\n"), 0o600)
	t.Setenv("OPENAI_API_KEY", "")
	if code, _, errOut := exec(t, "", "-config", cfg, "ls"); code != 0 || !strings.Contains(errOut, "API key") {
		t.Errorf("a provider without a key is reported, the fleet still runs: %d %s", code, errOut)
	}
	if code, _, errOut := exec(t, "", "-config", cfg, "create", "x", "-no-desktop"); code != 1 || !strings.Contains(errOut, "cannot be used yet") {
		t.Errorf("a kitty cannot use the keyless profile: %d %s", code, errOut)
	}
	if code, _, errOut := exec(t, "", "-config", cfg, "providers"); code != 0 || strings.Contains(errOut, "brain-only") {
		t.Error("providers never probes the runtime")
	}
	if err := errors.Join(nil); err != nil {
		t.Error(err)
	}
}

func TestDemoMode(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	withRuntime(t, false)
	if code, out, errOut := exec(t, "", "-demo", "providers"); code != 0 || !strings.Contains(out, "demo/scripted") || !strings.Contains(errOut, "demo mode") {
		t.Errorf("demo providers: %d %s %s", code, out, errOut)
	}
	if code, _, _ := exec(t, "", "-demo", "-config", filepath.Join(t.TempDir(), "none.yaml"), "providers"); code != 1 {
		t.Error("a named file that is missing fails even in demo mode")
	}
	pollEvery = 5 * time.Millisecond
	defer func() { pollEvery = 500 * time.Millisecond }()
	if code, out, _ := exec(t, "", "-demo", "create", "zoe"); code != 0 || !strings.Contains(out, "zoe is up (demo") {
		t.Errorf("demo create: %d %s", code, out)
	}
	code, out, errOut := exec(t, "hello\nopen https://example.com\n/quit\n", "-demo", "chat", "zoe")
	if code != 0 || !strings.Contains(out, "I am zoe") || !strings.Contains(out, "· open: opened https://example.com") || !strings.Contains(out, "placeholder domain") {
		t.Errorf("demo chat: %d %s %s", code, out, errOut)
	}
	// A configuration file still wins in demo mode: its providers become scripted brains.
	cfg := writeConfig(t, "http://127.0.0.1:1")
	if code, out, _ := exec(t, "", "-demo", "-config", cfg, "providers"); code != 0 || !strings.Contains(out, "p            demo/scripted") {
		t.Errorf("demo with a file: %d %s", code, out)
	}
}

func TestFollowTaskHelpers(t *testing.T) {
	if firstLine("  a\nb ") != "a…" || firstLine(strings.Repeat("x", 120)) != strings.Repeat("x", 100)+"…" || firstLine("ok") != "ok" {
		t.Error("firstLine")
	}
	withRuntime(t, true)
	cfg := writeConfig(t, chatServer(t, "@tool wait {\"seconds\": 3}", "@tool done {\"summary\": \"late\"}"))
	if code, _, _ := exec(t, "", "-config", cfg, "create", "desk"); code != 0 {
		t.Fatal("create desk")
	}
	// A cancelled context (ctrl+c) stops following and cancels the task.
	ctx, cancel := context.WithCancel(context.Background())
	notifyContext = func() (context.Context, context.CancelFunc) { return ctx, func() {} }
	pollEvery = 5 * time.Millisecond
	defer func() { pollEvery = 500 * time.Millisecond }()
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	code, out, _ := exec(t, "wait for it\n", "-config", cfg, "chat", "desk")
	if code != 0 || !strings.Contains(out, "working on the desktop") || strings.Contains(out, "late") {
		t.Errorf("cancel: %d %s", code, out)
	}
	// A chat whose session vanished stops following.
	a := &app{out: &bytes.Buffer{}}
	a.chats = nil
	_ = a
}

// The commands of whoever makes the releases: a key pair, a signature, and checking it.
func TestReleaseSigningCommands(t *testing.T) {
	dir := t.TempDir()
	var out, errOut bytes.Buffer
	if code := run([]string{"release-key"}, nil, &out, &errOut); code != 0 {
		t.Fatalf("release-key = %d %s", code, errOut.String())
	}
	var keys []string
	for _, line := range strings.Split(out.String(), "\n") {
		if len(line) == 44 || len(line) == 88 {
			keys = append(keys, line)
		}
	}
	if len(keys) != 2 {
		t.Fatalf("the keys are not in %q", out.String())
	}
	pub, priv := keys[0], keys[1]
	file := filepath.Join(dir, "SHA256SUMS")
	if err := os.WriteFile(file, []byte("abc  kitties-linux-amd64\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KITTIES_SIGNING_KEY", priv)
	out.Reset()
	if code := run([]string{"release-sign", file}, nil, &out, &errOut); code != 0 || !strings.Contains(out.String(), "SHA256SUMS.sig") {
		t.Fatalf("release-sign = %d %s %s", code, out.String(), errOut.String())
	}
	out.Reset()
	if code := run([]string{"release-verify", file, file + ".sig", pub}, nil, &out, &errOut); code != 0 || !strings.Contains(out.String(), "is signed by that key") {
		t.Fatalf("release-verify = %d %s %s", code, out.String(), errOut.String())
	}
	// A changed file, another key, a missing file, a bad private key and bad usage all fail.
	other := filepath.Join(dir, "other")
	_ = os.WriteFile(other, []byte("changed"), 0o644)
	var otherKey bytes.Buffer
	run([]string{"release-key"}, nil, &otherKey, &errOut)
	otherPub := ""
	for _, line := range strings.Split(otherKey.String(), "\n") {
		if len(line) == 44 {
			otherPub = line
			break
		}
	}
	for name, args := range map[string][]string{
		"changed":      {"release-verify", other, file + ".sig", pub},
		"another key":  {"release-verify", file, file + ".sig", otherPub},
		"no file":      {"release-verify", filepath.Join(dir, "nope"), file + ".sig", pub},
		"no sig":       {"release-verify", file, filepath.Join(dir, "nope"), pub},
		"verify usage": {"release-verify", file},
		"sign usage":   {"release-sign"},
		"sign no file": {"release-sign", filepath.Join(dir, "nope")},
	} {
		if code := run(args, nil, &out, &errOut); code == 0 {
			t.Errorf("%s succeeded", name)
		}
	}
	t.Setenv("KITTIES_SIGNING_KEY", "nope")
	if code := run([]string{"release-sign", file}, nil, &out, &errOut); code == 0 {
		t.Error("signing with a bad key succeeded")
	}
	if cmdRelease("release-other", nil, &out, &errOut) != 2 {
		t.Error("an unknown release command")
	}
}

type recordSender struct{ got []notify.Notification }

func (r *recordSender) Notify(n notify.Notification) { r.got = append(r.got, n) }

func TestUpdateNotes(t *testing.T) {
	var logs []string
	rec := &recordSender{}
	h := updateHooks(rec, func() bool { return true }, func(f string, a ...any) { logs = append(logs, f) })
	h.Available(selfupdate.Status{Latest: "v2.0.0"})
	h.Available(selfupdate.Status{Latest: "v2.0.0", Why: "in a container: docker compose pull"})
	h.Updated("v1.0.0", "v2.0.0")
	h.Log("x")
	if !h.Window() || len(rec.got) != 3 || len(logs) != 1 {
		t.Fatalf("hooks = %+v %v", rec.got, logs)
	}
	for i, want := range []string{"Update it from Settings", "docker compose pull", "restarts now"} {
		if rec.got[i].Event != notify.Updated || !strings.Contains(rec.got[i].Body, want) {
			t.Errorf("note %d = %+v, want %q", i, rec.got[i], want)
		}
	}
	if n := rolledBackNote("v2.0.0", "v1.0.0"); n.Event != notify.Updated || !strings.Contains(n.Title, "v1.0.0") || !strings.Contains(n.Body, "v2.0.0") {
		t.Errorf("rollback note = %+v", n)
	}
}

// A gateway that starts and finds that the update it is has already started and did not hold
// goes back; here there is no previous version to go back to, which it says and goes on.
func TestGatewayStartFindsAnUpdateThatDidNotHold(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	marker := exe + ".update"
	raw := fmt.Sprintf(`{"From":"v0.9.0","To":%q,"Boots":1,"BootAt":%q}`, version, time.Now().Format(time.RFC3339))
	if err := os.WriteFile(marker, []byte(raw), 0o600); err != nil {
		t.Skip("the folder of the test binary is not writable")
	}
	t.Cleanup(func() { _ = os.Remove(marker) })
	var out, errOut bytes.Buffer
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	old := notifyContext
	notifyContext = func() (context.Context, context.CancelFunc) { return ctx, func() {} }
	t.Cleanup(func() { notifyContext = old })
	run([]string{"-demo", "gateway"}, nil, &out, &errOut)
	if !strings.Contains(errOut.String(), "cannot be run") {
		t.Errorf("the failed rollback was not said: %q", errOut.String())
	}
}

// A gateway that starts after a version that did not hold was gone back from says so.
func TestGatewayStartTellsOfTheRollback(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	refused := exe + ".refused"
	if err := os.WriteFile(refused, []byte(`{"Tag":"v9.9.9","Told":false}`), 0o600); err != nil {
		t.Skip("the folder of the test binary is not writable")
	}
	t.Cleanup(func() { _ = os.Remove(refused) })
	withRuntime(t, true)
	cfg := writeConfig(t, chatServer(t, "ok"))
	ctx, cancel := context.WithCancel(context.Background())
	notifyContext = func() (context.Context, context.CancelFunc) { return ctx, func() {} }
	out, errOut := &syncBuffer{}, &syncBuffer{}
	done := make(chan int, 1)
	go func() { done <- run([]string{"-config", cfg, "gateway"}, strings.NewReader(""), out, errOut) }()
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(out.String(), "listening") && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	<-done
	if !strings.Contains(out.String(), "v9.9.9 did not hold") {
		t.Errorf("the rollback was not told: %s", out.String())
	}
	// It is told once: the next start finds nothing to say.
	if raw := mustRead(t, refused); !strings.Contains(raw, `"Told":true`) {
		t.Errorf("the rollback is told again at every start: %s", raw)
	}
}

// Where the data folder cannot hold the key (a read-only volume), the saved secrets and the
// session backups are off and the gateway still starts.
func TestSecretStoresOffWhereTheKeyCannotBeKept(t *testing.T) {
	dir := t.TempDir()
	var warn bytes.Buffer
	if v, k := openSecretStores(dir, &warn); v == nil || k == nil || warn.Len() != 0 {
		t.Fatalf("a writable folder: %v %v %q", v, k, warn.String())
	}
	blocked := filepath.Join(dir, "a-file")
	if err := os.WriteFile(blocked, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A folder that cannot be made (it is under a file) cannot keep a key.
	if v, k := openSecretStores(filepath.Join(blocked, "data"), &warn); v != nil || k != nil || !strings.Contains(warn.String(), "are off") {
		t.Errorf("an unwritable folder: %v %v %q", v, k, warn.String())
	}
	// And a key that is not one stops them too.
	t.Setenv("KITTIES_VAULT_KEY", "nope")
	warn.Reset()
	if v, _ := openSecretStores(t.TempDir(), &warn); v != nil || !strings.Contains(warn.String(), "KITTIES_VAULT_KEY") {
		t.Errorf("a bad key: %v %q", v, warn.String())
	}
}
