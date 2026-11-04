// Package config reads and validates the kitties configuration: the AI providers available, the
// kitties to run, how their containers are built and where the gateway listens.
package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/madkoding/kitties/internal/agenda"
	"github.com/madkoding/kitties/internal/connector"
	"github.com/madkoding/kitties/internal/kitty"
	"github.com/madkoding/kitties/internal/notify"
	"github.com/madkoding/kitties/internal/provider"
	"github.com/madkoding/kitties/internal/soul"
	"github.com/madkoding/kitties/internal/yamlx"
)

// Config is the whole configuration file.
type Config struct {
	// DataDir is where the state (kitties, chats) is kept. Empty means ~/.kitties.
	DataDir string `yaml:"data_dir"`
	// Providers are the AI profiles a kitty can pick by name.
	Providers map[string]Provider `yaml:"providers"`
	// DefaultProvider is the profile a kitty uses when it names none.
	DefaultProvider string `yaml:"default_provider"`
	// Kitties are the bots to create on start.
	Kitties []Kitty `yaml:"kitties"`
	// Containers is how each kitty's isolated desktop is run.
	Containers Containers `yaml:"containers"`
	// Boat configures the remote desktop runtime; credentials are read from the environment.
	Boat Boat `yaml:"boat"`
	// Gateway is the HTTP API people and other programs talk to.
	Gateway Gateway `yaml:"gateway"`
	// Updates is when the automatic updates run and what Kitties does about a new version of itself.
	Updates Updates `yaml:"updates"`
	// Motita, when set, is the motita gateway kitties hand coding tasks to.
	Motita Motita `yaml:"motita"`
	// Connectors are the external services the kitties may use.
	Connectors map[string]Connector `yaml:"connectors"`
	// Notify says where the person is told, outside the interface, when a kitty needs them.
	Notify notify.Config `yaml:"notify"`
}

// Provider is one AI profile.
type Provider struct {
	Kind        string            `yaml:"kind" json:"kind"` // one of provider.Kinds()
	Model       string            `yaml:"model" json:"model"`
	APIKey      string            `yaml:"api_key" json:"api_key,omitempty"`
	APIKeyEnv   string            `yaml:"api_key_env" json:"api_key_env,omitempty"` // variable that holds the key, when not the provider's own
	BaseURL     string            `yaml:"base_url" json:"base_url,omitempty"`
	MaxTokens   int               `yaml:"max_tokens" json:"max_tokens,omitempty"`
	Temperature *float64          `yaml:"temperature" json:"temperature,omitempty"`
	Timeout     time.Duration     `yaml:"timeout" json:"timeout,omitempty"`
	MaxAttempts int               `yaml:"max_attempts" json:"max_attempts,omitempty"`
	Headers     map[string]string `yaml:"headers" json:"headers,omitempty"`
	// Tools is native (the provider's own calls, the default) or text (lines in the prompt).
	Tools string `yaml:"tools" json:"tools,omitempty"`
	// Auth is empty for a key, or login for an account signed in from Settings (a ChatGPT plan
	// for codex, GitHub Copilot, a Google login for gemini).
	Auth string `yaml:"auth" json:"auth,omitempty"`
}

// Options converts the profile into what the provider package takes.
func (p Provider) Options() provider.Options {
	key := p.APIKey
	if key == "" && p.APIKeyEnv != "" {
		key = os.Getenv(p.APIKeyEnv)
	}
	return provider.Options{
		Kind: p.Kind, Model: p.Model, APIKey: key, BaseURL: p.BaseURL, MaxTokens: p.MaxTokens,
		Temperature: p.Temperature, Timeout: p.Timeout, MaxAttempts: p.MaxAttempts, Headers: p.Headers, Tools: p.Tools, Auth: p.Auth,
	}
}

