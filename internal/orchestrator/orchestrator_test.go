package orchestrator

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/madkoding/kitties/internal/config"
	"github.com/madkoding/kitties/internal/container"
	"github.com/madkoding/kitties/internal/kitty"
	"github.com/madkoding/kitties/internal/provider"
	"github.com/madkoding/kitties/internal/soul"
)

// fakeContainers remembers what exists and runs.
type fakeContainers struct {
	calls   []string
	exists  map[string]bool
	running map[string]bool
	fail    string // the operation that fails
	execs   []string
	inputs  []string // what was given on an input
	// outputs are what a command prints, by its program; stale is whether the image moved on.
	outputs  map[string]string
	pullErr  error
	stale    bool
	staleErr error
}

func newFake() *fakeContainers {
	return &fakeContainers{exists: map[string]bool{}, running: map[string]bool{}}
}

func (f *fakeContainers) op(name string) error {
	f.calls = append(f.calls, name)
	if f.fail == name {
		return errors.New(name + " failed")
	}
	return nil
}

func (f *fakeContainers) Up(_ context.Context, s container.Spec) (string, error) {
	if err := f.op("up"); err != nil {
		return "", err
	}
	f.exists[s.Name], f.running[s.Name] = true, true
	return s.Name, nil
}
func (f *fakeContainers) Start(_ context.Context, n string) error {
	if err := f.op("start"); err != nil {
		return err
	}
	f.running[n] = true
	return nil
}
func (f *fakeContainers) Stop(_ context.Context, n string) error {
	if err := f.op("stop"); err != nil {
		return err
	}
	f.running[n] = false
	return nil
}
func (f *fakeContainers) Remove(_ context.Context, n string) error {
	if err := f.op("rm"); err != nil {
		return err
	}
	delete(f.exists, n)
	delete(f.running, n)
	return nil
}
func (f *fakeContainers) Exec(_ context.Context, n string, argv ...string) (string, error) {
	f.execs = append(f.execs, n+":"+strings.Join(argv, " "))
	if out, ok := f.outputs[argv[0]]; ok {
		return out, f.op("exec")
	}
	return n + ":" + strings.Join(argv, " "), f.op("exec")
}
func (f *fakeContainers) Pull(_ context.Context, image string) error {
	f.calls = append(f.calls, "pull "+image)
	return f.pullErr
}
func (f *fakeContainers) ImageStale(context.Context, string, string) (bool, error) {
	return f.stale, f.staleErr
}
func (f *fakeContainers) ExecInput(_ context.Context, n, stdin string, argv ...string) (string, error) {
	f.inputs = append(f.inputs, n+":"+stdin)
	f.execs = append(f.execs, n+":"+strings.Join(argv, " "))
	return "", f.op("exec")
}
func (f *fakeContainers) Stream(context.Context, string, int, int) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader("FRAME 3\npng")), nil
}
func (f *fakeContainers) Screenshot(context.Context, string) ([]byte, error) {
	return []byte("png"), f.op("shot")
}
func (f *fakeContainers) List(context.Context) ([]container.Info, error) {
	if err := f.op("list"); err != nil {
		return nil, err
	}
	var out []container.Info
	for n := range f.exists {
		out = append(out, container.Info{ID: n, Name: n, Running: f.running[n]})
	}
	return out, nil
}

func testConfig(t *testing.T) config.Config {
	t.Helper()
	cfg, err := config.Parse([]byte("providers:\n  p:\n    kind: ollama\n    model: m\n  q:\n    kind: ollama\n    model: n\ndefault_provider: p\n" +
		"connectors:\n  hook:\n    kind: webhook\n    url: http://h\n  sl:\n    kind: slack\n    url: http://s\n  dc:\n    kind: discord\n    url: http://d\n" +
		"  tg:\n    kind: telegram\n    token: t\n    chat_id: '1'\n  sh:\n    kind: shell\n    command: echo\n  mo:\n    kind: motita\n  mo2:\n    kind: motita\n    url: http://m2\n" +
		"motita:\n  url: http://m\nkitties:\n  - name: solo\n  - name: team\n    replicas: 2\n    provider: q\n    desktop: false\n"))
	if err != nil {
		t.Fatal(err)
	}
	cfg.DataDir = t.TempDir()
	return cfg
}

