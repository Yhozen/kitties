package main

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madkoding/kitties/internal/statelock"
	"github.com/madkoding/kitties/internal/vault"
)

type cloudTransport func(*http.Request) (*http.Response, error)

func (f cloudTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestCloudStartupChecksSnapshotPolicyWithoutAllocatingCompute(t *testing.T) {
	t.Setenv("BOAT_DEV_API_KEY", "fixture-key")
	t.Setenv(vault.KeyEnv, "")
	for _, allowed := range []bool{false, true} {
		t.Run(map[bool]string{false: "disabled", true: "allowed"}[allowed], func(t *testing.T) {
			old := http.DefaultTransport
			defer func() { http.DefaultTransport = old }()
			calls := 0
			http.DefaultTransport = cloudTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.Method != "GET" || r.URL.Host != "boat.dev" {
					t.Fatalf("startup attempted side effect: %s %s", r.Method, r.URL)
				}
				body := ""
				switch r.URL.Path {
				case "/api/v1/account/data-retention":
					if allowed {
						body = `{"enabled":false}`
					} else {
						body = `{"enabled":true}`
					}
				case "/api/v1/saved-snapshots":
					body = `{"allowance":{"included":10}}`
				default:
					t.Fatalf("unexpected request %s", r.URL.Path)
				}
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
			})
			dir := t.TempDir()
			app := cloudApp(t, dir)
			err := app.open("ls")
			if allowed {
				if err != nil {
					t.Fatal(err)
				}
				if calls != 2 {
					t.Fatalf("readiness requests: %d", calls)
				}
				if len(app.fleet.List()) != 0 {
					t.Fatal("startup allocated a kitty")
				}
			} else if err == nil || !strings.Contains(err.Error(), "policy") {
				t.Fatalf("snapshot policy accepted: %v", err)
			}
			if err := app.close(); err != nil {
				t.Fatal(err)
			}
			lock, err := statelock.Acquire(dir)
			if err != nil {
				t.Fatal("startup leaked ownership lock")
			}
			lock.Close()
		})
	}
}

func TestCloudStartupRefusesDamagedStoresAndReleasesOwnership(t *testing.T) {
	t.Setenv(vault.KeyEnv, "")
	for _, file := range []string{"settings.json", "goals.json", "approvals.json", "budget.json", "recovery-backups.json", "chats"} {
		t.Run(file, func(t *testing.T) {
			dir := t.TempDir()
			if _, _, err := openCloudSecretStores(dir); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, file), []byte("{"), 0600); err != nil {
				t.Fatal(err)
			}
			app := cloudApp(t, dir)
			if err := app.open("providers"); err == nil {
				app.close()
				t.Fatal("damaged store accepted")
			}
			lock, err := statelock.Acquire(dir)
			if err != nil {
				t.Fatal("failed startup kept lock")
			}
			lock.Close()
		})
	}
}

func TestCloudCommandRequiresDedicatedCacheAndMatchingRestoreReceipt(t *testing.T) {
	_, endpoint := newGatewayStateService(t)
	t.Setenv("KITTIES_STATE_URL", endpoint)
	t.Setenv("KITTIES_DATA_DIR", "")
	if code, _, out := exec(t, "", "providers"); code != 1 || !strings.Contains(out, "explicit KITTIES_DATA_DIR") {
		t.Fatalf("missing cache: %d %s", code, out)
	}
	dir := filepath.Join(t.TempDir(), "cache")
	t.Setenv("KITTIES_DATA_DIR", dir)
	t.Setenv("KITTIES_STATE_URL", "http://external.example")
	if code, _, _ := exec(t, "", "providers"); code != 1 {
		t.Fatal("public unencrypted state accepted")
	}
	service, endpoint := newGatewayStateService(t)
	service.seed("existing.json", "old gateway")
	t.Setenv("KITTIES_STATE_URL", endpoint)
	t.Setenv("KITTIES_RESTORE_SNAPSHOT", strings.Repeat("a", 64))
	if code, _, out := exec(t, "", "providers"); code != 1 || !strings.Contains(out, "restore requires a fresh state") {
		t.Fatalf("unrelated restore: %d %s", code, out)
	}
	lock, err := statelock.Acquire(dir)
	if err != nil {
		t.Fatal("receipt failure retained cache lock")
	}
	lock.Close()
}

func TestGatewayTokenWritesArePrivateAndDoNotPartiallyReplaceCredentials(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "token")
	if err := saveGatewayToken(file, "original"); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(file)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("gateway token permissions")
	}
	if err := saveGatewayToken(filepath.Join(file, "child"), "replacement"); err == nil {
		t.Fatal("token parent conflict accepted")
	}
	data, err := os.ReadFile(file)
	if err != nil || string(data) != "original\n" {
		t.Fatal("failed write damaged existing token")
	}
	directory := filepath.Join(root, "directory")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := saveGatewayToken(directory, "replacement"); err == nil {
		t.Fatal("directory target accepted")
	}
	names, err := filepath.Glob(filepath.Join(root, ".gateway-token-*"))
	if err != nil || len(names) != 0 {
		t.Fatal("failed token write left staging secrets")
	}
	if os.Getuid() != 0 {
		locked := t.TempDir()
		if err := os.Chmod(locked, 0500); err != nil {
			t.Fatal(err)
		}
		defer os.Chmod(locked, 0700)
		if err := saveGatewayToken(filepath.Join(locked, "token"), "secret"); err == nil {
			t.Fatal("unwritable directory accepted")
		}
	}
}

func TestCloudKeyCheckFailureCannotResetEncryptionIdentity(t *testing.T) {
	t.Setenv(vault.KeyEnv, "")
	for _, name := range []string{"vault.key", "cloud.keycheck", "cloud.keycheck.tmp"} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			if name != "vault.key" {
				if _, _, err := openCloudSecretStores(dir); err != nil {
					t.Fatal(err)
				}
				os.Remove(filepath.Join(dir, "cloud.keycheck"))
			}
			if err := os.Mkdir(filepath.Join(dir, name), 0700); err != nil {
				t.Fatal(err)
			}
			if _, _, err := openCloudSecretStores(dir); err == nil {
				t.Fatal("invalid key storage accepted")
			}
		})
	}
	var output bytes.Buffer
	t.Setenv(vault.KeyEnv, "invalid")
	if v, k := openSecretStores(t.TempDir(), &output); v != nil || k != nil {
		t.Fatal("local invalid key accepted")
	}
	if output.Len() == 0 {
		t.Fatal("local unavailable secret store not reported")
	}
}