// Kitty is one bot of the fleet.
type Kitty struct {
	Name string `yaml:"name"`
	// Provider is the profile name; empty takes DefaultProvider.
	Provider string `yaml:"provider"`
	// Soul is the personality, inline; SoulFile points at a YAML file instead (both merge).
	Soul     soul.Soul `yaml:"soul"`
	SoulFile string    `yaml:"soul_file"`
	// Avatar is the pixel cat shown for it; empty parts are picked from the name.
	Avatar kitty.Avatar `yaml:"avatar"`
	// Connectors names the services this kitty may use. Empty means every configured one.
	Connectors []string `yaml:"connectors"`
	// Replicas is how many copies to run (name-1, name-2, ...). 0 and 1 mean one.
	Replicas int `yaml:"replicas"`
	// Desktop is false to run the kitty without a container (brain only).
	Desktop *bool `yaml:"desktop"`
	// Limits bound one task: tokens, seconds, rounds and retries. Zero fields take the defaults.
	Limits kitty.Limits `yaml:"limits"`
	// Backup names the kitty that takes over a task this one could not finish.
	Backup string `yaml:"backup"`
	// Approvals is ask (the default) or auto: see kitty.Kitty.
	Approvals string `yaml:"approvals"`
	// Goals are what the kitty pursues on its own: on a schedule, on events, or both.
	Goals []Goal `yaml:"goals"`
}

// Goal is a standing task of a kitty, from the configuration file.
type Goal struct {
	Title string `yaml:"title"`
	// Text is what the kitty is told each time; the title when empty.
	Text string `yaml:"text"`
	// Every is a cron expression (five fields, or @hourly, @daily, @weekly, @monthly).
	Every string `yaml:"every"`
	// On names the connectors whose incoming events run the goal.
	On []string `yaml:"on"`
}

// Containers is the container runtime block.
type Containers struct {
	// Runtime is docker, podman, auto, lima, or boat.
	Runtime string `yaml:"runtime"`
	// Image is the image every kitty runs: a headless X display (Xvfb) with a browser and the
	// usual desktop tools; see docker/kitty-desktop.
	Image string `yaml:"image"`
	// Network is the network the containers join. Empty is the runtime's default bridge.
	Network  string  `yaml:"network"`
	MemoryMB int     `yaml:"memory_mb"`
	CPUs     float64 `yaml:"cpus"`
	// Workspace is the host folder that holds one subfolder per kitty, mounted at /home/kitty/work.
	Workspace string `yaml:"workspace"`
	// Env is extra environment for every container.
	Env map[string]string `yaml:"env"`
	// AutoUpdate keeps the desktops on the newest image: the gateway looks for a new one every
	// UpdateCheckHours, downloads it, and makes a desktop anew (its sessions backed up and put back)
	// when its kitty is idle, or when a stopped one is started.
	AutoUpdate bool `yaml:"auto_update"`
	// UpdateCheckHours is how often the gateway looks for a newer image (6 by default).
	UpdateCheckHours int `yaml:"update_check_hours"`
}

// Boat configures persistent cloud desktops. API credentials never go into guest environment.
type Boat struct {
	APIKeyEnv    string `yaml:"api_key_env"`
	Size         string `yaml:"size"`
	MaxRunning   int    `yaml:"max_running"`
	IdleMinutes  int    `yaml:"idle_minutes"`
	TTLMinutes   int    `yaml:"ttl_minutes"`
	RenewMinutes int    `yaml:"renew_minutes"`
}

// Gateway is the HTTP API block. On a server it is also the web interface: the same address
// serves the page and the API.
type Gateway struct {
	Listen string `yaml:"listen"`
	Token  string `yaml:"token"`
	// PublicURL is the address people reach the gateway at from outside (https://kitties.example.com).
	// The OAuth sign-ins send the browser back to it, and its scheme tells the gateway it is
	// served over https.
	PublicURL string `yaml:"public_url"`
	// TLSCert and TLSKey, both or neither, make the gateway serve https itself; a proxy that
	// ends TLS (Caddy, nginx) is the other way.
	TLSCert string `yaml:"tls_cert"`
	TLSKey  string `yaml:"tls_key"`
	// TrustProxy says a reverse proxy sits in front and its X-Forwarded-* headers are true: the
	// client address (for the sign-in rate limit), the scheme and the host.
	TrustProxy bool `yaml:"trust_proxy"`
	// LocalToken says whether a client on this machine may fetch the token without typing it
	// (the desktop app and a local browser do). Unset, it is allowed only while the gateway
	// listens on this machine alone and no public_url or proxy is configured: a server never
	// hands its token out.
	LocalToken *bool `yaml:"local_token"`
}