func TestNewBuildsProvidersAndConnectors(t *testing.T) {
	cfg := testConfig(t)
	m, err := New(cfg, WithContainers(newFake(), nil))
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Providers().Names()) != 2 || len(m.Connectors().Names()) != 7 {
		t.Errorf("registries: %v %v", m.Providers().Names(), m.Connectors().Names())
	}
	if ok, _ := m.HasContainers(); !ok || m.Config().DefaultProvider != "p" {
		t.Error("HasContainers / Config")
	}
	bad := cfg
	bad.Providers = map[string]config.Provider{"x": {Kind: "openai"}}
	t.Setenv("OPENAI_API_KEY", "")
	keyless, err := New(bad)
	if err != nil {
		t.Fatalf("a provider without its key does not stop the fleet: %v", err)
	}
	if v := keyless.Settings().Providers; len(v) != 1 || !strings.Contains(v[0].Error, "API key") || v[0].APIKeySet {
		t.Errorf("the page says why the profile is unavailable: %+v", v)
	}
	_ = os.WriteFile(filepath.Join(cfg.DataDir, "kitties.json"), []byte("{"), 0o600)
	if _, err := New(cfg); err == nil || !strings.Contains(err.Error(), "damaged") {
		t.Errorf("damaged state: %v", err)
	}
	_ = os.WriteFile(filepath.Join(cfg.DataDir, "kitties.json"), []byte(`[{"id":"1","name":"old","provider":"p","status":"running"}]`), 0o600)
	m, err = New(cfg)
	if err != nil || len(m.List()) != 1 || m.List()[0].Name != "old" {
		t.Errorf("state is loaded: %v %v", err, m.List())
	}
	if ok, err := m.HasContainers(); ok || err != nil {
		t.Error("no containers by default")
	}
	if err := os.Mkdir(filepath.Join(cfg.DataDir, "dir"), 0o700); err != nil {
		t.Fatal(err)
	}
	cfg.DataDir = filepath.Join(cfg.DataDir, "dir", "kitties.json")
	_ = os.WriteFile(cfg.DataDir, nil, 0o600)
	cfg.DataDir = filepath.Join(cfg.DataDir)
	if _, err := New(config.Config{DataDir: filepath.Join(cfg.DataDir)}); err == nil {
		t.Error("an unreadable state path fails")
	}
}

