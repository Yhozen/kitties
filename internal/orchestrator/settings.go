package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/madkoding/kitties/internal/config"
	"github.com/madkoding/kitties/internal/connector"
	"github.com/madkoding/kitties/internal/kitty"
	"github.com/madkoding/kitties/internal/llmauth"
	"github.com/madkoding/kitties/internal/notify"
	"github.com/madkoding/kitties/internal/oauth"
	"github.com/madkoding/kitties/internal/provider"
	"github.com/madkoding/kitties/internal/statefs"
)

// Settings are what the interface can change at run time: the AI profiles and the connectors.
// They are kept in <data_dir>/settings.json on top of the configuration file, and win over it
// entry by entry, so a key typed in the page is never written back into the YAML.
type Settings struct {
	Providers       map[string]config.Provider  `json:"providers"`
	Connectors      map[string]config.Connector `json:"connectors"`
	DefaultProvider string                      `json:"default_provider,omitempty"`
	// Notify is where the person is told outside the interface; nil keeps the file's.
	Notify *notify.Config `json:"notify,omitempty"`
	// Removed names entries of the file the person deleted from the page.
	Removed struct {
		Providers  []string `json:"providers,omitempty"`
		Connectors []string `json:"connectors,omitempty"`
	} `json:"removed"`
}

func (m *Manager) settingsPath() string {
	return filepath.Join(filepath.Dir(m.path), "settings.json")
}

// loadSettings reads the overlay and merges it into the configuration.
func (m *Manager) loadSettings() error {
	data, err := os.ReadFile(m.settingsPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read the settings: %w", err)
	}
	var s Settings
	if err := json.Unmarshal(data, &s); err != nil {
		return fmt.Errorf("the settings file is damaged (%s): %w", m.settingsPath(), err)
	}
	m.overlay = s
	if m.cfg.Providers == nil {
		m.cfg.Providers = map[string]config.Provider{}
	}
	if m.cfg.Connectors == nil {
		m.cfg.Connectors = map[string]config.Connector{}
	}
	for _, n := range s.Removed.Providers {
		delete(m.cfg.Providers, n)
	}
	for _, n := range s.Removed.Connectors {
		delete(m.cfg.Connectors, n)
	}
	for n, p := range s.Providers {
		m.cfg.Providers[n] = p
	}
	for n, c := range s.Connectors {
		m.cfg.Connectors[n] = c
	}
	if s.DefaultProvider != "" {
		m.cfg.DefaultProvider = s.DefaultProvider
	}
	if s.Notify != nil {
		m.cfg.Notify = *s.Notify
	}
	return nil
}

// Notify is where the person is told, outside the interface, when a kitty needs them.
func (m *Manager) Notify() notify.Config {
	m.mu.RLock()
	defer m.mu.RUnlock()
	c := m.cfg.Notify
	c.On = append([]string(nil), c.On...)
	return c
}

// SetNotify chooses the connector notifications go through and which events are sent.
func (m *Manager) SetNotify(c notify.Config) error {
	if err := c.Validate(m.connectors); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cfg.Notify = c
	m.overlay.Notify = &c
	return m.saveSettings()
}

func (m *Manager) saveSettings() error {
	data, err := json.MarshalIndent(m.overlay, "", "  ")
	if err != nil {
		return err
	}
	if err := statefs.MkdirAll(filepath.Dir(m.settingsPath()), 0o700); err != nil {
		return fmt.Errorf("create the data folder: %w", err)
	}
	tmp := m.settingsPath() + ".tmp"
	if err := statefs.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("save the settings: %w", err)
	}
	return statefs.Rename(tmp, m.settingsPath())
}

func without(list []string, name string) []string {
	out := list[:0]
	for _, x := range list {
		if x != name {
			out = append(out, x)
		}
	}
	return out
}