// LocalTokenAllowed reports whether /v1/local-token may answer: the setting when given, else
// only for a gateway that listens on loopback and has no public address or proxy.
func (g Gateway) LocalTokenAllowed() bool {
	if g.LocalToken != nil {
		return *g.LocalToken
	}
	return IsLoopbackAddr(g.Listen) && g.PublicURL == "" && !g.TrustProxy && g.TLSCert == ""
}

// IsLoopbackAddr reports whether a listen address (host:port) is this machine alone.
func IsLoopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// ApplyEnv lets the environment override the gateway block, which is how a container is
// configured without a file: KITTIES_LISTEN, KITTIES_TOKEN, KITTIES_PUBLIC_URL and
// KITTIES_DATA_DIR, plus KITTIES_TRUST_PROXY (true) for a reverse proxy in front. The result is
// validated again.
func (c *Config) ApplyEnv(getenv func(string) string) error {
	if v := getenv("KITTIES_LISTEN"); v != "" {
		c.Gateway.Listen = v
	}
	if v := getenv("KITTIES_TOKEN"); v != "" {
		c.Gateway.Token = v
	}
	if v := getenv("KITTIES_PUBLIC_URL"); v != "" {
		c.Gateway.PublicURL = v
	}
	if v := getenv("KITTIES_DATA_DIR"); v != "" {
		c.DataDir = v
	}
	// A reverse proxy in front (Caddy, nginx, a load balancer) whose X-Forwarded-* headers are true.
	switch strings.ToLower(getenv("KITTIES_TRUST_PROXY")) {
	case "1", "true", "yes":
		c.Gateway.TrustProxy = true
	}
	return c.Validate()
}

// Motita points at a motita gateway.
type Motita struct {
	URL   string `yaml:"url"`
	Token string `yaml:"token"`
}

// Connector is one external service: a kind of the catalogue (connector.Catalog) and its
// settings. url, token, chat_id, command and headers are the common ones with a field of their
// own; anything else the kind needs goes in settings.
type Connector struct {
	Kind        string            `yaml:"kind" json:"kind"`
	Description string            `yaml:"description" json:"description,omitempty"`
	URL         string            `yaml:"url" json:"url,omitempty"`
	Token       string            `yaml:"token" json:"token,omitempty"`
	ChatID      string            `yaml:"chat_id" json:"chat_id,omitempty"`
	Command     string            `yaml:"command" json:"command,omitempty"`
	Headers     map[string]string `yaml:"headers" json:"headers,omitempty"`
	Settings    map[string]string `yaml:"settings" json:"settings,omitempty"`
}

// ConnectorSettings folds the connector into the settings its kind reads.
func (c Connector) ConnectorSettings() connector.Settings {
	s := connector.Settings{}
	for k, v := range c.Settings {
		s[k] = v
	}
	put := func(k, v string) {
		if v != "" {
			s[k] = v
		}
	}
	put("url", c.URL)
	put("token", c.Token)
	put("chat_id", c.ChatID)
	put("command", c.Command)
	if len(c.Headers) > 0 {
		var lines []string
		for k, v := range c.Headers {
			lines = append(lines, k+": "+v)
		}
		sort.Strings(lines)
		s["headers"] = strings.Join(lines, "\n")
	}
	return s
}

// ConnectorKinds are the values connectors.<name>.kind accepts.
var ConnectorKinds = func() []string {
	var out []string
	for _, k := range connector.Kinds() {
		out = append(out, k.Name)
	}
	return out
}()

