// Package orchestrator manages the fleet: it creates kitties from the configuration or on
// demand, gives each one its brain (a provider client), its body (a container) and its
// connectors, and keeps the list on disk so a restart finds them again.
package orchestrator

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/madkoding/kitties/internal/computer"
	"github.com/madkoding/kitties/internal/config"
	"github.com/madkoding/kitties/internal/connector"
	"github.com/madkoding/kitties/internal/container"
	"github.com/madkoding/kitties/internal/kitty"
	"github.com/madkoding/kitties/internal/llmauth"
	"github.com/madkoding/kitties/internal/maintenance"
	"github.com/madkoding/kitties/internal/oauth"
	"github.com/madkoding/kitties/internal/provider"
	"github.com/madkoding/kitties/internal/soul"
	"github.com/madkoding/kitties/internal/statefs"
)

// Containers is what the orchestrator needs from the container package; a test fakes it.
type Containers interface {
	Up(ctx context.Context, s container.Spec) (string, error)
	Start(ctx context.Context, name string) error
	Stop(ctx context.Context, name string) error
	Remove(ctx context.Context, name string) error
	Exec(ctx context.Context, name string, argv ...string) (string, error)
	// Pull downloads the image again; ImageStale tells whether a container was made from an
	// older one than the reference names now.
	Pull(ctx context.Context, image string) error
	ImageStale(ctx context.Context, name, image string) (bool, error)
	// ExecInput is Exec with text on the command's input, for what must not show in its arguments.
	ExecInput(ctx context.Context, name, stdin string, argv ...string) (string, error)
	Screenshot(ctx context.Context, name string) ([]byte, error)
	// Stream follows the display: pictures to read with container.ReadFrame, until closed.
	Stream(ctx context.Context, name string, fps, quality int) (io.ReadCloser, error)
	List(ctx context.Context) ([]container.Info, error)
}

// ErrNotFound is returned for an unknown kitty.
var ErrNotFound = errors.New("no such kitty")

// Manager is the orchestrator.
type Manager struct {
	recoveryMu       sync.Mutex
	recoveryFreeze   recoveryFreeze
	admission        maintenance.Gate
	activityMu       sync.Mutex
	activity         map[string]int
	lastActivity     map[string]time.Time
	lastRenew        map[string]time.Time
	backgroundMu     sync.Mutex
	background       context.Context
	cancelBackground context.CancelFunc
	backgroundWG     sync.WaitGroup
	closing          bool
	opMu             sync.Mutex
	operations       map[string]chan struct{}
	cfg              config.Config
	providers        *provider.Registry
	connectors       *connector.Registry
	containers       Containers // nil when no runtime is available
	runtimeErr       error
	// rtMu guards containers and runtimeErr: a runtime found later (Docker Desktop opened after
	// the gateway) is set while the kitties work.
	rtMu sync.RWMutex
	// detect looks for the runtime again; nil when it is not looked for again.
	detect func(ctx context.Context) (Containers, error)
	// busyFn says whether a kitty is in the middle of a task (SetBusy).
	busyFn func(kittyID string) bool
	// keeper keeps the backups of what a kitty's browser knows (sessions.go), nil when there is none.
	keeper Keeper
	// holds are the displays the person has taken over, by kitty id, with their last use.
	holdMu        sync.Mutex
	holds         map[string]time.Time
	controls      map[string]*controlGrant
	prepared      map[string]computer.Reference
	controlEpoch  uint64
	controlFrozen bool
	// holdStarted is when the person last took each display, kept after they give it back.
	holdStarted map[string]time.Time

	mu      sync.RWMutex
	kitties map[string]*kitty.Kitty
	path    string
	// overlay is what the settings page changed; buildErrors says why a profile has no client.
	overlay     Settings
	buildErrors map[string]string
	// oauth signs the Google and Microsoft connectors in and keeps their tokens fresh.
	oauth *oauth.Manager
	// accounts are the AI sign-ins (ChatGPT, Copilot, Google) the profiles think on.
	accounts *llmauth.Manager
	now      func() time.Time
	newID    func() string
}

// Option tunes a manager.
type Option func(*Manager)

// WithContainers sets the container runtime (nil runs every kitty brain-only).
func WithContainers(c Containers, err error) Option {
	return func(m *Manager) {
		m.containers = c
		m.runtimeErr = err
	}
}

// WithRuntimeRetry looks for the container runtime again, while there is none, on every round
// of Watch and when a kitty is made: Docker Desktop opened after the gateway is found.
func WithRuntimeRetry(detect func(ctx context.Context) (Containers, error)) Option {
	return func(m *Manager) { m.detect = detect }
}

// WithProviders sets a prepared provider registry instead of building one from the configuration.
func WithProviders(r *provider.Registry) Option {
	return func(m *Manager) { m.providers = r }
}