// ProviderView is one AI profile as the page sees it: the key is never sent, only whether one is set.
type ProviderView struct {
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Model     string `json:"model"`
	BaseURL   string `json:"base_url,omitempty"`
	APIKeySet bool   `json:"api_key_set"`
	APIKeyEnv string `json:"api_key_env,omitempty"`
	// Auth is login when the profile thinks on a signed-in account instead of a key.
	Auth        string   `json:"auth,omitempty"`
	MaxTokens   int      `json:"max_tokens,omitempty"`
	Temperature *float64 `json:"temperature,omitempty"`
	Default     bool     `json:"default"`
	Describe    string   `json:"describe"`
	// FromFile is true when the profile comes from the YAML (an edit shadows it, a delete hides it).
	FromFile bool `json:"from_file"`
	// UsedBy names the kitties that think with it.
	UsedBy []string `json:"used_by,omitempty"`
	// Error says why the profile could not be built (a missing key), empty when it works.
	Error string `json:"error,omitempty"`
}

// ConnectorView is one connector as the page sees it: its settings with every secret field
// replaced by whether one is set.
type ConnectorView struct {
	Name        string            `json:"name"`
	Kind        string            `json:"kind"`
	Category    string            `json:"category"`
	Label       string            `json:"label"`
	Description string            `json:"description,omitempty"`
	URL         string            `json:"url,omitempty"`
	TokenSet    bool              `json:"token_set"`
	ChatID      string            `json:"chat_id,omitempty"`
	Command     string            `json:"command,omitempty"`
	Settings    map[string]string `json:"settings"`
	SecretsSet  []string          `json:"secrets_set"`
	FromFile    bool              `json:"from_file"`
	// OAuth is the identity service of the kind, and SignedIn/Account say whether a sign-in is
	// there. NeedsSignIn is set when the connector has neither a sign-in nor a token of its own.
	OAuth       string `json:"oauth,omitempty"`
	SignedIn    bool   `json:"signed_in,omitempty"`
	NeedsSignIn bool   `json:"needs_sign_in,omitempty"`
	Account     string `json:"account,omitempty"`
	// Auth says how one that signs in reaches its account: "sign-in", "keys" (X's OAuth 1.0
	// keys), "token" or "webhook". TokenExpires is when a typed token of a known lifetime stops
	// working (RFC 3339): X's OAuth 2.0 access token lasts two hours.
	Auth         string `json:"auth,omitempty"`
	TokenExpires string `json:"token_expires,omitempty"`
	// UsedBy names the kitties allowed to use it.
	UsedBy []string `json:"used_by,omitempty"`
}

// connectorView masks the secrets of one connector.
func connectorView(name string, c config.Connector, fromFile bool) ConnectorView {
	kind, _ := connector.LookupKind(c.Kind)
	all := c.ConnectorSettings()
	shown := map[string]string{}
	var secrets []string
	secret := map[string]bool{}
	for _, f := range kind.Fields {
		if f.Secret {
			secret[f.Name] = true
		}
	}
	for k, v := range all {
		if secret[k] || strings.HasPrefix(k, "oauth_") || k == connector.TokenSavedAt {
			if v != "" && secret[k] {
				secrets = append(secrets, k)
			}
			continue
		}
		shown[k] = v
	}
	sort.Strings(secrets)
	creds := oauth.FromSettings(all)
	signedIn := kind.OAuth != "" && creds.SignedIn()
	expires := ""
	if at, ok := kind.TokenExpiry(all); ok {
		expires = at.UTC().Format(time.RFC3339)
	}
	return ConnectorView{Name: name, Kind: c.Kind, Category: kind.Category, Label: kind.Label, Description: c.Description, URL: shown["url"],
		TokenSet: c.Token != "" || all["token"] != "", ChatID: c.ChatID, Command: c.Command, Settings: shown, SecretsSet: secrets, FromFile: fromFile,
		OAuth: kind.OAuth, SignedIn: signedIn, NeedsSignIn: kind.OAuth != "" && !creds.SignedIn() && !kind.KeySet(all), Account: creds.Account,
		Auth: kind.AuthOf(all, signedIn), TokenExpires: expires}
}

// usersLocked names, sorted, the kitties a test picks; callers hold the lock.
func (m *Manager) usersLocked(pick func(*kitty.Kitty) bool) []string {
	var names []string
	for _, k := range m.kitties {
		if pick(k) {
			names = append(names, k.Name)
		}
	}
	sort.Strings(names)
	return names
}