func TestCreateGetListRemove(t *testing.T) {
	cfg := testConfig(t)
	f := newFake()
	m, err := New(cfg, WithContainers(f, nil))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	soulFile := filepath.Join(t.TempDir(), "s.yaml")
	_ = os.WriteFile(soulFile, []byte("persona: from file\ntone: dry\n"), 0o600)
	k, err := m.Create(ctx, Spec{Name: "mimi", SoulFile: soulFile, Connectors: []string{"hook"}})
	if err != nil {
		t.Fatal(err)
	}
	if k.Provider != "p" || k.Soul.Persona != "from file" || k.Soul.Tone != "dry" || !k.Desktop || k.Container != "kitty-mimi" || k.Status != kitty.StatusCreated {
		t.Errorf("kitty = %+v", k)
	}
	if !strings.HasSuffix(k.Workspace, filepath.Join("work", "mimi")) {
		t.Errorf("workspace = %s", k.Workspace)
	}
	no := false
	brain, err := m.Create(ctx, Spec{Name: "brain", Provider: "q", Desktop: &no, Soul: k.Soul})
	if err != nil || brain.Desktop || brain.Container != "" || brain.Soul.Persona != "from file" {
		t.Errorf("brain-only kitty = %+v, %v", brain, err)
	}
	if k.Avatar != kitty.DefaultAvatar("mimi") {
		t.Errorf("avatar from the name: %+v", k.Avatar)
	}
	edited, err := m.Edit("mimi", Update{Avatar: &kitty.Avatar{Breed: "tuxedo", Color: "pink"}, Soul: &soul.Soul{Tone: "edited"}})
	if err != nil || edited.Avatar != (kitty.Avatar{Breed: "tuxedo", Color: "pink"}) || edited.Soul.Tone != "edited" || edited.Soul.Persona != "from file" {
		t.Errorf("Edit = %+v %v", edited, err)
	}
	if _, err := m.Edit("mimi", Update{Avatar: &kitty.Avatar{Breed: "lion"}}); err == nil {
		t.Error("Edit validates the avatar")
	}
	if _, err := m.Edit("zz", Update{}); err == nil {
		t.Error("Edit unknown")
	}
	for _, s := range []Spec{{Name: "Bad"}, {Name: "x", Provider: "zz"}, {Name: "x", Connectors: []string{"zz"}}, {Name: "x", SoulFile: "/nope"}, {Name: "mimi"}, {Name: "x", Avatar: kitty.Avatar{Color: "plaid"}}} {
		if _, err := m.Create(ctx, s); err == nil {
			t.Errorf("%+v must fail", s)
		}
	}
	if got, err := m.Get("mimi"); err != nil || got.ID != k.ID {
		t.Error("Get by name")
	}
	if got, err := m.Get(k.ID); err != nil || got.Name != "mimi" {
		t.Error("Get by id")
	}
	if _, err := m.Get("zz"); !errors.Is(err, ErrNotFound) {
		t.Error("Get unknown")
	}
	if list := m.List(); len(list) != 2 || list[0].Name != "brain" || list[1].Name != "mimi" {
		t.Errorf("List = %v", list)
	}
	if c, err := m.Brain(k); err != nil || c.Describe() != "ollama/m" {
		t.Error("Brain")
	}
	m2, err := New(cfg, WithContainers(f, nil))
	if err != nil || len(m2.List()) != 2 {
		t.Error("state survives a restart")
	}
	if err := m.Remove(ctx, "brain"); err != nil || len(m.List()) != 1 {
		t.Error("Remove")
	}
	if err := m.Remove(ctx, "zz"); err == nil {
		t.Error("Remove unknown")
	}
	m.newID = func() string { return k.ID }
	m.path = filepath.Join(t.TempDir(), "missing", "x", "kitties.json")
	_ = os.WriteFile(filepath.Dir(filepath.Dir(m.path)), nil, 0o600)
	if _, err := m.Edit("mimi", Update{Avatar: &kitty.Avatar{Breed: "tabby"}}); err == nil {
		t.Error("Edit reports a save failure")
	}
	_ = os.WriteFile(filepath.Dir(filepath.Dir(m.path)), nil, 0o600)
	if _, err := m.Create(ctx, Spec{Name: "nosave"}); err == nil {
		t.Error("a save failure is reported and the kitty is not kept")
	}
	if _, err := m.Get("nosave"); err == nil {
		t.Error("the kitty was rolled back")
	}
}

func TestLifecycle(t *testing.T) {
	cfg := testConfig(t)
	f := newFake()
	m, err := New(cfg, WithContainers(f, nil))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	k, _ := m.Create(ctx, Spec{Name: "mimi"})
	if err := m.Start(ctx, "mimi"); err != nil {
		t.Fatal(err)
	}
	if got, _ := m.Get("mimi"); got.Status != kitty.StatusRunning || !f.running["kitty-mimi"] {
		t.Error("Start creates and runs the container")
	}
	// The container's user writes in its workspace; the root keeps everyone else out.
	if st, err := os.Stat(k.Workspace); err != nil || st.Mode().Perm() != 0o777 {
		t.Errorf("the workspace folder is created, open to the container: %v %v", st, err)
	}
	if st, err := os.Stat(filepath.Dir(k.Workspace)); err != nil || st.Mode().Perm() != 0o700 {
		t.Errorf("the workspaces' root is the gateway's alone: %v %v", st, err)
	}
	if err := m.Start(ctx, "mimi"); err != nil || strings.Count(strings.Join(f.calls, ","), "up") != 1 {
		t.Error("a running kitty is left alone")
	}
	if err := m.Stop(ctx, "mimi"); err != nil || f.running["kitty-mimi"] {
		t.Error("Stop")
	}
	if got, _ := m.Get("mimi"); got.Status != kitty.StatusStopped {
		t.Error("status stopped")
	}
	if err := m.Start(ctx, "mimi"); err != nil || !f.running["kitty-mimi"] || f.calls[len(f.calls)-1] != "start" {
		t.Errorf("Start of a stopped container: %v %v", err, f.calls)
	}
	if out, err := m.Exec(ctx, "mimi", "ls"); err != nil || out != "kitty-mimi:ls" {
		t.Errorf("Exec = %q %v", out, err)
	}
	if png, err := m.Screenshot(ctx, "mimi"); err != nil || string(png) != "png" {
		t.Error("Screenshot")
	}
	if err := m.StopAll(ctx); err != nil || f.running["kitty-mimi"] {
		t.Error("StopAll")
	}
	if err := m.Remove(ctx, "mimi"); err != nil || f.exists["kitty-mimi"] {
		t.Error("Remove deletes the container")
	}
	for _, ref := range []string{"zz"} {
		if m.Start(ctx, ref) == nil || m.Stop(ctx, ref) == nil {
			t.Error("unknown kitty")
		}
		if _, err := m.Exec(ctx, ref); err == nil {
			t.Error("Exec unknown")
		}
		if _, err := m.Screenshot(ctx, ref); err == nil {
			t.Error("Screenshot unknown")
		}
	}
	no := false
	b, _ := m.Create(ctx, Spec{Name: "brain", Desktop: &no})
	if err := m.Start(ctx, b.ID); err != nil {
		t.Error(err)
	}
	if got, _ := m.Get("brain"); got.Status != kitty.StatusRunning {
		t.Error("a brain-only kitty runs without a container")
	}
	if _, err := m.Exec(ctx, "brain", "ls"); err == nil {
		t.Error("no container, no exec")
	}
	if _, err := m.Screenshot(ctx, "brain"); err == nil {
		t.Error("no container, no screenshot")
	}
	if err := m.Stop(ctx, "brain"); err != nil {
		t.Error(err)
	}
}

