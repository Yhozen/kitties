// Package oauth signs a connector in with OAuth 2.0 (authorization code with PKCE): a browser
// window to consent, the callback on the gateway, and a refresh token kept in the connector's
// settings so the kitties never ask again.
//
// Signing in is meant to be the easy way in, so the app it signs in through comes from the first
// place that has one: the connector's own settings (an app of the person's), the app Kitties was
// built with (Builtin), an app the service registers on the spot (Mastodon), or none at all
// (Home Assistant takes the gateway's own address as the app). Some services hand out a token
// that is not yet the one the connector needs; a provider's Finish turns it into that one (a
// Facebook Page's token) and fills in what the person would otherwise look up (the page, the
// account, the site).
package oauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/madkoding/kitties/internal/maintenance"
)

// HTTPDo sends a request; tests answer without a network.
type HTTPDo func(*http.Request) (*http.Response, error)

// Provider is one identity service.
type Provider struct {
	Name     string   `json:"name"`
	Label    string   `json:"label"`
	AuthURL  string   `json:"auth_url"`
	TokenURL string   `json:"token_url"`
	Scopes   []string `json:"scopes"`
	// Extra are query parameters the consent page needs (Google's offline access).
	Extra map[string]string `json:"-"`
	// ScopeSep joins the scopes in the consent URL; a space unless the service wants commas.
	ScopeSep string `json:"-"`
	// NoExpiry marks a service whose tokens last until revoked (Slack bots, GitHub OAuth
	// apps): an answer without expires_in is kept for good instead of an hour.
	NoExpiry bool `json:"-"`
	// Basic sends the client secret as HTTP Basic authentication instead of in the form.
	Basic bool `json:"-"`
	// JSONBody posts the token request as JSON (Notion) instead of a form.
	JSONBody bool `json:"-"`
	// Defaults fill the {url} or {subdomain} of the addresses when the settings leave them
	// empty (GitLab's own site).
	Defaults map[string]string `json:"-"`
	// SelfClient takes the gateway's own address as the app (Home Assistant's IndieAuth): no app
	// to register anywhere.
	SelfClient bool `json:"-"`
	// Register makes an app on the service when there is none (Mastodon lets anyone).
	Register func(ctx context.Context, do HTTPDo, app App, redirect string) (id, secret string, err error) `json:"-"`
	// Finish turns the service's answer into the token the connector uses, and says what it
	// learned for the settings (the page, the account id, the site).
	Finish func(ctx context.Context, do HTTPDo, app App, c Credentials) (Credentials, map[string]string, error) `json:"-"`
}

// Ready reports whether a person can sign in to the service without an app of their own.
func (p Provider) Ready() bool {
	id, _ := Builtin(p.Name)
	return id != "" || p.SelfClient || p.Register != nil
}

// address fills a provider address's {url} and {subdomain} from the settings.
func (p Provider) address(raw string, s map[string]string) (string, error) {
	out := raw
	for _, key := range []string{"url", "subdomain"} {
		ph := "{" + key + "}"
		if !strings.Contains(out, ph) {
			continue
		}
		v := strings.TrimRight(strings.TrimSpace(s[key]), "/")
		if v == "" {
			v = p.Defaults[key]
		}
		if v == "" {
			return "", fmt.Errorf("%s needs its %s before signing in", p.Label, key)
		}
		out = strings.ReplaceAll(out, ph, v)
	}
	return out, nil
}

// forever is how long a token without expiry is kept: until the service revokes it.
const forever = 100 * 365 * 24 * time.Hour

// builtin are the apps Kitties is built with, as "provider=id" or "provider=id:secret" pairs
// separated by commas: set at build time (-ldflags "-X .../oauth.builtin=spotify=abc,...") so
// a person signs in without making an app. Empty in a build that has none.
var builtin = ""

// Builtin is the app Kitties signs in to provider with when the connector names none:
// KITTIES_<PROVIDER>_CLIENT_ID (and _SECRET) on the gateway, else the one it was built with.
func Builtin(provider string) (id, secret string) {
	env := "KITTIES_" + strings.ToUpper(strings.ReplaceAll(provider, "-", "_"))
	if id := os.Getenv(env + "_CLIENT_ID"); id != "" {
		return id, os.Getenv(env + "_CLIENT_SECRET")
	}
	for _, pair := range strings.Split(builtin, ",") {
		name, value, ok := strings.Cut(strings.TrimSpace(pair), "=")
		if ok && name == provider {
			id, secret, _ = strings.Cut(value, ":")
			return id, secret
		}
	}
	return "", ""
}

// Credentials is what a signed-in connector holds, in its settings.
type Credentials struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	Expiry       time.Time `json:"expiry"`
	// Account is who signed in, when the service said.
	Account string `json:"account,omitempty"`
}