// SettingsView is the settings page.
type SettingsView struct {
	Providers       []ProviderView   `json:"providers"`
	Connectors      []ConnectorView  `json:"connectors"`
	DefaultProvider string           `json:"default_provider"`
	Kinds           []provider.Kind  `json:"kinds"`
	ConnectorKinds  []string         `json:"connector_kinds"`
	Catalog         []connector.Kind `json:"connector_catalog"`
	Categories      []string         `json:"connector_categories"`
	MotitaURL       string           `json:"motita_url,omitempty"`
	// Notify is where the person is told outside the interface, and NotifyEvents what can be sent.
	Notify       notify.Config `json:"notify"`
	NotifyEvents []string      `json:"notify_events"`
	// Accounts are the sign-ins a profile can think on instead of a key.
	Accounts []llmauth.Account `json:"accounts"`
	// OAuthReady are the services a connection signs in to without an app of the person's own
	// (Kitties was built with one, or the service needs none).
	OAuthReady []string `json:"oauth_ready"`
}

// Settings describes the profiles and connectors, secrets left out.
func (m *Manager) Settings() SettingsView {
	m.mu.RLock()
	defer m.mu.RUnlock()
	view := SettingsView{DefaultProvider: m.cfg.DefaultProvider, ConnectorKinds: config.ConnectorKinds, Catalog: connector.Kinds(),
		Categories: connector.Categories, MotitaURL: m.cfg.Motita.URL, Notify: m.cfg.Notify, Accounts: m.accounts.Accounts(), OAuthReady: []string{}}
	for name, p := range oauth.Providers {
		if p.Ready() {
			view.OAuthReady = append(view.OAuthReady, name)
		}
	}
	sort.Strings(view.OAuthReady)
	for _, e := range notify.Events {
		view.NotifyEvents = append(view.NotifyEvents, string(e))
	}
	if view.Notify.On == nil {
		view.Notify.On = []string{}
	}
	for _, k := range provider.Kinds() {
		kind, _ := provider.Lookup(k)
		view.Kinds = append(view.Kinds, kind)
	}
	names := make([]string, 0, len(m.cfg.Providers))
	for n := range m.cfg.Providers {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		p := m.cfg.Providers[n]
		_, fromOverlay := m.overlay.Providers[n]
		v := ProviderView{Name: n, Kind: p.Kind, Model: p.Model, BaseURL: p.BaseURL, APIKeySet: providerKeyAvailable(p),
			APIKeyEnv: p.APIKeyEnv, Auth: p.Auth, MaxTokens: p.MaxTokens, Temperature: p.Temperature, Default: n == m.cfg.DefaultProvider, FromFile: !fromOverlay}
		if c, err := m.providers.Get(n); err == nil {
			v.Describe = c.Describe()
		} else {
			v.Error = m.buildErrors[n]
			if v.Error == "" {
				v.Error = "not available"
			}
		}
		v.UsedBy = m.usersLocked(func(k *kitty.Kitty) bool { return k.Provider == n })
		view.Providers = append(view.Providers, v)
	}
	names = names[:0]
	for n := range m.cfg.Connectors {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		_, fromOverlay := m.overlay.Connectors[n]
		cv := connectorView(n, m.cfg.Connectors[n], !fromOverlay)
		cv.UsedBy = m.usersLocked(func(k *kitty.Kitty) bool { return len(k.Connectors) == 0 || contains(k.Connectors, n) })
		view.Connectors = append(view.Connectors, cv)
	}
	if view.Providers == nil {
		view.Providers = []ProviderView{}
	}
	if view.Connectors == nil {
		view.Connectors = []ConnectorView{}
	}
	return view
}

func providerKeyAvailable(p config.Provider) bool {
	if p.Auth == provider.AuthLogin {
		return false
	}
	if p.Options().APIKey != "" {
		return true
	}
	kind, ok := provider.Lookup(p.Kind)
	return ok && kind.KeyEnv != "" && os.Getenv(kind.KeyEnv) != ""
}

