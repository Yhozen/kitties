package vault

import (
	"bytes"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestCloudReadinessRejectsWrongKeyAndDamagedCiphertext(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(KeyEnv, base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32)))
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ValidateKey(); err != nil {
		t.Fatal(err)
	}
	if err := store.Put("service credential", "saved secret", []string{"kitty"}); err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(filepath.Join(dir, "vault.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ValidateKey(); err != nil {
		t.Fatal(err)
	}
	t.Setenv(KeyEnv, base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{2}, 32)))
	wrong, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := wrong.ValidateKey(); err == nil {
		t.Fatal("wrong cloud key accepted")
	}
	for _, entry := range store.list {
		entry.Nonce = nil
	}
	if err := store.ValidateKey(); err == nil {
		t.Fatal("invalid nonce accepted")
	}
	current, err := os.ReadFile(filepath.Join(dir, "vault.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(original, current) {
		t.Fatal("readiness changed stored secrets")
	}
}
