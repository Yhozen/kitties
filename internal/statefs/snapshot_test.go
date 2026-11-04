package statefs

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestSnapshotCapturesCommittedRevisionAndPermissions(t *testing.T) {
	_, server := newStateService(t)
	root := filepath.Join(t.TempDir(), "cache")
	store, err := Open(context.Background(), root, server.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	secret := filepath.Join(root, "vault.key")
	if err := WriteFile(secret, []byte("recovery-key"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := AppendFile(filepath.Join(root, "journal.jsonl"), []byte("first\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := AppendFile(filepath.Join(root, "journal.jsonl"), []byte("second\n"), 0600); err != nil {
		t.Fatal(err)
	}
	// External key generation and staging writes have not been committed yet.
	if err := os.WriteFile(filepath.Join(root, "unpublished"), []byte("partial"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(filepath.Join(root, "settings.json.tmp"), []byte("partial"), 0600); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(t.TempDir(), "backup")
	if err := Snapshot(context.Background(), root, destination); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{"vault.key": "recovery-key", "journal.jsonl": "first\nsecond\n"} {
		data, err := os.ReadFile(filepath.Join(destination, name))
		if err != nil || string(data) != want {
			t.Fatalf("%s: %q %v", name, data, err)
		}
		stat, err := os.Stat(filepath.Join(destination, name))
		if err != nil || stat.Mode().Perm() != 0600 {
			t.Fatalf("private mode: %v %v", stat, err)
		}
	}
	entries, err := os.ReadDir(destination)
	if err != nil || len(entries) != 2 {
		t.Fatalf("uncommitted files entered backup: %v %v", entries, err)
	}
	if err := WriteFile(secret, []byte("later-key"), 0600); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(destination, "vault.key"))
	if string(data) != "recovery-key" {
		t.Fatal("snapshot changed after live write")
	}
}

func TestSnapshotRejectsUntrustedOrChangedRemoteState(t *testing.T) {
	for _, kind := range []string{"revision", "path", "duplicate", "mode", "blob", "unavailable"} {
		t.Run(kind, func(t *testing.T) {
			service, server := newStateService(t)
			root := filepath.Join(t.TempDir(), "cache")
			store, err := Open(context.Background(), root, server.URL)
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
			if err := WriteFile(filepath.Join(root, "state"), []byte("committed"), 0600); err != nil {
				t.Fatal(err)
			}
			service.mu.Lock()
			switch kind {
			case "revision":
				service.manifest.Revision++
			case "path":
				service.manifest.Files[0].Path = "../escaped"
			case "duplicate":
				service.manifest.Files = append(service.manifest.Files, service.manifest.Files[0])
			case "mode":
				service.manifest.Files[0].Mode = 04000
			case "blob":
				service.corrupt = true
			case "unavailable":
				service.unavailable = true
			}
			service.mu.Unlock()
			if err := Snapshot(context.Background(), root, filepath.Join(t.TempDir(), "backup")); err == nil {
				t.Fatal("accepted unsafe recovery capture")
			}
		})
	}
}

func TestLocalSnapshotExcludesLocksAndRefusesLinks(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "boat"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{".gateway.lock", ".remote-state-cache", "boat/state.lock", "boat/state.json"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	destination := filepath.Join(t.TempDir(), "backup")
	if err := Snapshot(context.Background(), root, destination); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(destination, "boat/state.json")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{".gateway.lock", ".remote-state-cache", "boat/state.lock"} {
		if _, err := os.Stat(filepath.Join(destination, name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("lock copied: %s %v", name, err)
		}
	}
	for _, path := range []string{root, filepath.Join(root, "nested"), destination} {
		if err := Snapshot(context.Background(), root, path); err == nil {
			t.Fatalf("accepted unsafe destination %s", path)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := Snapshot(ctx, root, t.TempDir()); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	if err := os.Symlink("state.json", filepath.Join(root, "boat/link")); err != nil {
		t.Fatal(err)
	}
	if err := Snapshot(context.Background(), root, t.TempDir()); err == nil {
		t.Fatal("followed untrusted symlink")
	}
}
