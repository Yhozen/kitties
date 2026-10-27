// Package provider talks to the AI services a kitty can think with.
//
// It is a dependency-free client in the spirit of motita's connectors: every provider is one of
// four API families, and every reply is normalised to plain text so the rest of the framework
// never knows which service answered.
//
//   - chat:       POST /chat/completions (Bearer): openai, ollama, ollama-cloud, groq, openrouter,
//     deepseek, qwen, mistral, copilot and any OpenAI-compatible server
//   - responses:  POST /responses (Bearer): codex and OpenAI GPT-6 Luna
//   - anthropic:  POST /v1/messages (x-api-key + anthropic-version)
//   - gemini:     POST /v1beta/models/<model>:generateContent (x-goog-api-key)
//   - cli:        the official `claude` program, on the person's own Claude subscription
//
// A profile signs in with a key, or with an account (Options.Auth "login"): a ChatGPT plan for
// codex, GitHub Copilot, a Google login for gemini. The account's credentials come from
// Options.Login on every request, so a token renewed in between is picked up.
package provider

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

// The API families.
const (
	FamilyChat      = "chat"
	FamilyResponses = "responses"
	FamilyAnthropic = "anthropic"
	FamilyGemini    = "gemini"
	FamilyCLI       = "cli"
)

// AuthLogin is the Options.Auth of a profile that signs in with an account instead of a key.
const AuthLogin = "login"

// Kind describes one supported provider: its family, where it lives and which variable holds its key.
type Kind struct {
	Name    string
	Family  string
	BaseURL string
	KeyEnv  string
	// NoKey is true for a service that runs without a key (a local Ollama).
	NoKey bool
	// DefaultModel is the model used when the profile names none.
	DefaultModel string
	// Login names the account a profile of this kind can sign in with instead of a key
	// (chatgpt, github, google, qwen, claude); empty when only a key works.
	Login string
}