// Keys of the connector settings the credentials live in.
const (
	KeyAccess  = "oauth_access_token"
	KeyRefresh = "oauth_refresh_token"
	KeyExpiry  = "oauth_expiry"
	KeyAccount = "oauth_account"
)

// FromSettings reads the credentials kept in a connector's settings.
func FromSettings(s map[string]string) Credentials {
	c := Credentials{AccessToken: s[KeyAccess], RefreshToken: s[KeyRefresh], Account: s[KeyAccount]}
	if t, err := time.Parse(time.RFC3339, s[KeyExpiry]); err == nil {
		c.Expiry = t
	}
	return c
}

// ToSettings writes the credentials into a connector's settings.
func (c Credentials) ToSettings(s map[string]string) {
	s[KeyAccess] = c.AccessToken
	s[KeyRefresh] = c.RefreshToken
	s[KeyExpiry] = c.Expiry.UTC().Format(time.RFC3339)
	if c.Account != "" {
		s[KeyAccount] = c.Account
	}
}

// SignedIn reports whether a refresh token is there.
func (c Credentials) SignedIn() bool {
	return c.RefreshToken != "" || (c.AccessToken != "" && time.Now().Before(c.Expiry))
}

// App is what signing a connector in starts from: its identity service, its kind, the OAuth
// app it names (empty for none) and its settings.
type App struct {
	Provider, Kind         string
	ClientID, ClientSecret string
	Settings               map[string]string
}

// Store is where the gateway keeps a connector's credentials and app: the orchestrator's settings.
type Store interface {
	// OAuthApp returns the connector's sign-in.
	OAuthApp(connector string) (App, error)
	// OAuthCredentials returns what is saved for the connector.
	OAuthCredentials(connector string) (Credentials, error)
	// SaveOAuthCredentials keeps new credentials.
	SaveOAuthCredentials(connector string, c Credentials) error
	// SaveOAuthSettings keeps what a sign-in learned: an app it registered, a page, an id.
	SaveOAuthSettings(connector string, settings map[string]string) error
}

// Manager runs the flows.
type Manager struct {
	admission *maintenance.Gate
	store     Store
	mu        sync.Mutex
	// pending are the flows waiting for their callback, by state.
	pending map[string]flow
	now     func() time.Time
	httpDo  HTTPDo
	rand    func(n int) string
}

type flow struct {
	connector string
	provider  Provider
	verifier  string
	redirect  string
	started   time.Time
	// clientID and secret are the app the flow signs in with, wherever it came from.
	clientID, secret string
}

// New creates the manager over the store.
func New(store Store) *Manager {
	return &Manager{store: store, pending: map[string]flow{}, now: time.Now,
		httpDo: (&http.Client{Timeout: 30 * time.Second}).Do, rand: randomText}
}

func randomText(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// origin is the scheme and host of an address, with a slash: the gateway as an app.
func origin(redirect string) string {
	u, err := url.Parse(redirect)
	if err != nil {
		return redirect
	}
	return u.Scheme + "://" + u.Host + "/"
}

// client is the app a connector signs in with: its own, the gateway itself, the one Kitties was
// built with, or one the service registers now (kept in the settings for the next time).
// SetAdmission configures the backup barrier before background workers start.
func (m *Manager) SetAdmission(g *maintenance.Gate) { m.admission = g }

func (m *Manager) client(ctx context.Context, connector string, p Provider, app App, redirect string) (id, secret string, err error) {
	switch {
	case app.ClientID != "":
		return app.ClientID, app.ClientSecret, nil
	case p.SelfClient:
		return origin(redirect), "", nil
	}
	if id, secret := Builtin(p.Name); id != "" {
		return id, secret, nil
	}
	if p.Register == nil {
		return "", "", fmt.Errorf("signing in to %s needs an app: create one (its redirect address is %s) and put its client id in the connection, or paste a token instead", p.Label, redirect)
	}
	id, secret, err = p.Register(ctx, m.httpDo, app, redirect)
	if err != nil {
		return "", "", fmt.Errorf("%s did not register Kitties: %w", p.Label, err)
	}
	if err := m.store.SaveOAuthSettings(connector, map[string]string{"client_id": id, "client_secret": secret}); err != nil {
		return "", "", err
	}
	return id, secret, nil
}

// Start begins a sign-in for the connector and returns the consent URL to open.
func (m *Manager) Start(connector, redirect string) (string, error) {
	app, err := m.store.OAuthApp(connector)
	if err != nil {
		return "", err
	}
	p, ok := Providers[app.Provider]
	if !ok {
		return "", fmt.Errorf("%q has no OAuth flow", app.Provider)
	}
	authURL, err := p.address(p.AuthURL, app.Settings)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	clientID, secret, err := m.client(ctx, connector, p, app, redirect)
	if err != nil {
		return "", err
	}
	state := m.rand(24)
	verifier := m.rand(48)
	sum := sha256.Sum256([]byte(verifier))
	m.mu.Lock()
	for k, f := range m.pending {
		if m.now().Sub(f.started) > 15*time.Minute {
			delete(m.pending, k)
		}
	}
	m.pending[state] = flow{connector: connector, provider: p, verifier: verifier, redirect: redirect, started: m.now(), clientID: clientID, secret: secret}
	m.mu.Unlock()
	sep := p.ScopeSep
	if sep == "" {
		sep = " "
	}
	q := url.Values{
		"client_id": {clientID}, "redirect_uri": {redirect}, "response_type": {"code"},
		"state": {state}, "code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"},
	}
	if len(p.Scopes) > 0 {
		q.Set("scope", strings.Join(p.Scopes, sep))
	}
	for k, v := range p.Extra {
		q.Set(k, v)
	}
	return authURL + "?" + q.Encode(), nil
}