// New builds the manager from cfg, building the providers and connectors it names.
func New(cfg config.Config, opts ...Option) (*Manager, error) {
	m := &Manager{
		cfg: cfg, connectors: connector.NewRegistry(), kitties: map[string]*kitty.Kitty{},
		path: filepath.Join(cfg.DataDirOr(), "kitties.json"), now: time.Now, newID: randomID,
		buildErrors: map[string]string{},
	}
	for _, o := range opts {
		o(m)
	}
	if !m.capabilities().ImageUpdates {
		m.cfg.Containers.AutoUpdate = false
	}
	m.oauth = oauth.New(m)
	m.accounts = llmauth.New(filepath.Join(cfg.DataDirOr(), "accounts"))
	if err := m.loadSettings(); err != nil {
		return nil, err
	}
	if m.providers == nil {
		m.providers = provider.NewRegistry()
		m.providers.SetLogin(m.accounts.Source)
		for name, p := range m.cfg.Providers {
			if err := m.providers.Build(name, p.Options()); err != nil {
				// A profile without its key is kept on the page, with the reason, instead of
				// stopping everything: the page is where the key gets typed.
				m.buildErrors[name] = err.Error()
			}
		}
	} else {
		m.providers.SetLogin(m.accounts.Source)
	}
	for name, c := range m.cfg.Connectors {
		m.connectors.Add(name, m.buildConnector(name, c))
	}
	if err := m.load(); err != nil {
		return nil, err
	}
	if err := m.loadRecoveryFreeze(); err != nil {
		return nil, err
	}
	return m, nil
}

// buildConnector makes the connector of one configured entry through the catalogue. An OAuth
// kind gets a token source bound to its name, so a refreshed token lands back in the settings.
// An entry that does not validate (it was checked before) falls back to a webhook, which never
// happens in practice.
func (m *Manager) buildConnector(name string, c config.Connector) connector.Connector {
	s := c.ConnectorSettings()
	if c.Kind == "motita" && s["url"] == "" {
		s["url"], s["token"] = m.cfg.Motita.URL, m.cfg.Motita.Token
	}
	if kind, ok := connector.LookupKind(c.Kind); ok && kind.OAuth != "" {
		s = connector.WithTokenSource(s, func(ctx context.Context) (string, error) { return m.oauth.Token(ctx, name) })
	}
	built, err := connector.Build(c.Kind, s, c.Description)
	if err != nil {
		return connector.Webhook{URL: s["url"], Description: c.Description}
	}
	return built
}

// Accounts is the sign-in manager of the AI profiles.
func (m *Manager) Accounts() *llmauth.Manager { return m.accounts }

// OAuth is the sign-in manager of the connectors.
func (m *Manager) OAuth() *oauth.Manager { return m.oauth }

// OAuthApp implements oauth.Store: the connector's identity service, OAuth app and settings.
func (m *Manager) OAuthApp(name string) (oauth.App, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	c, ok := m.cfg.Connectors[name]
	if !ok {
		return oauth.App{}, fmt.Errorf("%w: connector %q", ErrNotFound, name)
	}
	kind, ok := connector.LookupKind(c.Kind)
	if !ok || kind.OAuth == "" {
		return oauth.App{}, fmt.Errorf("connector %q does not sign in with OAuth", name)
	}
	s := c.ConnectorSettings()
	return oauth.App{Provider: kind.OAuth, Kind: c.Kind, ClientID: s["client_id"], ClientSecret: s["client_secret"], Settings: s}, nil
}

// SaveOAuthSettings implements oauth.Store: what a sign-in learned (an app it registered, a
// page, an account id) goes into the connector's settings.
func (m *Manager) SaveOAuthSettings(name string, learned map[string]string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.cfg.Connectors[name]
	if !ok {
		return fmt.Errorf("%w: connector %q", ErrNotFound, name)
	}
	settings := map[string]string{}
	for k, v := range c.Settings {
		settings[k] = v
	}
	// An empty value forgets the setting: a sign-in drops the token typed instead of it.
	for k, v := range learned {
		if v == "" {
			delete(settings, k)
			if k == "token" {
				c.Token = ""
			}
			continue
		}
		settings[k] = v
	}
	c.Settings = settings
	if m.overlay.Connectors == nil {
		m.overlay.Connectors = map[string]config.Connector{}
	}
	m.overlay.Connectors[name] = c
	m.cfg.Connectors[name] = c
	m.connectors.Add(name, m.buildConnector(name, c))
	return m.saveSettings()
}

// OAuthConnectors lists the connectors that sign in with OAuth, for the token refresh loop.
func (m *Manager) OAuthConnectors() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var names []string
	for name, c := range m.cfg.Connectors {
		if kind, ok := connector.LookupKind(c.Kind); ok && kind.OAuth != "" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

// tokenRefreshEvery is how often the signed-in connectors are checked for a token about to expire.
const tokenRefreshEvery = 5 * time.Minute

// KeepTokensFresh refreshes the OAuth tokens ahead of their expiry until ctx ends, so a
// kitty's first call after a quiet hour does not wait for a refresh or fail on a stale token.
// It runs in the caller's goroutine; warn hears about a refresh that failed.
func (m *Manager) KeepTokensFresh(ctx context.Context, warn func(format string, args ...any)) {
	m.oauth.KeepFresh(ctx, tokenRefreshEvery, m.OAuthConnectors, warn)
}

// OAuthCredentials implements oauth.Store.
func (m *Manager) OAuthCredentials(name string) (oauth.Credentials, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	c, ok := m.cfg.Connectors[name]
	if !ok {
		return oauth.Credentials{}, fmt.Errorf("%w: connector %q", ErrNotFound, name)
	}
	return oauth.FromSettings(c.ConnectorSettings()), nil
}

// SaveOAuthCredentials implements oauth.Store: the tokens go into the connector's settings.
func (m *Manager) SaveOAuthCredentials(name string, creds oauth.Credentials) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.cfg.Connectors[name]
	if !ok {
		return fmt.Errorf("%w: connector %q", ErrNotFound, name)
	}
	if c.Settings == nil {
		c.Settings = map[string]string{}
	}
	creds.ToSettings(c.Settings)
	if m.overlay.Connectors == nil {
		m.overlay.Connectors = map[string]config.Connector{}
	}
	m.overlay.Connectors[name] = c
	m.cfg.Connectors[name] = c
	m.connectors.Add(name, m.buildConnector(name, c))
	return m.saveSettings()
}

