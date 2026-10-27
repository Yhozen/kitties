package main

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madkoding/kitties/internal/backup"
	"github.com/madkoding/kitties/internal/config"
	"github.com/madkoding/kitties/internal/statefs"
	"github.com/madkoding/kitties/internal/vault"
)

func recoveryRepository(t *testing.T, amend ...func(string)) (string, string) {
	t.Helper()
	if _, err := osexec.LookPath("restic"); err != nil {
		t.Skip("restic is not installed")
	}
	key := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{23}, 32))
	t.Setenv(vault.KeyEnv, key)
	t.Setenv("RESTIC_REPOSITORY", filepath.Join(t.TempDir(), "repository"))
	t.Setenv("RESTIC_PASSWORD", "fixture-restic-password")
	t.Setenv("RESTIC_CACHE_DIR", t.TempDir())
	source := t.TempDir()
	v, _, err := openCloudSecretStores(source)
	mustCloudState(t, err)
	mustCloudState(t, v.Put("fixture", "original-secret", []string{"mimi"}))
	stage := t.TempDir()
	mustCloudState(t, statefs.Snapshot(context.Background(), source, filepath.Join(stage, "gateway")))
	raw, _ := json.Marshal(map[string]string{vault.KeyEnv: key})
	mustCloudState(t, os.WriteFile(filepath.Join(stage, "bootstrap-secrets.json"), raw, 0o600))
	mustCloudState(t, os.WriteFile(filepath.Join(stage, "manifest.json"), []byte(`{"version":1,"homes":[]}`), 0o600))
	mustCloudState(t, os.MkdirAll(filepath.Join(stage, "computers", "mimi", "home"), 0o700))
	mustCloudState(t, os.WriteFile(filepath.Join(stage, "computers", "mimi", "home", "file"), []byte("portable home"), 0o600))
	mustCloudState(t, os.MkdirAll(filepath.Join(stage, "configuration"), 0o700))
	mustCloudState(t, os.WriteFile(filepath.Join(stage, "configuration", "kitties.yaml"), []byte("containers:\n  runtime: boat\nproviders:\n  file-only:\n    kind: openai\n    model: fixture\nkitties:\n  - name: mimi\n    provider: file-only\n    desktop: false\n    goals:\n      - title: Saved schedule\n        every: '@daily'\n"), 0o600))
	for _, edit := range amend {
		edit(stage)
	}
	var archive bytes.Buffer
	writer := tar.NewWriter(&archive)
	mustCloudState(t, backup.AppendDirectory(context.Background(), writer, stage))
	mustCloudState(t, writer.Close())
	if out, err := osexec.Command("restic", "init").CombinedOutput(); err != nil {
		t.Fatalf("init fixture: %v %s", err, out)
	}
	cmd := osexec.Command("restic", "backup", "--json", "--stdin", "--stdin-filename", "recovery.tar", "--host", backup.Host, "--tag", backup.Tag)
	cmd.Stdin = &archive
	out, err := cmd.Output()
	mustCloudState(t, err)
	for _, line := range bytes.Split(out, []byte("\n")) {
		var summary struct {
			ID string `json:"snapshot_id"`
		}
		if json.Unmarshal(line, &summary) == nil && summary.ID != "" {
			return summary.ID, key
		}
	}
	t.Fatal("fixture snapshot was not acknowledged")
	return "", ""
}

func TestCloudRecoveryRequiresStableKeyAndImportsExactlyOnce(t *testing.T) {
	snapshot, key := recoveryRepository(t)
	service, endpoint := newGatewayStateService(t)
	t.Setenv("KITTIES_RESTORE_SNAPSHOT", snapshot)
	t.Setenv("KITTIES_STATE_URL", endpoint)
	for _, wrong := range []string{"", base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{17}, 32))} {
		t.Setenv(vault.KeyEnv, wrong)
		if err := prepareCloudRestore(context.Background(), endpoint); err == nil {
			t.Fatal("recovery accepted missing/wrong stable key")
		}
		service.mu.Lock()
		files := len(service.files)
		service.mu.Unlock()
		if files != 0 {
			t.Fatal("failed key check partially imported state")
		}
	}
	t.Setenv(vault.KeyEnv, key)
	mustCloudState(t, prepareCloudRestore(context.Background(), endpoint))
	service.mu.Lock()
	revision := service.revision
	_, leaked := service.files["bootstrap-secrets.json"]
	service.mu.Unlock()
	if revision != 1 || leaked {
		t.Fatal("import was not one atomic gateway-only transaction")
	}
	// An initialized source skips archive downloads; the receipt is checked after hydration.
	t.Setenv("RESTIC_REPOSITORY", filepath.Join(t.TempDir(), "unavailable"))
	mustCloudState(t, prepareCloudRestore(context.Background(), endpoint))
	cache := filepath.Join(t.TempDir(), "cache")
	remote, err := statefs.Open(context.Background(), cache, endpoint)
	mustCloudState(t, err)
	defer remote.Close()
	mustCloudState(t, verifyCloudRestore(cache))
	t.Setenv("KITTIES_DATA_DIR", cache)
	configuration, err := config.Load(restoredConfiguration(""))
	mustCloudState(t, err)
	if configuration.Providers["file-only"].Model != "fixture" || len(configuration.Kitties) != 1 || len(configuration.Kitties[0].Goals) != 1 {
		t.Fatal("file-only profile or goal lost during restore")
	}
	if restoredConfiguration("explicit.yaml") != "explicit.yaml" {
		t.Fatal("recovery configuration replaced explicit -config")
	}

	v, _, err := openCloudSecretStores(cache)
	mustCloudState(t, err)
	secret, err := v.Get("fixture", "mimi")
	mustCloudState(t, err)
	if secret != "original-secret" {
		t.Fatal("recovery generated a replacement key")
	}
	t.Setenv("KITTIES_RESTORE_SNAPSHOT", "different")
	if err = verifyCloudRestore(cache); err == nil {
		t.Fatal("unrelated populated state accepted")
	}
}