func TestLifecycleFailures(t *testing.T) {
	cfg := testConfig(t)
	f := newFake()
	m, _ := New(cfg, WithContainers(f, nil))
	ctx := context.Background()
	k, _ := m.Create(ctx, Spec{Name: "mimi"})
	for _, op := range []string{"list", "up"} {
		f.fail = op
		if err := m.Start(ctx, k.ID); err == nil {
			t.Errorf("%s failure is reported", op)
		}
		if got, _ := m.Get(k.ID); got.Status != kitty.StatusError || got.Error == "" {
			t.Errorf("%s failure marks the kitty: %+v", op, got)
		}
	}
	f.fail = ""
	_ = m.Start(ctx, k.ID)
	f.running["kitty-mimi"] = false
	f.fail = "start"
	if err := m.Start(ctx, k.ID); err == nil {
		t.Error("start failure")
	}
	f.fail = "stop"
	if err := m.Stop(ctx, k.ID); err == nil {
		t.Error("stop failure")
	}
	f.fail = "list"
	if err := m.Stop(ctx, k.ID); err == nil {
		t.Error("stop list failure")
	}
	if err := m.Remove(ctx, k.ID); err == nil {
		t.Error("remove list failure")
	}
	f.fail = "rm"
	if err := m.Remove(ctx, k.ID); err == nil {
		t.Error("rm failure")
	}
	f.fail = ""
	_ = m.Start(ctx, k.ID)
	if err := m.StopAll(ctx); err != nil {
		t.Error(err)
	}
	_ = m.Start(ctx, k.ID)
	f.fail = "stop"
	if err := m.StopAll(ctx); err == nil {
		t.Error("StopAll reports failures")
	}
	f.fail = ""
	k2, _ := m.Create(ctx, Spec{Name: "nowork"})
	k2.Workspace = filepath.Join(cfg.DataDir, "kitties.json", "x")
	if err := m.Start(ctx, k2.ID); err == nil {
		t.Error("a workspace that cannot be created fails Start")
	}
	if err := m.setStatus("zz", "x", ""); !errors.Is(err, ErrNotFound) {
		t.Error("setStatus unknown")
	}
}

