package keep

import (
	"bytes"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestCloudReadinessValidatesEverySavedSessionWithoutChangingIt(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("KITTIES_VAULT_KEY", base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32)))
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ValidateKey(); err != nil {
		t.Fatalf("new gateway: %v", err)
	}
	if err := store.Save("kitty", []byte("persistent browser session")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(store.dir, "unrelated"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.dir, "notes.txt"), []byte("not encrypted session data"), 0600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(store.dir, "kitty.bin")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ValidateKey(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KITTIES_VAULT_KEY", base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{2}, 32)))
	wrong, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := wrong.ValidateKey(); err == nil {
		t.Fatal("gateway accepted unusable saved browser sessions")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("validation rewrote recovery data")
	}
}

func TestCloudReadinessRefusesOversizedAndUnreadableSessionStores(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(store.dir, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := store.ValidateKey(); err == nil {
		t.Fatal("invalid session directory accepted")
	}
	if err := os.Remove(store.dir); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(store.dir, 0700); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(filepath.Join(store.dir, "kitty.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(Max + 65); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if err := store.ValidateKey(); err == nil {
		t.Fatal("oversized encrypted session accepted")
	}
}