func randomID() string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// Config is the configuration the manager runs with.
func (m *Manager) Config() config.Config { return m.cfg }

// Providers is the provider registry.
func (m *Manager) Providers() *provider.Registry { return m.providers }

// Connectors is the connector registry.
func (m *Manager) Connectors() *connector.Registry { return m.connectors }

// HasContainers reports whether kitties can have a body, and why not otherwise.
func (m *Manager) HasContainers() (bool, error) {
	m.rtMu.RLock()
	defer m.rtMu.RUnlock()
	return m.containers != nil, m.runtimeErr
}

func (m *Manager) RuntimeName() string { return m.cfg.Containers.Runtime }

// ctr is the container runtime, nil when there is none.
func (m *Manager) ctr() Containers {
	m.rtMu.RLock()
	defer m.rtMu.RUnlock()
	return m.containers
}

// FindRuntime looks for the container runtime again when there is none and the manager may. When
// it is found, the kitties that wanted a body and could not have one get it, and those running
// are started in it. It reports whether a runtime was found now.
func (m *Manager) FindRuntime(ctx context.Context) bool {
	if m.detect == nil || m.ctr() != nil {
		return false
	}
	// A runtime that does not answer quickly is not there yet: the next round tries again.
	dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	c, err := m.detect(dctx)
	cancel()
	m.rtMu.Lock()
	if m.containers != nil {
		m.rtMu.Unlock()
		return false
	}
	if err != nil || c == nil {
		m.runtimeErr = err
		m.rtMu.Unlock()
		return false
	}
	m.containers, m.runtimeErr = c, nil
	m.rtMu.Unlock()

	m.mu.Lock()
	var running []string
	for _, k := range m.kitties {
		if !k.BodyLater {
			continue
		}
		k.BodyLater, k.Desktop = false, true
		k.Container = kitty.ContainerName(k.Name)
		k.Workspace = m.workspaceFor(k.Name)
		k.Computer.Runtime = m.capabilities().Kind
		if k.Status == kitty.StatusRunning {
			running = append(running, k.ID)
		}
	}
	_ = m.saveLocked()
	m.mu.Unlock()
	for _, id := range running {
		_ = m.Start(ctx, id)
	}
	return true
}

// --- persistence ---------------------------------------------------------------------------

func (m *Manager) load() error {
	data, err := os.ReadFile(m.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read the kitties: %w", err)
	}
	var list []*kitty.Kitty
	if err := json.Unmarshal(data, &list); err != nil {
		return fmt.Errorf("the kitties file is damaged (%s): %w", m.path, err)
	}
	for _, k := range list {
		// A desktop that was still coming up when the gateway stopped is started again.
		if k.Status == kitty.StatusStarting && k.Operation.Kind == "" {
			k.Status = kitty.StatusRunning
		}
		if err := m.migrateComputer(k); err != nil {
			return err
		}
		m.kitties[k.ID] = k
	}
	return m.saveLocked()
}

// saveLocked writes the list; the caller holds the lock.
func (m *Manager) saveLocked() error {
	list := m.sortedLocked()
	data, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	if err := statefs.MkdirAll(filepath.Dir(m.path), 0o700); err != nil {
		return fmt.Errorf("create the data folder: %w", err)
	}
	tmp := m.path + ".tmp"
	if err := statefs.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("save the kitties: %w", err)
	}
	return statefs.Rename(tmp, m.path)
}