// SetProvider adds or replaces a profile, builds its client and saves the overlay. An empty key
// keeps the same provider kind's inline key or environment reference.
func (m *Manager) SetProvider(name string, p config.Provider) error {
	if err := config.ValidateProvider(name, p); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if p.APIKey == "" && p.APIKeyEnv == "" && p.Auth == "" {
		if old, ok := m.cfg.Providers[name]; ok && old.Kind == p.Kind && old.Auth == "" {
			p.APIKey, p.APIKeyEnv = old.APIKey, old.APIKeyEnv
		}
	}
	if m.overlay.Providers == nil {
		m.overlay.Providers = map[string]config.Provider{}
	}
	if m.cfg.Providers == nil {
		m.cfg.Providers = map[string]config.Provider{}
	}
	m.overlay.Providers[name] = p
	m.overlay.Removed.Providers = without(m.overlay.Removed.Providers, name)
	m.cfg.Providers[name] = p
	if m.cfg.DefaultProvider == "" {
		m.cfg.DefaultProvider, m.overlay.DefaultProvider = name, name
	}
	if err := m.providers.Build(name, p.Options()); err != nil {
		m.providers.Remove(name)
		m.buildErrors[name] = err.Error()
	} else {
		delete(m.buildErrors, name)
	}
	return m.saveSettings()
}

// RemoveProvider forgets a profile. A kitty that used it keeps the name and fails to answer
// until the profile comes back.
func (m *Manager) RemoveProvider(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.cfg.Providers[name]; !ok {
		return fmt.Errorf("%w: provider %q", ErrNotFound, name)
	}
	// The kitties that think with it move to another model; when there is none left, the
	// model stays, since they would have no brain at all.
	var users []*kitty.Kitty
	for _, k := range m.kitties {
		if k.Provider == name {
			users = append(users, k)
		}
	}
	other := ""
	if m.cfg.DefaultProvider != "" && m.cfg.DefaultProvider != name {
		if _, err := m.providers.Get(m.cfg.DefaultProvider); err == nil {
			other = m.cfg.DefaultProvider
		}
	}
	if other == "" {
		for _, n := range m.providers.Names() {
			if n != name {
				other = n
				break
			}
		}
	}
	if len(users) > 0 && other == "" {
		names := make([]string, 0, len(users))
		for _, k := range users {
			names = append(names, k.Name)
		}
		sort.Strings(names)
		return fmt.Errorf("%s still think with %q and it is the only model: add another model first, then remove this one", strings.Join(names, ", "), name)
	}
	for _, k := range users {
		k.Provider = other
	}
	if len(users) > 0 {
		if err := m.saveLocked(); err != nil {
			return err
		}
	}
	delete(m.cfg.Providers, name)
	delete(m.overlay.Providers, name)
	delete(m.buildErrors, name)
	m.providers.Remove(name)
	if !contains(m.overlay.Removed.Providers, name) {
		m.overlay.Removed.Providers = append(m.overlay.Removed.Providers, name)
	}
	if m.cfg.DefaultProvider == name {
		m.cfg.DefaultProvider = ""
		for _, n := range m.providers.Names() {
			m.cfg.DefaultProvider = n
			break
		}
		m.overlay.DefaultProvider = m.cfg.DefaultProvider
	}
	return m.saveSettings()
}

// SetDefaultProvider picks the profile a kitty uses when it names none.
func (m *Manager) SetDefaultProvider(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.cfg.Providers[name]; !ok {
		return fmt.Errorf("%w: provider %q", ErrNotFound, name)
	}
	m.cfg.DefaultProvider, m.overlay.DefaultProvider = name, name
	return m.saveSettings()
}

// TestProvider asks the profile for one short answer, to check a key and a model.
func (m *Manager) TestProvider(ctx context.Context, name string) (string, error) {
	c, err := m.providers.Get(name)
	if err != nil {
		m.mu.RLock()
		reason := m.buildErrors[name]
		m.mu.RUnlock()
		if reason != "" {
			return "", errors.New(reason)
		}
		return "", err
	}
	reply, err := c.Complete(ctx, []provider.Message{
		{Role: "system", Content: "Answer in at most five words."},
		{Role: "user", Content: "Say hello and your model name."},
	})
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(reply.Content), nil
}