// Exchange finishes a sign-in with the code the callback received, and saves the credentials.
func (m *Manager) Exchange(ctx context.Context, state, code string) (string, error) {
	if m.admission != nil {
		admitted, release, err := m.admission.Enter(ctx)
		if err != nil {
			return "", err
		}
		defer release()
		ctx = admitted
	}
	m.mu.Lock()
	f, ok := m.pending[state]
	delete(m.pending, state)
	m.mu.Unlock()
	if !ok {
		return "", errors.New("unknown or expired sign-in; start again from Settings")
	}
	app, err := m.store.OAuthApp(f.connector)
	if err != nil {
		return "", err
	}
	values := map[string]string{"grant_type": "authorization_code", "code": code, "redirect_uri": f.redirect, "client_id": f.clientID, "code_verifier": f.verifier}
	creds, err := m.token(ctx, f.provider, app, f.secret, values)
	if err != nil {
		return "", err
	}
	learned := map[string]string{}
	if f.provider.Finish != nil {
		var more map[string]string
		if creds, more, err = f.provider.Finish(ctx, m.httpDo, app, creds); err != nil {
			return "", err
		}
		for k, v := range more {
			learned[k] = v
		}
	}
	if f.provider.SelfClient {
		// The gateway's address is the app: the refresh needs it again.
		learned["client_id"] = f.clientID
	}
	// The account signed in replaces a token typed before: a typed token would win over it,
	// and an old one fails.
	if strings.TrimSpace(app.Settings["token"]) != "" {
		learned["token"] = ""
	}
	if len(learned) > 0 {
		if err := m.store.SaveOAuthSettings(f.connector, learned); err != nil {
			return "", err
		}
	}
	if err := m.store.SaveOAuthCredentials(f.connector, creds); err != nil {
		return "", err
	}
	return f.connector, nil
}