func (m *Manager) sortedLocked() []*kitty.Kitty {
	list := make([]*kitty.Kitty, 0, len(m.kitties))
	for _, k := range m.kitties {
		list = append(list, k)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
	return list
}

// --- the fleet -----------------------------------------------------------------------------

// Spec is what a new kitty is made of.
type Spec struct {
	Name       string    `json:"name"`
	Provider   string    `json:"provider"`
	Soul       soul.Soul `json:"soul"`
	SoulFile   string    `json:"soul_file"`
	Connectors []string  `json:"connectors"`
	// Desktop is nil for the default (a container when a runtime exists).
	Desktop *bool `json:"desktop"`
	// Avatar is the pixel cat; empty parts come from the name.
	Avatar kitty.Avatar `json:"avatar"`
	// Limits bound one task; zero fields take the defaults.
	Limits kitty.Limits `json:"limits"`
	// Backup names the kitty that takes over a task this one gives up on.
	Backup string `json:"backup"`
	// Approvals is ask (or empty) or auto.
	Approvals string `json:"approvals"`
}

// Create adds a kitty. The container is created on Start.
func (m *Manager) Create(ctx context.Context, s Spec) (*kitty.Kitty, error) {
	if !config.ValidName(s.Name) {
		return nil, fmt.Errorf("%q is not a valid kitty name (lowercase letters, digits and dashes)", s.Name)
	}
	prov := s.Provider
	if prov == "" {
		m.mu.RLock()
		prov = m.cfg.ProviderFor(config.Kitty{})
		m.mu.RUnlock()
	}
	if err := m.usableModel(prov); err != nil {
		return nil, err
	}
	if err := m.knownConnections(s.Connectors); err != nil {
		return nil, err
	}
	avatar, err := s.Avatar.Normalize(s.Name)
	if err != nil {
		return nil, err
	}
	if err := s.Limits.Validate(); err != nil {
		return nil, err
	}
	if s.Backup == s.Name {
		return nil, errors.New("a kitty cannot back itself up")
	}
	if !kitty.ValidApprovals(s.Approvals) {
		return nil, fmt.Errorf("approvals %q is not ask or auto", s.Approvals)
	}
	personality := soul.Default(s.Name)
	if s.SoulFile != "" {
		fromFile, err := soul.Load(s.SoulFile)
		if err != nil {
			return nil, err
		}
		personality = soul.Merge(personality, fromFile)
	}
	personality = soul.Merge(personality, s.Soul)
	m.FindRuntime(ctx)
	wants := s.Desktop == nil || *s.Desktop
	desktop := wants && m.ctr() != nil

	m.mu.Lock()
	defer m.mu.Unlock()
	if _, taken := m.byNameLocked(s.Name); taken {
		return nil, fmt.Errorf("a kitty called %q already exists", s.Name)
	}
	k := &kitty.Kitty{
		ID: m.newID(), Name: s.Name, Provider: prov, Soul: personality, Connectors: s.Connectors,
		Desktop: desktop, BodyLater: wants && !desktop, Status: kitty.StatusCreated, CreatedAt: m.now(), Avatar: avatar,
		Limits: s.Limits, Backup: s.Backup, Approvals: s.Approvals, Availability: computer.Enabled,
	}
	if desktop {
		k.Container = kitty.ContainerName(s.Name)
		k.Workspace = m.workspaceFor(s.Name)
		k.Computer.Runtime = m.capabilities().Kind
	}
	m.kitties[k.ID] = k
	if err := m.saveLocked(); err != nil {
		delete(m.kitties, k.ID)
		return nil, err
	}
	return k, nil
}

// makeWorkspace creates a kitty's workspace so its container can write in it. The container's
// user (kitty, uid 1000) is seldom the gateway's (root, or uid 10001 in its image), so the
// folder itself is open to everyone, inside a root that is the gateway's alone (0700): no other
// user of the host reaches it.
func (m *Manager) makeWorkspace(dir string) error {
	if m.capabilities().GuestWorkspace {
		return nil
	}
	root := filepath.Dir(dir)
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	// The default root is Kitties' own: one made before by a looser umask is closed again.
	if m.cfg.Containers.Workspace == "" {
		if err := os.Chmod(root, 0o700); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return os.Chmod(dir, 0o777) //nolint:gosec // see above: the root keeps everyone else out
}

func (m *Manager) workspaceFor(name string) string {
	if m.capabilities().GuestWorkspace {
		return container.Workdir
	}
	return filepath.Join(m.workspaceRoot(), name)
}

func (m *Manager) workspaceRoot() string {
	if m.cfg.Containers.Workspace != "" {
		return m.cfg.Containers.Workspace
	}
	return filepath.Join(m.cfg.DataDirOr(), "work")
}

func (m *Manager) byNameLocked(name string) (*kitty.Kitty, bool) {
	for _, k := range m.kitties {
		if k.Name == name {
			return k, true
		}
	}
	return nil, false
}

// Get finds a kitty by id or name.
func (m *Manager) Get(ref string) (*kitty.Kitty, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	k, ok := m.kitties[ref]
	if !ok {
		k, ok = m.byNameLocked(ref)
	}
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrNotFound, ref)
	}
	// A copy: a desktop starting in the background changes the kitty while it is read.
	c := *k
	return &c, nil
}

// List returns every kitty, by name.
func (m *Manager) List() []*kitty.Kitty {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := m.sortedLocked()
	copies := make([]*kitty.Kitty, len(out))
	for i, k := range out {
		c := *k
		copies[i] = &c
	}
	return copies
}

