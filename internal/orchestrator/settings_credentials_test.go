package orchestrator

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/madkoding/kitties/internal/config"
	"github.com/madkoding/kitties/internal/provider"
)

func TestEnvironmentBackedProviderEditingSurvivesRepeatAndRestart(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("KITTIES_TEST_MODEL_KEY", "synthetic-environment-key")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer synthetic-environment-key" {
			t.Error("model request lost its environment-backed credential")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ready"}}]}`))
	}))
	defer server.Close()
	cfg := testConfig(t)
	cfg.Providers["cloud"] = config.Provider{Kind: "openai", Model: "gpt-5.4-mini", APIKeyEnv: "KITTIES_TEST_MODEL_KEY", BaseURL: server.URL}
	m, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	for _, model := range []string{"gpt-4.1-mini", "gpt-5.4-mini"} {
		if err := m.SetProvider("cloud", config.Provider{Kind: "openai", Model: model, BaseURL: server.URL}); err != nil {
			t.Fatal(err)
		}
		v := find(m.Settings().Providers, "cloud")
		if v == nil || !v.APIKeySet || v.APIKeyEnv != "KITTIES_TEST_MODEL_KEY" || v.Error != "" {
			t.Fatal("model editing discarded the configured environment reference")
		}
		if _, err := m.TestProvider(context.Background(), "cloud"); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(m.settingsPath())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "synthetic-environment-key") {
		t.Fatal("environment credential was copied into persistent settings")
	}
	again, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if v := find(again.Settings().Providers, "cloud"); v == nil || !v.APIKeySet || v.APIKeyEnv != "KITTIES_TEST_MODEL_KEY" {
		t.Fatal("restart lost the environment-backed model")
	}
	if _, err := again.TestProvider(context.Background(), "cloud"); err != nil {
		t.Fatal(err)
	}
}

func TestProviderKeyAvailabilityIncludesBuiltInEnvironmentFallback(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "synthetic-default-key")
	t.Setenv("KITTIES_TEST_EMPTY_KEY", "")
	m, err := New(testConfig(t))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	for _, ref := range []string{"", "KITTIES_TEST_EMPTY_KEY"} {
		if err := m.SetProvider("cloud", config.Provider{Kind: "openai", Model: "gpt-5.4-mini", APIKeyEnv: ref}); err != nil {
			t.Fatal(err)
		}
		v := find(m.Settings().Providers, "cloud")
		if v == nil || !v.APIKeySet || v.Error != "" {
			t.Fatal("Settings hides the credential fallback used by the real provider")
		}
	}
	t.Setenv("OPENAI_API_KEY", "")
	if find(m.Settings().Providers, "cloud").APIKeySet {
		t.Fatal("Settings advertises a missing environment credential")
	}
	if err := m.SetProvider("login", config.Provider{Kind: "codex", Auth: provider.AuthLogin, APIKey: "unused-key"}); err != nil {
		t.Fatal(err)
	}
	if find(m.Settings().Providers, "login").APIKeySet {
		t.Fatal("account authentication does not use its API key field")
	}
}

func TestProviderEditsDoNotReuseCredentialsAcrossKindsOrOverrideNewReferences(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("KITTIES_TEST_REPLACEMENT_KEY", "synthetic-replacement-key")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer synthetic-replacement-key" {
			t.Error("previous inline credential overrode the replacement environment reference")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ready"}}]}`))
	}))
	defer server.Close()
	m, err := New(testConfig(t))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	if err := m.SetProvider("cloud", config.Provider{Kind: "openai", Model: "gpt-5.4-mini", APIKey: "synthetic-old-key"}); err != nil {
		t.Fatal(err)
	}
	if err := m.SetProvider("cloud", config.Provider{Kind: "openai", Model: "gpt-5.4-mini", BaseURL: server.URL, APIKeyEnv: "KITTIES_TEST_REPLACEMENT_KEY"}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.TestProvider(context.Background(), "cloud"); err != nil {
		t.Fatal(err)
	}
	if err := m.SetProvider("cloud", config.Provider{Kind: "anthropic", Model: "claude-sonnet"}); err != nil {
		t.Fatal(err)
	}
	p := m.Config().Providers["cloud"]
	if p.APIKey != "" || p.APIKeyEnv != "" {
		t.Fatal("changing provider kind carried the previous provider's credentials")
	}
	if find(m.Settings().Providers, "cloud").APIKeySet {
		t.Fatal("changed provider kind falsely has a credential")
	}
}