// ValidateProvider checks one profile on its own, as the settings page saves it.
func ValidateProvider(name string, p Provider) error {
	if !ValidName(name) {
		return fmt.Errorf("providers.%s: a profile name is lowercase letters, digits and dashes", name)
	}
	kind, ok := provider.Lookup(p.Kind)
	if !ok {
		return fmt.Errorf("providers.%s.kind: %q is not one of %s", name, p.Kind, strings.Join(provider.Kinds(), ", "))
	}
	switch {
	case p.Auth != "" && p.Auth != provider.AuthLogin:
		return fmt.Errorf("providers.%s.auth: %q is not login (or empty, for a key)", name, p.Auth)
	case p.Auth == provider.AuthLogin && kind.Login == "":
		return fmt.Errorf("providers.%s.auth: %s has no account to sign in with, it takes an API key", name, p.Kind)
	}
	if p.APIKey != "" && strings.HasPrefix(strings.ToLower(p.BaseURL), "http://") && !isLocal(p.BaseURL) {
		return fmt.Errorf("providers.%s.base_url: plain http to a remote host would send the key in clear text", name)
	}
	if p.Tools != "" && p.Tools != "native" && p.Tools != "text" {
		return fmt.Errorf("providers.%s.tools: %q is not native or text", name, p.Tools)
	}
	return nil
}

// ValidateConnector checks one connector on its own. motitaURL is the shared motita block's URL.
func ValidateConnector(name string, cn Connector, motitaURL string) error {
	if !ValidName(name) {
		return fmt.Errorf("connectors.%s: a connector name is lowercase letters, digits and dashes", name)
	}
	kind, ok := connector.LookupKind(cn.Kind)
	if !ok {
		return fmt.Errorf("connectors.%s.kind: %q is not one of %s", name, cn.Kind, strings.Join(ConnectorKinds, ", "))
	}
	s := cn.ConnectorSettings()
	if cn.Kind == "motita" && s["url"] == "" {
		if motitaURL == "" {
			return fmt.Errorf("connectors.%s: motita needs a url (or the motita block)", name)
		}
		return nil
	}
	if err := kind.Validate(s); err != nil {
		return fmt.Errorf("connectors.%s: %v", name, err)
	}
	return nil
}

// Defaults is the configuration before the file is read.
func Defaults() Config {
	return Config{
		Providers: map[string]Provider{},
		Containers: Containers{
			Runtime: "auto", Image: "ghcr.io/madkoding/kitty-desktop:latest",
			MemoryMB: 2048, CPUs: 2, AutoUpdate: true, UpdateCheckHours: 6,
		},
		Boat:       Boat{APIKeyEnv: "BOAT_DEV_API_KEY", Size: "small", MaxRunning: 5, IdleMinutes: 15, TTLMinutes: 60, RenewMinutes: 5},
		Gateway:    Gateway{Listen: "127.0.0.1:7488"},
		Updates:    Updates{Gateway: UpdateNotify, CheckHours: 12, Repo: "madkoding/kitties", API: "https://api.github.com"},
		Connectors: map[string]Connector{},
	}
}

// Load reads the file at path over the defaults and validates it.
func Load(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read the configuration: %w", err)
	}
	return Parse(data)
}