// Bootstrap creates the kitties the configuration lists that do not exist yet, replicas
// included, and starts them.
func (m *Manager) Bootstrap(ctx context.Context) error {
	var errs []string
	for _, k := range m.cfg.Kitties {
		names := []string{k.Name}
		if k.Replicas > 1 {
			names = names[:0]
			for i := 1; i <= k.Replicas; i++ {
				names = append(names, fmt.Sprintf("%s-%d", k.Name, i))
			}
		}
		for _, name := range names {
			if _, err := m.Get(name); err == nil {
				continue
			}
			spec := Spec{Name: name, Provider: k.Provider, Soul: k.Soul, SoulFile: k.SoulFile, Connectors: k.Connectors, Desktop: k.Desktop, Avatar: k.Avatar, Limits: k.Limits, Backup: k.Backup, Approvals: k.Approvals}
			if spec.Soul.Name == "" {
				spec.Soul.Name = k.Name
			}
			created, err := m.Create(ctx, spec)
			if err != nil {
				errs = append(errs, err.Error())
				continue
			}
			if err := m.Start(ctx, created.ID); err != nil {
				errs = append(errs, err.Error())
			}
		}
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

// Start brings the kitty up: its container when it has one.
func (m *Manager) Start(ctx context.Context, ref string) error {
	ctx, release, admissionErr := m.admission.Enter(ctx)
	if admissionErr != nil {
		return admissionErr
	}
	defer release()
	k, err := m.Get(ref)
	if err != nil {
		return err
	}
	unlock, err := m.lockComputer(ctx, k.ID)
	if err != nil {
		return err
	}
	defer unlock()
	return m.startComputer(ctx, k.ID)
}

func (m *Manager) startComputer(ctx context.Context, ref string) error {
	k, err := m.Get(ref)
	if err != nil {
		return err
	}
	if m.capabilities().PersistentDisk && k.Operation.Kind != "" && k.Operation.Kind != "start" {
		return ErrDraining
	}
	if err := m.checkRuntime(k); err != nil {
		return m.fail(k.ID, err)
	}
	if err := m.beginOperation(k.ID, "start", computer.Enabled); err != nil {
		return err
	}
	if !k.Desktop {
		return m.finishOperation(k.ID, kitty.StatusRunning)
	}
	if err := m.makeWorkspace(k.Workspace); err != nil {
		return m.fail(k.ID, fmt.Errorf("create the workspace: %w", err))
	}
	exists, running, err := m.computerState(ctx, k)
	if err != nil {
		return m.fail(k.ID, err)
	}
	switch {
	case running:
		if m.capabilities().PersistentDisk {
			if err := m.ctr().Start(ctx, computerID(k)); err != nil {
				return m.fail(k.ID, err)
			}
		}
	case exists && !m.staleForAutoUpdate(ctx, k), m.capabilities().PersistentDisk && k.Computer.ID != "":
		// A missing persistent computer must be recovered by its runtime from known
		// durable state. Up would risk replacing the kitty's work with a blank disk.
		if err := m.ctr().Start(ctx, computerID(k)); err != nil {
			return m.fail(k.ID, err)
		}
	default:
		if exists {
			if err := m.ctr().Remove(ctx, computerID(k)); err != nil {
				return m.fail(k.ID, err)
			}
		}
		c := m.cfg.Containers
		spec := container.Spec{Name: k.Container, KittyName: k.Name, Image: c.Image, MemoryMB: c.MemoryMB, CPUs: c.CPUs, Network: c.Network, Workspace: k.Workspace, Env: c.Env}
		id, err := m.ctr().Up(ctx, spec)
		if err != nil {
			return m.fail(k.ID, err)
		}
		if err := m.rememberComputer(k.ID, computer.Reference{Runtime: m.capabilities().Kind, ID: id}); err != nil {
			return m.fail(k.ID, err)
		}
		k, _ = m.Get(k.ID)
		if !m.capabilities().PersistentDisk {
			m.restoreSessions(ctx, k)
		}
	}
	if err := m.refreshComputer(ctx, k); err != nil {
		return m.fail(k.ID, err)
	}
	k, _ = m.Get(k.ID)
	m.applyTheme(ctx, k, false)
	m.touch(k.ID)
	if err := m.finishOperation(k.ID, kitty.StatusRunning); err != nil {
		return err
	}
	m.holdMu.Lock()
	if m.prepared == nil {
		m.prepared = map[string]computer.Reference{}
	}
	m.prepared[k.ID] = k.Computer
	m.holdMu.Unlock()
	return nil
}

// startTimeout is how long a desktop may take to come up in the background: the first start
// downloads its image.
var startTimeout = 20 * time.Minute

// StartInBackground starts a kitty without making the caller wait for its desktop: a kitty with
// one is marked starting and comes up (or fails, with the reason on the kitty) on its own; one
// without is started at once.
func (m *Manager) StartInBackground(ref string) (*kitty.Kitty, error) {
	return m.LifecycleInBackground(ref, "start")
}

// Stop stops the kitty's container, keeping it.
func (m *Manager) Stop(ctx context.Context, ref string) error {
	return m.stop(ctx, ref, computer.Disabled)
}

func (m *Manager) stop(ctx context.Context, ref, availability string) error {
	ctx, release, admissionErr := m.admission.Enter(ctx)
	if admissionErr != nil {
		return admissionErr
	}
	defer release()
	k, err := m.Get(ref)
	if err != nil {
		return err
	}
	unlock, err := m.lockComputer(ctx, k.ID)
	if err != nil {
		return err
	}
	defer unlock()
	if err := m.beginOperationIntent(k.ID, "stop", availability, true); err != nil {
		return err
	}
	return m.stopComputer(ctx, k.ID, availability)
}

func (m *Manager) stopComputer(ctx context.Context, ref, availability string) error {
	k, err := m.Get(ref)
	if err != nil {
		return err
	}
	if err := m.checkRuntime(k); err != nil {
		return m.fail(k.ID, err)
	}
	if err := m.beginOperation(k.ID, "stop", availability); err != nil {
		return err
	}
	if err := m.drain(ctx, k.ID); err != nil {
		return m.fail(k.ID, err)
	}
	if k.Desktop {
		exists, running, err := m.computerState(ctx, k)
		if err != nil {
			return m.fail(k.ID, err)
		}
		if exists || m.capabilities().PersistentDisk && k.Computer.ID != "" {
			if running && !m.capabilities().PersistentDisk {
				m.saveSessions(ctx, k)
			}
			if err := m.ctr().Stop(ctx, computerID(k)); err != nil {
				return m.fail(k.ID, err)
			}
			if err := m.refreshComputer(ctx, k); err != nil {
				return m.fail(k.ID, err)
			}
		}
	}
	status := kitty.StatusStopped
	if availability == computer.Sleeping {
		status = kitty.StatusSleeping
	}
	return m.finishOperation(k.ID, status)
}

// Remove deletes a kitty and its live computer. Runtime recovery data follows
// the runtime's retention policy and is not implicitly purged.
func (m *Manager) Remove(ctx context.Context, ref string) error {
	ctx, release, admissionErr := m.admission.Enter(ctx)
	if admissionErr != nil {
		return admissionErr
	}
	defer release()
	k, err := m.Get(ref)
	if err != nil {
		return err
	}
	unlock, err := m.lockComputer(ctx, k.ID)
	if err != nil {
		return err
	}
	defer unlock()
	return m.removeComputer(ctx, k.ID)
}

func (m *Manager) removeComputer(ctx context.Context, ref string) error {
	k, err := m.Get(ref)
	if err != nil {
		return err
	}
	if err := m.checkRuntime(k); err != nil {
		return m.fail(k.ID, err)
	}
	if err := m.beginOperation(k.ID, "remove", computer.Disabled); err != nil {
		return err
	}
	if err := m.drain(ctx, k.ID); err != nil {
		return m.fail(k.ID, err)
	}
	if k.Desktop {
		exists, _, err := m.computerState(ctx, k)
		if err != nil {
			return m.fail(k.ID, err)
		}
		if exists || m.capabilities().PersistentDisk && k.Computer.ID != "" {
			if err := m.ctr().Remove(ctx, computerID(k)); err != nil {
				return m.fail(k.ID, err)
			}
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.kitties, k.ID)
	return m.saveLocked()
}

// Scale makes sure exactly n replicas of the configured kitty called name exist and run
// (name-1 ... name-n), creating and removing as needed.
func (m *Manager) Scale(ctx context.Context, name string, n int) error {
	if n < 0 || n > 999 {
		return fmt.Errorf("%d replicas is not between 0 and 999", n)
	}
	var base config.Kitty
	found := false
	for _, k := range m.cfg.Kitties {
		if k.Name == name {
			base, found = k, true
		}
	}
	if !found {
		return fmt.Errorf("%q is not a kitty of the configuration", name)
	}
	for _, k := range m.List() {
		if idx, ok := replicaIndex(k.Name, name); ok && idx > n {
			if err := m.Remove(ctx, k.ID); err != nil {
				return err
			}
		}
	}
	for i := 1; i <= n; i++ {
		replica := fmt.Sprintf("%s-%d", name, i)
		if _, err := m.Get(replica); err == nil {
			continue
		}
		spec := Spec{Name: replica, Provider: base.Provider, Soul: base.Soul, SoulFile: base.SoulFile, Connectors: base.Connectors, Desktop: base.Desktop, Avatar: base.Avatar}
		if spec.Soul.Name == "" {
			spec.Soul.Name = name
		}
		k, err := m.Create(ctx, spec)
		if err != nil {
			return err
		}
		if err := m.Start(ctx, k.ID); err != nil {
			return err
		}
	}
	return nil
}

func replicaIndex(full, base string) (int, bool) {
	rest, ok := strings.CutPrefix(full, base+"-")
	if !ok {
		return 0, false
	}
	n := 0
	for _, r := range rest {
		if r < '0' || r > '9' {
			return 0, false
		}
		n = n*10 + int(r-'0')
	}
	return n, rest != ""
}

func (m *Manager) setStatus(id, status, msg string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	k, ok := m.kitties[id]
	if !ok {
		return ErrNotFound
	}
	k.Status, k.Error = status, msg
	return m.saveLocked()
}

func (m *Manager) fail(id string, err error) error {
	m.invalidateControl(id, true)
	m.mu.Lock()
	defer m.mu.Unlock()
	if k, ok := m.kitties[id]; ok {
		k.Status, k.Error = kitty.StatusError, err.Error()
		if k.Operation.Kind != "" {
			k.Operation.Attempts++
			delay := min(time.Duration(1<<min(k.Operation.Attempts, 8))*time.Second, 5*time.Minute)
			k.Operation.RetryAt = m.now().Add(delay)
		}
		_ = m.saveLocked()
	}
	return err
}

// ErrNoModel is returned when a kitty needs a brain and none is set up.
var ErrNoModel = errors.New("there is no model yet: add one in Settings, Models, so the kitty has a brain to think with")

// usableModel says, in words a person can act on, why a kitty cannot think with the model
// called name, or nil when it can.
func (m *Manager) usableModel(name string) error {
	if name == "" {
		return ErrNoModel
	}
	if _, err := m.providers.Get(name); err != nil {
		m.mu.RLock()
		_, configured := m.cfg.Providers[name]
		why := m.buildErrors[name]
		m.mu.RUnlock()
		if !configured {
			return fmt.Errorf("there is no model called %q: pick one of Settings, Models", name)
		}
		if why == "" {
			why = err.Error()
		}
		return fmt.Errorf("the model %q cannot be used yet (%s): fix it in Settings, Models", name, why)
	}
	return nil
}

// knownConnections checks a kitty's list of connections: every name exists, or the list is just
// kitty.NoConnectors (none at all).
func (m *Manager) knownConnections(list []string) error {
	if len(list) == 1 && list[0] == kitty.NoConnectors {
		return nil
	}
	for _, c := range list {
		if _, ok := m.connectors.Get(c); !ok {
			return fmt.Errorf("there is no connection called %q", c)
		}
	}
	return nil
}

// Update is what can change on a kitty after it exists.
type Update struct {
	// Provider is the model the kitty thinks with.
	Provider *string `json:"provider,omitempty"`
	// Connectors are the connections the kitty may use, replacing the old list: empty is all of
	// them, [kitty.NoConnectors] is none.
	Connectors *[]string     `json:"connectors,omitempty"`
	Avatar     *kitty.Avatar `json:"avatar,omitempty"`
	Soul       *soul.Soul    `json:"soul,omitempty"`
	Limits     *kitty.Limits `json:"limits,omitempty"`
	// Backup is the kitty to hand tasks to; an empty string, when set, clears it.
	Backup *string `json:"backup,omitempty"`
	// Approvals is ask or auto (empty is ask).
	Approvals *string `json:"approvals,omitempty"`
	// Theme is the look of its desktop (kitty.Themes; empty is the image's own).
	Theme *string `json:"theme,omitempty"`
}

// Edit applies an update to a kitty and saves it. A new theme reaches a running desktop at once.
func (m *Manager) Edit(ref string, u Update) (*kitty.Kitty, error) {
	k, err := m.edit(ref, u)
	if err == nil && u.Theme != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		m.applyTheme(ctx, k, true)
	}
	return k, err
}

func (m *Manager) edit(ref string, u Update) (*kitty.Kitty, error) {
	k, err := m.Get(ref)
	if err != nil {
		return nil, err
	}
	if u.Provider != nil {
		if err := m.usableModel(*u.Provider); err != nil {
			return nil, err
		}
	}
	if u.Connectors != nil {
		if err := m.knownConnections(*u.Connectors); err != nil {
			return nil, err
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	// Get handed a copy: the change is made to the kitty itself.
	k, ok := m.kitties[k.ID]
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrNotFound, ref)
	}
	if u.Provider != nil {
		k.Provider = *u.Provider
	}
	if u.Connectors != nil {
		k.Connectors = append([]string{}, *u.Connectors...)
	}
	if u.Avatar != nil {
		avatar, err := u.Avatar.Normalize(k.Name)
		if err != nil {
			return nil, err
		}
		k.Avatar = avatar
	}
	if u.Soul != nil {
		k.Soul = soul.Merge(k.Soul, *u.Soul)
	}
	if u.Limits != nil {
		if err := u.Limits.Validate(); err != nil {
			return nil, err
		}
		k.Limits = *u.Limits
	}
	if u.Approvals != nil {
		if !kitty.ValidApprovals(*u.Approvals) {
			return nil, fmt.Errorf("approvals %q is not ask or auto", *u.Approvals)
		}
		k.Approvals = *u.Approvals
	}
	if u.Theme != nil {
		if !kitty.ValidTheme(*u.Theme) {
			return nil, fmt.Errorf("theme %q is not one of %s", *u.Theme, strings.Join(kitty.Themes, ", "))
		}
		k.Theme = *u.Theme
	}
	if u.Backup != nil {
		backup := strings.TrimSpace(*u.Backup)
		if backup != "" {
			other, ok := m.byNameLocked(backup)
			if !ok {
				if byID, found := m.kitties[backup]; found {
					other, ok = byID, true
				}
			}
			if !ok {
				return nil, fmt.Errorf("no such kitty %q to back %s up", backup, k.Name)
			}
			if other.ID == k.ID {
				return nil, errors.New("a kitty cannot back itself up")
			}
			backup = other.Name
		}
		k.Backup = backup
	}
	if err := m.saveLocked(); err != nil {
		return nil, err
	}
	c := *k
	return &c, nil
}

// Watch keeps the kitties up until ctx ends: every `every`, a running kitty whose container
// has stopped is started again, and a kitty in error is tried once more. recovered hears
// about each one brought back; warn about each one that could not be.
func (m *Manager) Watch(ctx context.Context, every time.Duration, recovered func(k *kitty.Kitty, what string), warn func(format string, args ...any)) {
	activityCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); m.watchActivity(activityCtx, warn) }()
	defer func() { cancel(); <-done }()
	for _, k := range m.List() {
		if k.ResumeAfterBackup {
			m.Check(ctx, recovered, warn)
			break
		}
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		m.Check(ctx, recovered, warn)
	}
}