func TestBootstrapAndScale(t *testing.T) {
	cfg := testConfig(t)
	f := newFake()
	m, err := New(cfg, WithContainers(f, nil))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := m.Bootstrap(ctx); err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, k := range m.List() {
		names = append(names, k.Name+":"+k.Status)
	}
	if strings.Join(names, ",") != "solo:running,team-1:running,team-2:running" {
		t.Errorf("Bootstrap = %v", names)
	}
	if k, _ := m.Get("team-1"); k.Desktop || k.Provider != "q" || k.Soul.Name != "team" {
		t.Errorf("replica = %+v", k)
	}
	if err := m.Bootstrap(ctx); err != nil || len(m.List()) != 3 {
		t.Error("Bootstrap is idempotent")
	}
	if err := m.Scale(ctx, "team", 4); err != nil || len(m.List()) != 5 {
		t.Errorf("scale up: %v %d", err, len(m.List()))
	}
	if err := m.Scale(ctx, "team", 1); err != nil || len(m.List()) != 2 {
		t.Errorf("scale down: %v %d", err, len(m.List()))
	}
	if _, err := m.Get("team-1"); err != nil {
		t.Error("team-1 stays")
	}
	if err := m.Scale(ctx, "nobody", 1); err == nil {
		t.Error("unknown base")
	}
	if err := m.Scale(ctx, "team", -1); err == nil {
		t.Error("negative replicas")
	}
	if _, ok := replicaIndex("team-", "team"); ok {
		t.Error("empty index")
	}
	if _, ok := replicaIndex("team-x", "team"); ok {
		t.Error("non-numeric index")
	}
	if n, ok := replicaIndex("team-12", "team"); !ok || n != 12 {
		t.Error("index")
	}
	f.fail = "up"
	if err := m.Scale(ctx, "solo", 1); err == nil {
		t.Error("a start failure stops the scale")
	}
	bad := cfg
	bad.DataDir = t.TempDir()
	bad.Kitties = []config.Kitty{{Name: "solo", Provider: "zz"}, {Name: "fails"}}
	m2, _ := New(bad, WithContainers(f, nil))
	if err := m2.Bootstrap(ctx); err == nil || !strings.Contains(err.Error(), "zz") || !strings.Contains(err.Error(), "up failed") {
		t.Errorf("Bootstrap reports every failure: %v", err)
	}
	f.fail = ""
	m3, _ := New(bad, WithContainers(f, nil), WithProviders(provider.NewRegistry()))
	if err := m3.Scale(ctx, "fails", 1); err == nil {
		t.Error("a create failure stops the scale")
	}
}

func TestStartInBackground(t *testing.T) {
	cfg := testConfig(t)
	f := newFake()
	m, err := New(cfg, WithContainers(f, nil))
	if err != nil {
		t.Fatal(err)
	}
	brain, _ := m.Create(context.Background(), Spec{Name: "brain", Desktop: new(bool)})
	if k, err := m.StartInBackground(brain.ID); err != nil || k.Status != kitty.StatusRunning {
		t.Errorf("a kitty without a desktop starts at once: %+v %v", k, err)
	}
	desk, _ := m.Create(context.Background(), Spec{Name: "desk"})
	k, err := m.StartInBackground(desk.Name)
	if err != nil || k.Status != kitty.StatusStarting {
		t.Fatalf("a desktop comes up in the background: %+v %v", k, err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if k, _ := m.Get(desk.ID); k.Status == kitty.StatusRunning {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the desktop never came up")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, err := m.StartInBackground("nobody"); err == nil {
		t.Error("an unknown kitty fails")
	}
	// A desktop still starting when the gateway stopped is started again on the next run.
	_ = m.setStatus(desk.ID, kitty.StatusStarting, "")
	m2, err := New(cfg, WithContainers(f, nil))
	if err != nil {
		t.Fatal(err)
	}
	if k, _ := m2.Get(desk.ID); k.Status != kitty.StatusRunning {
		t.Errorf("reloaded = %s", k.Status)
	}
}

func TestEditKeepsTheChange(t *testing.T) {
	m, err := New(testConfig(t), WithContainers(newFake(), nil))
	if err != nil {
		t.Fatal(err)
	}
	a, _ := m.Create(context.Background(), Spec{Name: "ana"})
	_, _ = m.Create(context.Background(), Spec{Name: "bo"})
	backup, tone := "bo", "dry"
	if _, err := m.Edit("ana", Update{Backup: &backup, Soul: &soul.Soul{Tone: tone}}); err != nil {
		t.Fatal(err)
	}
	k, _ := m.Get(a.ID)
	if k.Backup != "bo" || k.Soul.Tone != "dry" {
		t.Errorf("the edit was lost: %+v", k)
	}
	// What Get hands out is a copy: changing it changes nothing.
	k.Backup = "x"
	if again, _ := m.Get(a.ID); again.Backup != "bo" {
		t.Error("Get handed out the kitty itself")
	}
}