func TestRecoveryCommandsRequireExplicitEmptyTargets(t *testing.T) {
	for _, command := range []func([]string, io.Writer, io.Writer) int{cmdRestore, cmdRestoreGateway, cmdImportState, cmdVerifyRecovery} {
		var output bytes.Buffer
		if code := command(nil, &output, &output); code != 2 {
			t.Fatalf("usage code=%d", code)
		}
	}
	snapshot, _ := recoveryRepository(t)
	var output bytes.Buffer
	if code := cmdVerifyRecovery([]string{snapshot}, &output, &output); code != 0 {
		t.Fatalf("read-only preflight: %s", output.String())
	}
	destination := filepath.Join(t.TempDir(), "metadata")
	if code := cmdRestoreGateway([]string{destination, snapshot}, &output, &output); code != 0 {
		t.Fatalf("metadata restore: %s", output.String())
	}
	if _, err := os.Stat(filepath.Join(destination, "computers")); !os.IsNotExist(err) {
		t.Fatal("metadata restore staged a full home")
	}
	_, endpoint := newGatewayStateService(t)
	t.Setenv("KITTIES_STATE_URL", endpoint)
	if code := cmdImportState([]string{filepath.Join(destination, "gateway")}, &output, &output); code != 0 {
		t.Fatalf("import: %s", output.String())
	}
	if code := cmdImportState([]string{filepath.Join(destination, "gateway")}, &output, &output); code != 1 {
		t.Fatal("import overwrote existing state")
	}
	if code := cmdRestore([]string{"relative", snapshot}, &output, &output); code != 1 {
		t.Fatal("relative restore accepted")
	}
	if code := cmdRestoreGateway([]string{destination, snapshot}, &output, &output); code != 1 {
		t.Fatal("metadata restore overwrote existing data")
	}
	if strings.Contains(output.String(), "fixture-restic-password") {
		t.Fatal("backup password leaked into diagnostics")
	}
}

func TestRecoveryPreflightRefusesIncompleteArchivesWithoutChangingLiveState(t *testing.T) {
	for _, fixture := range []struct{ name, manifest string }{
		{"unsupported-version", `{"version":2,"homes":[]}`},
		{"missing-checkpoint", `{"version":1,"homes":[{"name":"mimi","computer":{}}]}`},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			snapshot, _ := recoveryRepository(t, func(stage string) {
				mustCloudState(t, os.WriteFile(filepath.Join(stage, "manifest.json"), []byte(fixture.manifest), 0o600))
			})
			live := t.TempDir()
			mustCloudState(t, os.WriteFile(filepath.Join(live, "sentinel"), []byte("unchanged"), 0o600))
			t.Setenv("KITTIES_DATA_DIR", live)
			if code, _, diagnostic := exec(t, "", "verify-recovery", snapshot); code != 1 || !strings.Contains(diagnostic, "recovery verification failed") {
				t.Fatalf("invalid recovery preflight: %d %s", code, diagnostic)
			}
			entries, err := os.ReadDir(live)
			mustCloudState(t, err)
			if len(entries) != 1 || entries[0].Name() != "sentinel" {
				t.Fatal("verification mutated live state")
			}
		})
	}
}