// Check is one round of Watch.
func (m *Manager) Check(ctx context.Context, recovered func(k *kitty.Kitty, what string), warn func(format string, args ...any)) {
	ctx, release, admissionErr := m.admission.Enter(ctx)
	if admissionErr != nil {
		return
	}
	defer release()
	if m.FindRuntime(ctx) {
		warn("watchdog: the container engine answers now: the kitties get their desktops")
	}
	c := m.ctr()
	if c == nil {
		return
	}
	infos, err := c.List(ctx)
	if err != nil {
		warn("watchdog: %v", err)
		return
	}
	running := map[string]bool{}
	for _, i := range infos {
		running[i.Name] = i.Running
		if i.ID != "" {
			running[i.ID] = i.Running
		}
	}
	for _, k := range m.List() {
		changed, what, err := m.reconcileComputer(ctx, k.ID, running)
		if err != nil {
			if k.Status == kitty.StatusError {
				warn("watchdog: %s still fails: %v", k.Name, err)
			} else {
				warn("watchdog: %s: %v", k.Name, err)
			}
			continue
		}
		if changed {
			recovered(k, what)
		}
	}
}

func (m *Manager) reconcileComputer(ctx context.Context, id string, running map[string]bool) (bool, string, error) {
	if ctx.Err() != nil {
		return false, "", ctx.Err()
	}
	unlock, ok := m.tryLockComputer(id)
	if !ok {
		return false, "", nil
	}
	defer unlock()
	k, err := m.Get(id)
	if err != nil || !k.Desktop {
		return false, "", err
	}
	if k.Operation.RetryAt.After(m.now()) {
		return false, "", nil
	}
	ctx, cancel := context.WithTimeout(ctx, startTimeout)
	defer cancel()
	switch {
	case k.Operation.Kind == "remove":
		return true, "its pending removal completed", m.removeComputer(ctx, k.ID)
	case k.ResumeAfterBackup:
		return true, "its interrupted backup suspension ended", m.resumeBackupComputer(ctx, k.ID)
	case k.Operation.Kind == "stop":
		return true, "its pending stop completed", m.stopComputer(ctx, k.ID, k.Availability)
	case k.Availability == computer.Disabled || k.Availability == computer.Sleeping:
		return false, "", nil
	case k.Operation.Kind == "start":
		return true, "its pending start completed", m.startComputer(ctx, k.ID)
	case k.Status == kitty.StatusError:
		return true, "it was in error: " + k.Error, m.startComputer(ctx, k.ID)
	case k.Status == kitty.StatusRunning && !running[computerID(k)]:
		exists, awake, err := m.computerState(ctx, k)
		if err != nil {
			return false, "", err
		}
		if awake {
			return false, "", nil
		}
		what := "its container had stopped"
		if !exists {
			what = "its container was gone"
		}
		return true, what, m.startComputer(ctx, k.ID)
	}
	return false, "", nil
}