// ErrUnsavedAddress is returned by ProviderModels for a server address that is neither the
// provider's own nor one already saved: the gateway only asks addresses it was configured with.
var ErrUnsavedAddress = errors.New("save the model first to list the models of a custom server address")

// ProviderModels checks the API key of a profile that is not saved yet, and lists the models it
// can use. Nothing is stored. An empty key falls back to the one saved under name, when that
// profile is of the same kind, so editing a profile does not ask for the key again. The address
// asked is the provider's own or the one saved under name, never one that only the page sent.
func (m *Manager) ProviderModels(ctx context.Context, name string, p config.Provider) ([]string, error) {
	// The options are built here from the kind, the key and an address chosen on the gateway
	// (the provider's own, or the saved one): nothing else the page sent is carried along, not
	// even the name of an environment variable to read the key from.
	opts := provider.Options{Kind: p.Kind, APIKey: p.APIKey}
	requested := strings.TrimRight(p.BaseURL, "/")
	m.mu.RLock()
	old, saved := m.cfg.Providers[name]
	m.mu.RUnlock()
	if saved && old.Kind == p.Kind {
		if opts.APIKey == "" {
			opts.APIKey = old.Options().APIKey
		}
		if requested != "" && requested == strings.TrimRight(old.BaseURL, "/") {
			opts.BaseURL, requested = old.BaseURL, ""
		}
	}
	if k, ok := provider.Lookup(p.Kind); ok && requested != "" && requested == strings.TrimRight(k.BaseURL, "/") {
		requested = ""
	}
	if requested != "" {
		return nil, ErrUnsavedAddress
	}
	return provider.ListModels(ctx, opts, nil)
}

// ConnectorChange says how a save treats what the connector had.
type ConnectorChange struct {
	// SigningIn lets a connector that signs in be saved without an account yet: the sign-in
	// comes next.
	SigningIn bool
	// Clear names the secrets to forget: an empty secret otherwise keeps the saved one, since
	// the page never sees it. SignOut is the name that forgets the account of a sign-in.
	Clear []string
}

// SignOut, in ConnectorChange.Clear, forgets the account a connector signed in with.
const SignOut = "sign_in"

// SetConnector adds or replaces a connector and saves the overlay. An empty secret keeps the one
// it had, unless the change clears it. A connector that signs in needs an account (the sign-in,
// or a key instead) unless the sign-in comes next.
func (m *Manager) SetConnector(name string, c config.Connector, change ConnectorChange) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if old, ok := m.cfg.Connectors[name]; ok && old.Kind == c.Kind {
		// An empty secret keeps the one the connector had.
		if c.Token == "" && !slices.Contains(change.Clear, "token") {
			c.Token = old.Token
		}
		kind, _ := connector.LookupKind(c.Kind)
		oldS := old.ConnectorSettings()
		keep := func(key string) {
			if slices.Contains(change.Clear, key) {
				return
			}
			if strings.TrimSpace(c.Settings[key]) == "" && oldS[key] != "" {
				if c.Settings == nil {
					c.Settings = map[string]string{}
				}
				c.Settings[key] = oldS[key]
			}
		}
		for _, f := range kind.Fields {
			if f.Secret {
				keep(f.Name)
			}
		}
		// A sign-in survives an edit of the other fields, unless it is the sign-out.
		if !slices.Contains(change.Clear, SignOut) {
			for _, key := range []string{oauth.KeyAccess, oauth.KeyRefresh, oauth.KeyExpiry, oauth.KeyAccount} {
				keep(key)
			}
		}
	}
	m.stampToken(name, &c)
	if err := config.ValidateConnector(name, c, m.cfg.Motita.URL); err != nil {
		return err
	}
	// A sign-out may leave it without an account: the person asked for it, and the page then
	// offers the sign-in again.
	if err := needsAccount(name, c, change.SigningIn || slices.Contains(change.Clear, SignOut)); err != nil {
		return err
	}
	if m.overlay.Connectors == nil {
		m.overlay.Connectors = map[string]config.Connector{}
	}
	if m.cfg.Connectors == nil {
		m.cfg.Connectors = map[string]config.Connector{}
	}
	m.overlay.Connectors[name] = c
	m.overlay.Removed.Connectors = without(m.overlay.Removed.Connectors, name)
	m.cfg.Connectors[name] = c
	m.connectors.Add(name, m.buildConnector(name, c))
	return m.saveSettings()
}

