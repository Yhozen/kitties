package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/madkoding/kitties/internal/config"
	"github.com/madkoding/kitties/internal/statelock"
	"github.com/madkoding/kitties/internal/vault"
)

func cloudApp(t *testing.T, dir string) *app {
	t.Helper()
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("cloud gateway uses kernel file locks")
	}
	cfg := config.Defaults()
	cfg.DataDir, cfg.Containers.Runtime = dir, "boat"
	return &app{cfg: cfg, out: io.Discard, err: io.Discard, in: strings.NewReader("")}
}

func TestCloudGatewayHasOneWriterAndReleasesOnClose(t *testing.T) {
	t.Setenv(vault.KeyEnv, "")
	dir := t.TempDir()
	first, second := cloudApp(t, dir), cloudApp(t, dir)
	if err := first.open("providers"); err != nil {
		t.Fatal(err)
	}
	defer first.close()
	if err := second.open("providers"); !errors.Is(err, statelock.ErrLocked) {
		t.Fatalf("second writer = %v", err)
	}
	calls := 0
	first.closeRuntime = func() error {
		calls++
		lock, err := statelock.Acquire(dir)
		if lock != nil {
			_ = lock.Close()
		}
		if !errors.Is(err, statelock.ErrLocked) {
			t.Errorf("directory unlocked before runtime closed: %v", err)
		}
		return nil
	}
	if err := first.close(); err != nil {
		t.Fatal(err)
	}
	if err := first.close(); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("runtime close called %d times", calls)
	}
	if err := second.open("providers"); err != nil {
		t.Fatal(err)
	}
	defer second.close()
}

func TestCloudStartupFailureReleasesStateLock(t *testing.T) {
	t.Setenv(vault.KeyEnv, "")
	t.Setenv("BOAT_DEV_API_KEY", "")
	dir := t.TempDir()
	a := cloudApp(t, dir)
	if err := a.open("ls"); err == nil || !strings.Contains(err.Error(), "API key") {
		t.Fatalf("missing Boat key = %v", err)
	}
	lock, err := statelock.Acquire(dir)
	if err != nil {
		t.Fatalf("startup error kept the state lock: %v", err)
	}
	_ = lock.Close()
}

func TestCloudStartupRejectsMissingOrWrongEncryptionKey(t *testing.T) {
	t.Setenv(vault.KeyEnv, "")
	for _, damage := range []string{"missing", "wrong", "backup", "malformed"} {
		t.Run(damage, func(t *testing.T) {
			dir := t.TempDir()
			v, k, err := openCloudSecretStores(dir)
			if err != nil {
				t.Fatal(err)
			}
			const secret = "must-never-be-printed"
			if err := v.Put("login", secret, []string{"mimi"}); err != nil {
				t.Fatal(err)
			}
			if err := k.Save("mimi", []byte("browser state")); err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(filepath.Join(dir, "vault.json"))
			if err != nil {
				t.Fatal(err)
			}
			switch damage {
			case "missing":
				if err := os.Remove(filepath.Join(dir, "vault.key")); err != nil {
					t.Fatal(err)
				}
			case "wrong":
				key := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{42}, 32))
				if err := os.WriteFile(filepath.Join(dir, "vault.key"), []byte(key), 0o600); err != nil {
					t.Fatal(err)
				}
			case "malformed":
				if err := os.WriteFile(filepath.Join(dir, "vault.json"), []byte("[null]"), 0o600); err != nil {
					t.Fatal(err)
				}
				before = []byte("[null]")
			case "backup":
				if err := os.WriteFile(filepath.Join(dir, "backups", "mimi.bin"), []byte("broken backup"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			a := cloudApp(t, dir)
			err = a.open("providers")
			if err == nil {
				_ = a.close()
				t.Fatal("damaged encrypted state accepted")
			}
			if strings.Contains(err.Error(), secret) {
				t.Fatal("secret leaked in startup diagnostics")
			}
			after, _ := os.ReadFile(filepath.Join(dir, "vault.json"))
			if !bytes.Equal(before, after) {
				t.Fatal("failed readiness rewrote existing secrets")
			}
			if damage == "missing" {
				if _, err := os.Stat(filepath.Join(dir, "vault.key")); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("lost key was replaced: %v", err)
				}
			}
			if _, err := os.Stat(filepath.Join(dir, "kitties.json")); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("fleet opened before encryption readiness: %v", err)
			}
			lock, err := statelock.Acquire(dir)
			if err != nil {
				t.Fatalf("readiness failure leaked lock: %v", err)
			}
			_ = lock.Close()
		})
	}
}

func TestCloudKeyIdentitySurvivesAnEmptyVault(t *testing.T) {
	t.Setenv(vault.KeyEnv, "")
	dir := t.TempDir()
	if _, _, err := openCloudSecretStores(dir); err != nil {
		t.Fatal(err)
	}
	t.Setenv(vault.KeyEnv, base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{19}, 32)))
	if _, _, err := openCloudSecretStores(dir); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("wrong replacement key accepted for empty vault: %v", err)
	}
}