// InboundSecret is the secret a service must present to post events to a connector's hook
// (its inbound_secret setting); empty when the connector takes no events.
func (m *Manager) InboundSecret(name string) (string, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	c, ok := m.cfg.Connectors[name]
	if !ok {
		return "", fmt.Errorf("%w: connector %q", ErrNotFound, name)
	}
	return c.ConnectorSettings()["inbound_secret"], nil
}

// Brain returns the provider client the kitty thinks with.
func (m *Manager) Brain(k *kitty.Kitty) (provider.Client, error) {
	return m.providers.Get(k.Provider)
}

// Exec runs a command in the kitty's container.
func (m *Manager) Exec(ctx context.Context, ref string, argv ...string) (string, error) {
	k, err := m.Get(ref)
	if err != nil {
		return "", err
	}
	if !k.Desktop {
		return "", fmt.Errorf("%s has no container", k.Name)
	}
	if !computer.HasActivity(ctx, k.ID) {
		release, err := m.Acquire(ctx, k.ID)
		if err != nil {
			return "", err
		}
		defer release()
		k, err = m.Get(k.ID)
		if err != nil {
			return "", err
		}
	}
	return m.ctr().Exec(ctx, computerID(k), argv...)
}

// ExecInput runs a command in the kitty's container with text on its input.
func (m *Manager) ExecInput(ctx context.Context, ref, stdin string, argv ...string) (string, error) {
	k, err := m.Get(ref)
	if err != nil {
		return "", err
	}
	if !k.Desktop {
		return "", fmt.Errorf("%s has no container", k.Name)
	}
	if !computer.HasActivity(ctx, k.ID) {
		release, err := m.Acquire(ctx, k.ID)
		if err != nil {
			return "", err
		}
		defer release()
		k, err = m.Get(k.ID)
		if err != nil {
			return "", err
		}
	}
	return m.ctr().ExecInput(ctx, computerID(k), stdin, argv...)
}

// Screenshot captures the kitty's display.
func (m *Manager) Screenshot(ctx context.Context, ref string) ([]byte, error) {
	k, err := m.Get(ref)
	if err != nil {
		return nil, err
	}
	if !k.Desktop {
		return nil, fmt.Errorf("%s has no container", k.Name)
	}
	return m.ctr().Screenshot(ctx, computerID(k))
}

// StopAll stops every running kitty; used on shutdown when the operator asks for it.
func (m *Manager) StopAll(ctx context.Context) error {
	var errs []string
	for _, k := range m.List() {
		if k.Status == kitty.StatusRunning {
			if err := m.Stop(ctx, k.ID); err != nil {
				errs = append(errs, err.Error())
			}
		}
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}