// token posts a token request and reads the answer.
func (m *Manager) token(ctx context.Context, p Provider, app App, secret string, values map[string]string) (Credentials, error) {
	tokenURL, err := p.address(p.TokenURL, app.Settings)
	if err != nil {
		return Credentials{}, err
	}
	if secret != "" && !p.Basic {
		values["client_secret"] = secret
	}
	var body io.Reader
	ctype := "application/x-www-form-urlencoded"
	if p.JSONBody {
		data, _ := json.Marshal(values)
		body, ctype = strings.NewReader(string(data)), "application/json"
	} else {
		form := url.Values{}
		for k, v := range values {
			form.Set(k, v)
		}
		body = strings.NewReader(form.Encode())
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, body)
	if err != nil {
		return Credentials{}, err
	}
	req.Header.Set("Content-Type", ctype)
	// GitHub answers in form encoding unless asked for JSON; the others ignore the header.
	req.Header.Set("Accept", "application/json")
	if secret != "" && p.Basic {
		req.SetBasicAuth(values["client_id"], secret)
	}
	resp, err := m.httpDo(req)
	if err != nil {
		return Credentials{}, fmt.Errorf("%s did not answer: %w", p.Label, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var answer struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
		Error        any    `json:"error"`
		Description  string `json:"error_description"`
		// Team is the Slack workspace that installed the app, and WorkspaceName Notion's: the
		// account shown.
		Team struct {
			Name string `json:"name"`
		} `json:"team"`
		WorkspaceName string `json:"workspace_name"`
	}
	_ = json.Unmarshal(data, &answer)
	if resp.StatusCode >= 400 || (answer.Error != nil && answer.Error != false && answer.Error != "") {
		msg := answer.Description
		if msg == "" && answer.Error != nil {
			msg = fmt.Sprint(answer.Error)
		}
		if msg == "" {
			msg = strings.TrimSpace(string(data))
		}
		return Credentials{}, fmt.Errorf("%s refused: %s", p.Label, msg)
	}
	if answer.AccessToken == "" {
		return Credentials{}, fmt.Errorf("%s returned no token", p.Label)
	}
	ttl := time.Duration(answer.ExpiresIn) * time.Second
	switch {
	case answer.ExpiresIn > 0:
	case p.NoExpiry:
		ttl = forever
	default:
		ttl = time.Hour
	}
	account := answer.Team.Name
	if account == "" {
		account = answer.WorkspaceName
	}
	return Credentials{AccessToken: answer.AccessToken, RefreshToken: answer.RefreshToken, Expiry: m.now().Add(ttl), Account: account}, nil
}

// refreshAhead is how long before expiry a token is refreshed: before it fails, not after.
const refreshAhead = 10 * time.Minute

// Due reports whether the connector's token should be refreshed now: it is signed in with a
// refresh token and expires within refreshAhead.
func (m *Manager) Due(connector string) bool {
	creds, err := m.store.OAuthCredentials(connector)
	if err != nil || creds.RefreshToken == "" {
		return false
	}
	return !m.now().Add(refreshAhead).Before(creds.Expiry)
}

// KeepFresh refreshes, every `every`, the token of each connector that `names` lists and Due
// says is about to expire, until ctx ends. A refresh that fails is reported through warn and
// tried again on the next round; the connector itself refreshes on use as well.
func (m *Manager) KeepFresh(ctx context.Context, every time.Duration, names func() []string, warn func(format string, args ...any)) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		m.refreshDue(ctx, names(), warn)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (m *Manager) refreshDue(ctx context.Context, names []string, warn func(string, ...any)) {
	if m.admission != nil {
		admitted, release, err := m.admission.Enter(ctx)
		if err != nil {
			return
		}
		defer release()
		ctx = admitted
	}
	for _, name := range names {
		if !m.Due(name) {
			continue
		}
		creds, _ := m.store.OAuthCredentials(name)
		if _, err := m.refresh(ctx, name, creds); err != nil && warn != nil {
			warn("oauth: %s: %v", name, err)
		}
	}
}

// Token returns a valid access token for the connector, refreshing it when it is about to expire.
func (m *Manager) Token(ctx context.Context, connector string) (string, error) {
	creds, err := m.store.OAuthCredentials(connector)
	if err != nil {
		return "", err
	}
	if creds.AccessToken != "" && m.now().Add(time.Minute).Before(creds.Expiry) {
		return creds.AccessToken, nil
	}
	return m.refresh(ctx, connector, creds)
}

// refresh trades the refresh token for a new access token and saves it.
func (m *Manager) refresh(ctx context.Context, connector string, creds Credentials) (string, error) {
	if m.admission != nil {
		admitted, release, err := m.admission.Enter(ctx)
		if err != nil {
			return "", err
		}
		defer release()
		ctx = admitted
	}
	if creds.RefreshToken == "" {
		return "", errors.New("not signed in: connect the account from Settings")
	}
	app, err := m.store.OAuthApp(connector)
	if err != nil {
		return "", err
	}
	p, ok := Providers[app.Provider]
	if !ok {
		return "", fmt.Errorf("%q has no OAuth flow", app.Provider)
	}
	clientID, secret := app.ClientID, app.ClientSecret
	if clientID == "" {
		clientID, secret = Builtin(p.Name)
	}
	fresh, err := m.token(ctx, p, app, secret, map[string]string{"grant_type": "refresh_token", "refresh_token": creds.RefreshToken, "client_id": clientID})
	if err != nil {
		return "", err
	}
	if fresh.RefreshToken == "" {
		fresh.RefreshToken = creds.RefreshToken
	}
	fresh.Account = creds.Account
	if err := m.store.SaveOAuthCredentials(connector, fresh); err != nil {
		return "", err
	}
	return fresh.AccessToken, nil
}

// CallbackHTML is the page the browser shows once the sign-in landed.
const CallbackHTML = `<!doctype html><html><head><meta charset="utf-8"><title>Kitties</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#0a0a0f;color:#e8e8ea;font:16px system-ui,sans-serif}
.card{padding:28px 32px;border:1px solid rgba(0,240,255,.4);box-shadow:0 0 14px rgba(0,240,255,.25);text-align:center}h1{font-size:18px;margin:0 0 8px}p{color:#9a9aaa;margin:0}</style></head>
<body><div class="card"><h1>%s</h1><p>%s</p></div></body></html>`