func TestRecoveryBindingsRejectUnreadableMetadataAndUndecryptableState(t *testing.T) {
	dir := t.TempDir()
	if _, err := validateRecoveryBindings(dir); err == nil {
		t.Fatal("missing secret metadata accepted")
	}
	mustCloudState(t, os.WriteFile(filepath.Join(dir, "bootstrap-secrets.json"), []byte("broken"), 0o600))
	if _, err := validateRecoveryBindings(dir); err == nil {
		t.Fatal("corrupt secret metadata accepted")
	}
	mustCloudState(t, os.WriteFile(filepath.Join(dir, "bootstrap-secrets.json"), []byte("{}"), 0o600))
	mustCloudState(t, os.Mkdir(filepath.Join(dir, "gateway"), 0o700))
	mustCloudState(t, os.WriteFile(filepath.Join(dir, "gateway", "cloud.keycheck"), []byte("not encrypted"), 0o600))
	t.Setenv(vault.KeyEnv, base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32)))
	if _, err := validateRecoveryBindings(dir); err == nil {
		t.Fatal("undecryptable state accepted")
	}
}

func TestRecoveryCLIBypassesUnavailableLiveState(t *testing.T) {
	snapshot, _ := recoveryRepository(t)
	t.Setenv("KITTIES_STATE_URL", "https://invalid.invalid")
	for _, command := range []string{"restore-gateway", "import-state", "verify-recovery"} {
		if code, _, _ := exec(t, "", command); code != 2 {
			t.Fatalf("%s opened live state before validating command", command)
		}
	}
	dir := filepath.Join(t.TempDir(), "restored")
	if code, _, diagnostic := exec(t, "", "restore", dir, snapshot); code != 0 {
		t.Fatalf("restore: %d %s", code, diagnostic)
	}
	body, err := os.ReadFile(filepath.Join(dir, "computers", "mimi", "home", "file"))
	mustCloudState(t, err)
	if string(body) != "portable home" {
		t.Fatal("full CLI restore omitted computer home")
	}
}

func TestRecoveryRuntimePreflightRejectsNewerProviderGenerationWithoutSideEffects(t *testing.T) {
	t.Setenv("BOAT_DEV_API_KEY", "fixture-api-key")
	directory := t.TempDir()
	stateDir := filepath.Join(directory, "gateway", "boat")
	mustCloudState(t, os.MkdirAll(stateDir, 0o700))
	owner := strings.Repeat("a", 32)
	sum := sha256.Sum256([]byte("kitty-mimi"))
	checkpoint := fmt.Sprintf("kt-%s-%x", owner[:12], sum[:10])
	state := fmt.Sprintf(`{"version":1,"owner_id":%q,"computers":{"kitty-mimi":{"name":"kitty-mimi","generation":1,"remote_id":"bx-original","checkpoint_name":%q}}}`, owner, checkpoint)
	statePath := filepath.Join(stateDir, "state.json")
	mustCloudState(t, os.WriteFile(statePath, []byte(state), 0o600))
	previous := http.DefaultTransport
	defer func() { http.DefaultTransport = previous }()
	for _, generation := range []string{"1", "2"} {
		reads := 0
		http.DefaultTransport = cloudTransport(func(r *http.Request) (*http.Response, error) {
			reads++
			if r.Method != "GET" {
				t.Fatalf("recovery preflight changed provider state: %s", r.Method)
			}
			body := ""
			switch r.URL.Path {
			case "/api/v1/account/data-retention":
				body = `{"enabled":false}`
			case "/api/v1/saved-snapshots":
				body = `{"allowance":{"included":10}}`
			case "/api/v1/sandboxes":
				body = fmt.Sprintf(`{"sandboxes":[{"id":"bx-original","access":"owner","name":"kitty-mimi","labels":{"kitties.deployment":%q,"kitties.kitty":"kitty-mimi","kitties.generation":%q}}]}`, owner, generation)
			case "/api/v1/sandboxes/bx-original":
				body = fmt.Sprintf(`{"sandbox":{"id":"bx-original","access":"owner","name":"kitty-mimi","labels":{"kitties.deployment":%q,"kitties.kitty":"kitty-mimi","kitties.generation":%q}}}`, owner, generation)
			default:
				t.Fatalf("unexpected preflight request: %s", r.URL)
			}
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
		})
		err := checkRecoveryRuntime(context.Background(), directory)
		if (err != nil) != (generation == "2") {
			t.Fatalf("generation %s: %v", generation, err)
		}
		wantReads := 3
		if generation == "1" {
			wantReads = 4
		}
		if reads != wantReads {
			t.Fatalf("did not audit full provider identity: %d requests", reads)
		}
		after, err := os.ReadFile(statePath)
		mustCloudState(t, err)
		if string(after) != state {
			t.Fatal("preflight changed restored runtime identity")
		}
	}
	mustCloudState(t, os.WriteFile(statePath, []byte("broken"), 0o600))
	if err := checkRecoveryRuntime(context.Background(), directory); err == nil {
		t.Fatal("damaged runtime state passed preflight")
	}
}