// kinds is every provider the framework knows, keyed by name.
var kinds = map[string]Kind{
	"openai":       {Name: "openai", Family: FamilyChat, BaseURL: "https://api.openai.com/v1", KeyEnv: "OPENAI_API_KEY", DefaultModel: "gpt-5.5"},
	"codex":        {Name: "codex", Family: FamilyResponses, BaseURL: "https://api.openai.com/v1", KeyEnv: "OPENAI_API_KEY", DefaultModel: "gpt-5.5-codex", Login: "chatgpt"},
	"anthropic":    {Name: "anthropic", Family: FamilyAnthropic, BaseURL: "https://api.anthropic.com", KeyEnv: "ANTHROPIC_API_KEY", DefaultModel: "claude-sonnet-5-5"},
	"claude-code":  {Name: "claude-code", Family: FamilyCLI, NoKey: true, DefaultModel: "sonnet", Login: "claude"},
	"gemini":       {Name: "gemini", Family: FamilyGemini, BaseURL: "https://generativelanguage.googleapis.com", KeyEnv: "GEMINI_API_KEY", DefaultModel: "gemini-2.5-flash", Login: "google"},
	"ollama":       {Name: "ollama", Family: FamilyChat, BaseURL: "http://127.0.0.1:11434/v1", KeyEnv: "OLLAMA_API_KEY", NoKey: true, DefaultModel: "qwen3:8b"},
	"ollama-cloud": {Name: "ollama-cloud", Family: FamilyChat, BaseURL: "https://ollama.com/v1", KeyEnv: "OLLAMA_API_KEY", DefaultModel: "gpt-oss:120b"},
	"groq":         {Name: "groq", Family: FamilyChat, BaseURL: "https://api.groq.com/openai/v1", KeyEnv: "GROQ_API_KEY", DefaultModel: "llama-3.3-70b-versatile"},
	"openrouter":   {Name: "openrouter", Family: FamilyChat, BaseURL: "https://openrouter.ai/api/v1", KeyEnv: "OPENROUTER_API_KEY", DefaultModel: "openai/gpt-5.5"},
	"deepseek":     {Name: "deepseek", Family: FamilyChat, BaseURL: "https://api.deepseek.com/v1", KeyEnv: "DEEPSEEK_API_KEY", DefaultModel: "deepseek-chat"},
	"qwen":         {Name: "qwen", Family: FamilyChat, BaseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", KeyEnv: "DASHSCOPE_API_KEY", DefaultModel: "qwen-plus", Login: "qwen"},
	"mistral":      {Name: "mistral", Family: FamilyChat, BaseURL: "https://api.mistral.ai/v1", KeyEnv: "MISTRAL_API_KEY", DefaultModel: "mistral-large-latest"},
	"copilot":      {Name: "copilot", Family: FamilyChat, BaseURL: "https://api.githubcopilot.com", KeyEnv: "COPILOT_API_KEY", DefaultModel: "gpt-4.1", Login: "github"},
	"custom":       {Name: "custom", Family: FamilyChat, KeyEnv: "LLM_API_KEY", NoKey: true},
}

// Kinds lists the supported provider names, sorted.
func Kinds() []string {
	out := make([]string, 0, len(kinds))
	for k := range kinds {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Lookup returns the kind called name.
func Lookup(name string) (Kind, bool) {
	// The kind comes from the table, never from the text asked for, so what a caller sends
	// does not travel into the kind's address.
	want := strings.ToLower(strings.TrimSpace(name))
	for known, k := range kinds {
		if known == want {
			return k, true
		}
	}
	return Kind{}, false
}

// Options configures one client.
type Options struct {
	Kind        string
	Model       string
	APIKey      string
	BaseURL     string
	MaxTokens   int
	Temperature *float64
	Timeout     time.Duration
	MaxAttempts int
	Backoff     time.Duration
	// Headers are extra headers sent with every request (a gateway's own token, say).
	Headers map[string]string
	// Tools is how the model is given tools: "native" (the provider's own calls, the default)
	// or "text" (described in the prompt, called with @tool lines; for a server that has no
	// tool support).
	Tools string
	// Auth is "" (a key) or AuthLogin (an account signed in from Settings).
	Auth string
	// Login gives the signed-in account's credentials for one request; the registry sets it
	// for a profile whose Auth is AuthLogin.
	Login LoginSource
}

// Account is what a signed-in account adds to a request: where it goes, when not the kind's
// own address, and the headers that carry the credentials.
type Account struct {
	BaseURL string
	Headers map[string]string
	// ChatGPT marks a Codex request billed to a ChatGPT plan: the backend wants it streamed,
	// not stored and without an output cap.
	ChatGPT bool
}

// LoginSource returns the credentials of a signed-in account, renewed when they are about to
// expire.
type LoginSource func(ctx context.Context) (Account, error)

// ErrNotSignedIn is returned when a profile signs in with an account and none is there.
var ErrNotSignedIn = errors.New("not signed in")

// Message is one turn of a conversation.
type Message struct {
	Role    string `json:"role"` // system | user | assistant | tool
	Content string `json:"content"`
	// Images are pictures a user turn shows the model (a screenshot of the kitty's display).
	Images []Image `json:"images,omitempty"`
	// ToolCalls are the calls an assistant turn made, when the model called tools natively.
	ToolCalls []ToolCall `json:"tool_calls,omitempty"`
	// ToolCallID names the call a tool turn answers.
	ToolCallID string `json:"tool_call_id,omitempty"`
	// ToolName is the name of the call a tool turn answers (Gemini matches by name).
	ToolName string `json:"tool_name,omitempty"`
}

// Tool is one function the model may call natively.
type Tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"` // a JSON schema object
}

// ToolCall is one call the model made.
type ToolCall struct {
	ID   string         `json:"id"`
	Name string         `json:"name"`
	Args map[string]any `json:"args"`
}

// ToolClient is a client that can call tools natively, in the provider's own format.
type ToolClient interface {
	Client
	CompleteTools(ctx context.Context, messages []Message, tools []Tool) (Reply, error)
	// SupportsTools reports whether native calls are on for this client.
	SupportsTools() bool
}

// Image is one picture attached to a turn.
type Image struct {
	MIME string `json:"mime"` // image/png, image/jpeg
	Data []byte `json:"data"`
}

// dataURL renders the image as a data: URL.
func (i Image) dataURL() string {
	return "data:" + i.MIME + ";base64," + base64.StdEncoding.EncodeToString(i.Data)
}

// Usage counts the tokens of one reply, when the provider reported them.
type Usage struct {
	Input  int `json:"input"`
	Output int `json:"output"`
}

// Reply is a provider's answer.
type Reply struct {
	Content string `json:"content"`
	Usage   Usage  `json:"usage"`
	// Calls are the tools the model asked for, when it called them natively.
	Calls []ToolCall `json:"calls,omitempty"`
}

// Client is anything that can answer a conversation. The HTTP client below is the real one;
// tests and the group chat use fakes.
type Client interface {
	Complete(ctx context.Context, messages []Message) (Reply, error)
	// Describe names the provider and the model, for people.
	Describe() string
}

// HTTPClient is the client for every HTTP provider.
type HTTPClient struct {
	opts  Options
	kind  Kind
	http  *http.Client
	sleep func(time.Duration)
}

// HTTPError is a non-2xx answer.
type HTTPError struct {
	Code int
	Body string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("HTTP %d: %s", e.Code, clip(e.Body, 300))
}

// Retryable reports whether the status is worth another attempt.
func (e *HTTPError) Retryable() bool {
	return e.Code == http.StatusTooManyRequests || e.Code >= 500
}

// ErrNoKey is returned when a provider needs a key and none was given.
var ErrNoKey = errors.New("the API key is missing")

// New builds the client for opts, reading the key from the environment when none is set.
func New(opts Options) (*HTTPClient, error) {
	kind, ok := Lookup(opts.Kind)
	if !ok {
		return nil, fmt.Errorf("unsupported provider %q (one of %s)", opts.Kind, strings.Join(Kinds(), ", "))
	}
	if opts.APIKey == "" && kind.KeyEnv != "" {
		opts.APIKey = os.Getenv(kind.KeyEnv)
	}
	switch {
	case opts.Auth == AuthLogin:
		if kind.Login == "" {
			return nil, fmt.Errorf("%s has no account to sign in with: it takes an API key", kind.Name)
		}
		if opts.Login == nil {
			return nil, fmt.Errorf("%w to %s: sign in from Settings", ErrNotSignedIn, kind.Name)
		}
		opts.APIKey = ""
	case opts.APIKey == "" && !kind.NoKey:
		return nil, fmt.Errorf("%w for %s: set %s", ErrNoKey, kind.Name, kind.KeyEnv)
	}
	if opts.BaseURL == "" {
		opts.BaseURL = kind.BaseURL
	}
	if opts.BaseURL == "" {
		return nil, fmt.Errorf("provider %s needs a base_url", kind.Name)
	}
	opts.BaseURL = strings.TrimRight(opts.BaseURL, "/")
	if opts.Model == "" {
		opts.Model = kind.DefaultModel
	}
	if opts.Model == "" {
		return nil, fmt.Errorf("provider %s needs a model", kind.Name)
	}
	if opts.MaxTokens <= 0 {
		opts.MaxTokens = 4096
	}
	if opts.Timeout <= 0 {
		opts.Timeout = 120 * time.Second
	}
	if opts.MaxAttempts < 1 {
		opts.MaxAttempts = 3
	}
	if opts.Backoff <= 0 {
		opts.Backoff = time.Second
	}
	return &HTTPClient{
		opts:  opts,
		kind:  kind,
		http:  &http.Client{Timeout: opts.Timeout, Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}},
		sleep: time.Sleep,
	}, nil
}

// WithTransport sends every request through rt; tests use it to answer without a network.
func (c *HTTPClient) WithTransport(rt http.RoundTripper) *HTTPClient {
	c.http.Transport = rt
	return c
}

// Describe names the provider and model.
func (c *HTTPClient) Describe() string {
	return c.kind.Name + "/" + c.opts.Model
}

// Model is the configured model.
func (c *HTTPClient) Model() string { return c.opts.Model }

// SupportsTools reports whether this client calls tools natively.
func (c *HTTPClient) SupportsTools() bool { return c.opts.Tools != "text" }

// Complete sends the conversation and returns the answer, retrying what is worth retrying.
func (c *HTTPClient) Complete(ctx context.Context, messages []Message) (Reply, error) {
	return c.CompleteTools(ctx, messages, nil)
}

// CompleteTools sends the conversation with the tools the model may call.
func (c *HTTPClient) CompleteTools(ctx context.Context, messages []Message, tools []Tool) (Reply, error) {
	var last error
	wait := c.opts.Backoff
	for attempt := 1; attempt <= c.opts.MaxAttempts; attempt++ {
		reply, err := c.once(ctx, messages, tools)
		if err == nil {
			return reply, nil
		}
		last = err
		var he *HTTPError
		if errors.As(err, &he) && !he.Retryable() {
			return Reply{}, err
		}
		if ctx.Err() != nil || attempt == c.opts.MaxAttempts {
			break
		}
		c.sleep(wait)
		if wait < 30*time.Second {
			wait *= 2
		}
	}
	return Reply{}, fmt.Errorf("%s: %w", c.Describe(), last)
}

func (c *HTTPClient) once(ctx context.Context, messages []Message, tools []Tool) (Reply, error) {
	t, err := c.target(ctx)
	if err != nil {
		return Reply{}, err
	}
	if c.kind.Name == "openai" && isLunaModel(c.opts.Model) {
		return c.callResponses(ctx, t, messages, tools)
	}
	switch c.kind.Family {
	case FamilyAnthropic:
		return c.callAnthropic(ctx, t, messages, tools)
	case FamilyGemini:
		return c.callGemini(ctx, t, messages, tools)
	case FamilyResponses:
		return c.callResponses(ctx, t, messages, tools)
	default:
		return c.callChat(ctx, t, messages, tools)
	}
}

func isLunaModel(model string) bool {
	if model == "gpt-6-luna" {
		return true
	}
	date, snapshot := strings.CutPrefix(model, "gpt-6-luna-")
	if !snapshot {
		return false
	}
	_, err := time.Parse(time.DateOnly, date)
	return err == nil
}

// target is where one request goes and the headers that carry its credentials.
type target struct {
	base    string
	headers map[string]string
	chatgpt bool
}

// target resolves the request's address and credentials: the key's headers, or the signed-in
// account's. An account that cannot be used is answered as a 401, which is not retried.
func (c *HTTPClient) target(ctx context.Context) (target, error) {
	t := target{base: c.opts.BaseURL, headers: map[string]string{}}
	if c.opts.Login != nil {
		acc, err := c.opts.Login(ctx)
		if err != nil {
			return t, &HTTPError{Code: http.StatusUnauthorized, Body: err.Error()}
		}
		if acc.BaseURL != "" {
			t.base = strings.TrimRight(acc.BaseURL, "/")
		}
		for k, v := range acc.Headers {
			t.headers[k] = v
		}
		t.chatgpt = acc.ChatGPT
		return t, nil
	}
	switch c.kind.Family {
	case FamilyAnthropic:
		t.headers["x-api-key"] = c.opts.APIKey
		t.headers["anthropic-version"] = "2023-06-01"
	case FamilyGemini:
		t.headers["x-goog-api-key"] = c.opts.APIKey
	default:
		if c.opts.APIKey != "" {
			t.headers["Authorization"] = "Bearer " + c.opts.APIKey
		}
	}
	return t, nil
}

// argsOf decodes a call's arguments, which arrive as a JSON string or an object.
func argsOf(raw any) map[string]any {
	switch v := raw.(type) {
	case map[string]any:
		return v
	case string:
		var m map[string]any
		if json.Unmarshal([]byte(v), &m) == nil && m != nil {
			return m
		}
		if strings.TrimSpace(v) != "" {
			return map[string]any{"text": v}
		}
	}
	return map[string]any{}
}

func argsJSON(args map[string]any) string {
	if args == nil {
		args = map[string]any{}
	}
	data, _ := json.Marshal(args)
	return string(data)
}

// emptyReply reports a reply with neither text nor calls.
func emptyReply(r Reply) bool { return r.Content == "" && len(r.Calls) == 0 }

// post sends a JSON body to t and returns the answer's bytes.
func (c *HTTPClient) post(ctx context.Context, t target, path string, body any) ([]byte, error) {
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(body); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.base+path, &buf)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "kitties")
	for k, v := range t.headers {
		req.Header.Set(k, v)
	}
	for k, v := range c.opts.Headers {
		req.Header.Set(k, v)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &HTTPError{Code: resp.StatusCode, Body: string(data)}
	}
	return data, nil
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// temperature is the configured temperature, or def.
func (c *HTTPClient) temperature(def float64) float64 {
	if c.opts.Temperature != nil {
		return *c.opts.Temperature
	}
	return def
}

// splitSystem separates the system turns (joined) from the conversation.
func splitSystem(messages []Message) (string, []Message) {
	var system []string
	rest := make([]Message, 0, len(messages))
	for _, m := range messages {
		if m.Role == "system" {
			if strings.TrimSpace(m.Content) != "" {
				system = append(system, m.Content)
			}
			continue
		}
		rest = append(rest, m)
	}
	return strings.Join(system, "\n\n"), rest
}
