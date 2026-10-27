package statefs

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestDisasterImportCommitsCompleteRecoveryOnce(t *testing.T) {
	service, server := newStateService(t)
	source := t.TempDir()
	must(t, os.Mkdir(filepath.Join(source, "boat"), 0700))
	for path, content := range map[string]string{"vault.key": "original-key", "boat/state.json": "owner-and-checkpoint", "settings.json.tmp": "legitimate-recovered-artifact"} {
		must(t, os.WriteFile(filepath.Join(source, path), []byte(content), 0600))
	}
	must(t, os.WriteFile(filepath.Join(source, ".remote-state-cache"), []byte("old-endpoint"), 0600))
	service.mu.Lock()
	service.loseACK = true
	service.mu.Unlock()
	must(t, Import(context.Background(), source, server.URL))
	service.mu.Lock()
	revision, files := service.manifest.Revision, len(service.manifest.Files)
	service.mu.Unlock()
	if revision != 1 || files != 3 {
		t.Fatalf("recovery not atomic: revision%d files%d", revision, files)
	}
	if err := Import(context.Background(), source, server.URL); err == nil {
		t.Fatal("overwrote active gateway state")
	}
	cache := filepath.Join(t.TempDir(), "fresh")
	store := openTestState(t, cache, server.URL)
	defer store.Close()
	got, err := os.ReadFile(filepath.Join(cache, "vault.key"))
	must(t, err)
	if string(got) != "original-key" {
		t.Fatal("vault identity changed")
	}
	if err := Import(context.Background(), source, server.URL); err == nil {
		t.Fatal("import while cloud writer active")
	}
}

func TestFailedImportLeavesNoPartialAuthoritativeState(t *testing.T) {
	for _, kind := range []string{"upload", "link", "empty", "occupied", "cancelled"} {
		t.Run(kind, func(t *testing.T) {
			service, server := newStateService(t)
			source := t.TempDir()
			ctx := context.Background()
			if kind != "empty" {
				must(t, os.WriteFile(filepath.Join(source, "vault.key"), []byte("key"), 0600))
			}
			service.mu.Lock()
			if kind == "upload" {
				service.failWrites = true
			}
			if kind == "occupied" {
				service.manifest.Revision = 1
			}
			service.mu.Unlock()
			if kind == "link" {
				must(t, os.Symlink("vault.key", filepath.Join(source, "z-link")))
			}
			if kind == "cancelled" {
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			if err := Import(ctx, source, server.URL); err == nil {
				t.Fatal("unsafe import succeeded")
			}
			service.mu.Lock()
			defer service.mu.Unlock()
			if len(service.manifest.Files) != 0 {
				t.Fatal("partial gateway became authoritative")
			}
		})
	}
}