// stampToken keeps when a token of a known lifetime was typed: a new token is stamped now, the
// same one keeps its time, and none forgets it. Callers hold the lock.
func (m *Manager) stampToken(name string, c *config.Connector) {
	kind, _ := connector.LookupKind(c.Kind)
	if kind.TokenLifetime() == 0 {
		return
	}
	token := strings.TrimSpace(c.ConnectorSettings()["token"])
	var oldToken, oldAt string
	if old, ok := m.cfg.Connectors[name]; ok && old.Kind == c.Kind {
		s := old.ConnectorSettings()
		oldToken, oldAt = strings.TrimSpace(s["token"]), s[connector.TokenSavedAt]
	}
	if c.Settings == nil {
		c.Settings = map[string]string{}
	}
	switch {
	case token == "":
		delete(c.Settings, connector.TokenSavedAt)
	case token != oldToken || oldAt == "":
		c.Settings[connector.TokenSavedAt] = m.now().UTC().Format(time.RFC3339)
	default:
		c.Settings[connector.TokenSavedAt] = oldAt
	}
}

// TestConnector checks a connector's account with a request that only reads, and names the
// account when the service says it; connector.ErrNoCheck when it cannot be tested without acting.
func (m *Manager) TestConnector(ctx context.Context, name string) (string, error) {
	c, ok := m.connectors.Get(name)
	if !ok {
		return "", fmt.Errorf("%w: connector %q", ErrNotFound, name)
	}
	ch, ok := c.(connector.Checker)
	if !ok {
		return "", connector.ErrNoCheck
	}
	return ch.Check(ctx)
}

// needsAccount refuses a connector that signs in but has neither a sign-in nor a key: it would
// be saved, and fail at its first use.
func needsAccount(name string, c config.Connector, signingIn bool) error {
	kind, ok := connector.LookupKind(c.Kind)
	if !ok || kind.OAuth == "" || signingIn {
		return nil
	}
	s := c.ConnectorSettings()
	creds := oauth.FromSettings(s)
	if kind.KeySet(s) || creds.AccessToken != "" || creds.RefreshToken != "" {
		return nil
	}
	return fmt.Errorf("connectors.%s: %s needs a sign-in, or a key instead", name, kind.Label)
}

// RemoveConnector forgets a connector.
func (m *Manager) RemoveConnector(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.cfg.Connectors[name]; !ok {
		return fmt.Errorf("%w: connector %q", ErrNotFound, name)
	}
	delete(m.cfg.Connectors, name)
	delete(m.overlay.Connectors, name)
	m.connectors.Remove(name)
	if m.cfg.Notify.Connector == name {
		// Notifications cannot go through a connector that is gone: they are turned off.
		m.cfg.Notify = notify.Config{}
		m.overlay.Notify = &notify.Config{}
	}
	if !contains(m.overlay.Removed.Connectors, name) {
		m.overlay.Removed.Connectors = append(m.overlay.Removed.Connectors, name)
	}
	// The kitties lose it too. A kitty whose list held only this one keeps none (an empty list
	// would mean all of them).
	changed := false
	for _, k := range m.kitties {
		if !contains(k.Connectors, name) {
			continue
		}
		kept := make([]string, 0, len(k.Connectors))
		for _, c := range k.Connectors {
			if c != name {
				kept = append(kept, c)
			}
		}
		if len(kept) == 0 {
			kept = []string{kitty.NoConnectors}
		}
		k.Connectors, changed = kept, true
	}
	if changed {
		if err := m.saveLocked(); err != nil {
			return err
		}
	}
	return m.saveSettings()
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