// Parse reads YAML text over the defaults and validates it.
func Parse(data []byte) (Config, error) {
	cfg := Defaults()
	m, err := yamlx.ParseYAML(data)
	if err != nil {
		return Config{}, fmt.Errorf("the configuration is not valid YAML: %w", err)
	}
	if err := yamlx.Decode(m, &cfg); err != nil {
		return Config{}, err
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

var nameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,30}$`)

// ValidName reports whether a kitty or profile name can be used in a container name and a URL.
func ValidName(name string) bool { return nameRe.MatchString(name) }

// Validate checks the configuration.
func (c *Config) Validate() error {
	for name, p := range c.Providers {
		if err := ValidateProvider(name, p); err != nil {
			return err
		}
	}
	if c.DefaultProvider != "" {
		if _, ok := c.Providers[c.DefaultProvider]; !ok {
			return fmt.Errorf("default_provider %q is not a configured profile", c.DefaultProvider)
		}
	}
	seen := map[string]bool{}
	for i, k := range c.Kitties {
		if !ValidName(k.Name) {
			return fmt.Errorf("kitties[%d].name: %q is not a valid name (lowercase letters, digits and dashes)", i, k.Name)
		}
		if seen[k.Name] {
			return fmt.Errorf("kitties[%d].name: %q is used twice", i, k.Name)
		}
		seen[k.Name] = true
		if k.Provider != "" {
			if _, ok := c.Providers[k.Provider]; !ok {
				return fmt.Errorf("kitties[%d].provider: %q is not a configured profile", i, k.Provider)
			}
		} else if c.DefaultProvider == "" && len(c.Providers) != 1 {
			return fmt.Errorf("kitties[%d] (%s) names no provider and there is no default_provider", i, k.Name)
		}
		if _, err := k.Avatar.Normalize(k.Name); err != nil {
			return fmt.Errorf("kitties[%d].%v", i, err)
		}
		if k.Replicas < 0 || k.Replicas > 999 {
			return fmt.Errorf("kitties[%d].replicas: %d is not between 0 and 999", i, k.Replicas)
		}
		for _, cn := range k.Connectors {
			if _, ok := c.Connectors[cn]; !ok {
				return fmt.Errorf("kitties[%d].connectors: %q is not a configured connector", i, cn)
			}
		}
		if err := k.Limits.Validate(); err != nil {
			return fmt.Errorf("kitties[%d].%v", i, err)
		}
		if !kitty.ValidApprovals(k.Approvals) {
			return fmt.Errorf("kitties[%d].approvals: %q is not ask or auto", i, k.Approvals)
		}
		if k.Backup != "" {
			if k.Backup == k.Name {
				return fmt.Errorf("kitties[%d].backup: a kitty cannot back itself up", i)
			}
			if !c.hasKitty(k.Backup) {
				return fmt.Errorf("kitties[%d].backup: %q is not a configured kitty", i, k.Backup)
			}
		}
		for j, g := range k.Goals {
			if strings.TrimSpace(g.Title) == "" {
				return fmt.Errorf("kitties[%d].goals[%d]: a goal needs a title", i, j)
			}
			if strings.TrimSpace(g.Every) == "" && len(g.On) == 0 {
				return fmt.Errorf("kitties[%d].goals[%d] (%s): a goal runs on a schedule (every), on events (on), or both", i, j, g.Title)
			}
			if g.Every != "" {
				if _, err := agenda.Parse(g.Every); err != nil {
					return fmt.Errorf("kitties[%d].goals[%d] (%s): every: %v", i, j, g.Title, err)
				}
			}
			for _, cn := range g.On {
				if _, ok := c.Connectors[cn]; !ok {
					return fmt.Errorf("kitties[%d].goals[%d] (%s): on: %q is not a configured connector", i, j, g.Title, cn)
				}
			}
		}
	}
	switch c.Containers.Runtime {
	case "auto", "docker", "podman", "lima", "boat":
	default:
		return fmt.Errorf("containers.runtime: %q is not auto, docker, podman, lima or boat", c.Containers.Runtime)
	}
	if c.Containers.Image == "" {
		return errors.New("containers.image cannot be empty")
	}
	if (c.Containers.Runtime == "lima" || c.Containers.Runtime == "boat") && (c.Containers.Workspace != "" || c.Containers.Network != "") {
		return errors.New("VM desktops use a private guest disk and provider networking; containers.workspace and containers.network must be empty")
	}
	if c.Containers.Runtime == "boat" {
		if c.Boat.APIKeyEnv == "" {
			return errors.New("boat.api_key_env cannot be empty")
		}
		switch c.Boat.Size {
		case "small", "default", "large":
		default:
			return errors.New("boat.size must be small, default or large")
		}
		if c.Boat.MaxRunning < 1 || c.Boat.MaxRunning > 5 {
			return errors.New("boat.max_running must be between 1 and 5")
		}
		if c.Boat.IdleMinutes < 1 || c.Boat.TTLMinutes < 10 || c.Boat.RenewMinutes < 1 || c.Boat.RenewMinutes*2 >= c.Boat.TTLMinutes {
			return errors.New("boat: idle_minutes must be positive, ttl_minutes at least 10, and renew_minutes less than half the TTL")
		}
		if c.Gateway.LocalToken != nil && *c.Gateway.LocalToken {
			return errors.New("Boat gateways cannot enable gateway.local_token")
		}
		localToken := false
		c.Gateway.LocalToken = &localToken
		c.Containers.AutoUpdate = false
	}
	if err := c.Updates.validate(); err != nil {
		return err
	}
	if c.Containers.UpdateCheckHours < 1 || c.Containers.UpdateCheckHours > 24*30 {
		return errors.New("containers.update_check_hours is between 1 and 720")
	}
	if c.Containers.MemoryMB < 0 || c.Containers.CPUs < 0 {
		return errors.New("containers: memory_mb and cpus cannot be negative")
	}
	if c.Gateway.Listen == "" {
		return errors.New("gateway.listen cannot be empty")
	}
	if err := c.Notify.Validate(nil); err != nil {
		return err
	}
	if c.Notify.Connector != "" {
		if _, ok := c.Connectors[c.Notify.Connector]; !ok {
			return fmt.Errorf("notify.connector: %q is not a configured connector", c.Notify.Connector)
		}
	}
	if (c.Gateway.TLSCert == "") != (c.Gateway.TLSKey == "") {
		return errors.New("gateway.tls_cert and gateway.tls_key go together")
	}
	if u := c.Gateway.PublicURL; u != "" {
		parsed, err := url.Parse(u)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" {
			return fmt.Errorf("gateway.public_url %q must be an address like https://kitties.example.com (no path)", u)
		}
	}
	for name, cn := range c.Connectors {
		if err := ValidateConnector(name, cn, c.Motita.URL); err != nil {
			return err
		}
	}
	return nil
}

// hasKitty reports whether a kitty of that name is configured, replicas included (team-2).
func (c *Config) hasKitty(name string) bool {
	for _, k := range c.Kitties {
		if k.Name == name {
			return true
		}
		if k.Replicas > 1 && strings.HasPrefix(name, k.Name+"-") {
			if n, err := strconv.Atoi(strings.TrimPrefix(name, k.Name+"-")); err == nil && n >= 1 && n <= k.Replicas {
				return true
			}
		}
	}
	return false
}

// isLocal reports whether a URL points at this machine.
func isLocal(raw string) bool {
	rest := strings.TrimPrefix(strings.ToLower(raw), "http://")
	if i := strings.IndexByte(rest, '/'); i >= 0 {
		rest = rest[:i]
	}
	host := rest
	if strings.HasPrefix(rest, "[") {
		if i := strings.IndexByte(rest, ']'); i >= 0 {
			host = rest[:i+1]
		}
	} else if i := strings.IndexByte(rest, ':'); i >= 0 {
		host = rest[:i]
	}
	return host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "host.docker.internal"
}

// ProviderFor returns the profile name kitty k uses.
func (c *Config) ProviderFor(k Kitty) string {
	if k.Provider != "" {
		return k.Provider
	}
	if c.DefaultProvider != "" {
		return c.DefaultProvider
	}
	for name := range c.Providers {
		return name
	}
	return ""
}

// DataDirOr returns the data directory, or ~/.kitties.
func (c *Config) DataDirOr() string {
	if c.DataDir != "" {
		return c.DataDir
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ".kitties"
	}
	return filepath.Join(home, ".kitties")
}

// DefaultPath is where the configuration lives when no flag names one.
func DefaultPath() string {
	if p := os.Getenv("KITTIES_CONFIG"); p != "" {
		return p
	}
	if _, err := os.Stat("kitties.yaml"); err == nil {
		return "kitties.yaml"
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "kitties.yaml"
	}
	return filepath.Join(home, ".kitties", "kitties.yaml")
}
