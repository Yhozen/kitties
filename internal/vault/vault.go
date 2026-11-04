// Package vault keeps the secrets a person lets their kitties type for them: a password, a
// code, an API key. Each one has a name and the kitties that may use it; the kitty is told the
// names it may use and asks for one by name, and the secret goes from here to the kitty's
// keyboard without the kitty (or its AI model) ever reading it. They are encrypted at rest with
// AES-256-GCM under a key kept in its own file (mode 0600) beside the vault, or in the
// KITTIES_VAULT_KEY environment variable (base64, 32 bytes) so the key and the data need not
// share a disk.
package vault

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/madkoding/kitties/internal/statefs"
)

// KeyEnv is the environment variable that holds the key instead of the key file.
const KeyEnv = "KITTIES_VAULT_KEY"

// MaxValue is the longest secret.
const MaxValue = 2000

// Info is what is known about a secret without opening it.
type Info struct {
	Name    string    `json:"name"`
	Kitties []string  `json:"kitties"`
	Saved   time.Time `json:"saved"`
}

type entry struct {
	Name    string    `json:"name"`
	Nonce   []byte    `json:"nonce"`
	Sealed  []byte    `json:"sealed"`
	Kitties []string  `json:"kitties"`
	Saved   time.Time `json:"saved"`
}

// Store is the vault.
type Store struct {
	path string
	aead cipher.AEAD
	mu   sync.Mutex
	list map[string]*entry // by lower-case name
	now  func() time.Time
}

// Box seals and opens blobs with the same key as the vault (the environment's or the key file),
// for what else is kept sealed away from a container: the backups of a kitty's sessions.
type Box struct{ aead cipher.AEAD }

// NewBox is the sealing box of the key kept in dir.
func NewBox(dir string) (*Box, error) {
	aead, err := newAEAD(dir)
	if err != nil {
		return nil, err
	}
	return &Box{aead: aead}, nil
}

// Seal encrypts plain, bound to aad (what the blob is for, so it cannot be moved to another use).
func (b *Box) Seal(plain, aad []byte) ([]byte, error) {
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return b.aead.Seal(nonce, nonce, plain, aad), nil
}

// Open decrypts what Seal made.
func (b *Box) Open(sealed, aad []byte) ([]byte, error) {
	n := b.aead.NonceSize()
	if len(sealed) < n {
		return nil, errors.New("the sealed data is too short")
	}
	plain, err := b.aead.Open(nil, sealed[:n], sealed[n:], aad)
	if err != nil {
		return nil, errors.New("the sealed data cannot be opened with this key")
	}
	return plain, nil
}

func newAEAD(dir string) (cipher.AEAD, error) {
	key, err := loadKey(dir)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// Open reads the vault in dir (created on the first save), with its key: the environment's, or
// the key file, made on the first use.
func Open(dir string) (*Store, error) {
	aead, err := newAEAD(dir)
	if err != nil {
		return nil, err
	}
	s := &Store{path: filepath.Join(dir, "vault.json"), aead: aead, list: map[string]*entry{}, now: time.Now}
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	var entries []*entry
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, fmt.Errorf("%s: %w", s.path, err)
	}
	for _, e := range entries {
		if e == nil {
			return nil, errors.New("saved secrets contain an invalid entry")
		}
		s.list[strings.ToLower(e.Name)] = e
	}
	return s, nil
}

func loadKey(dir string) ([]byte, error) {
	if env := strings.TrimSpace(os.Getenv(KeyEnv)); env != "" {
		key, err := base64.StdEncoding.DecodeString(env)
		if err != nil || len(key) != 32 {
			return nil, fmt.Errorf("%s is not 32 bytes in base64", KeyEnv)
		}
		return key, nil
	}
	path := filepath.Join(dir, "vault.key")
	raw, err := os.ReadFile(path)
	if err == nil {
		key, derr := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
		if derr != nil || len(key) != 32 {
			return nil, fmt.Errorf("%s is not a vault key", path)
		}
		return key, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	if err := statefs.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return key, statefs.WriteFile(path, []byte(base64.StdEncoding.EncodeToString(key)+"\n"), 0o600)
}

// clean is a secret's name as it is kept, or why it is not one.
func clean(name string) (string, error) {
	name = strings.Join(strings.Fields(name), " ")
	if name == "" || len(name) > 60 {
		return "", errors.New("a secret's name is 1 to 60 characters")
	}
	return name, nil
}

func (s *Store) save() error {
	entries := make([]*entry, 0, len(s.list))
	for _, e := range s.list {
		entries = append(entries, e)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	raw, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return err
	}
	if err := statefs.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := statefs.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return statefs.Rename(tmp, s.path)
}

// Put saves a secret under a name, for these kitties (by id); one with the name is replaced.
func (s *Store) Put(name, value string, kitties []string) error {
	name, err := clean(name)
	if err != nil {
		return err
	}
	if value == "" || len(value) > MaxValue {
		return fmt.Errorf("a secret is 1 to %d characters", MaxValue)
	}
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.list[strings.ToLower(name)] = &entry{
		Name: name, Nonce: nonce, Sealed: s.aead.Seal(nil, nonce, []byte(value), []byte(strings.ToLower(name))),
		Kitties: append([]string(nil), kitties...), Saved: s.now(),
	}
	return s.save()
}

// Get opens a secret, for the kitty that may use it.
func (s *Store) Get(name, kitty string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.list[strings.ToLower(strings.Join(strings.Fields(name), " "))]
	if !ok || !contains(e.Kitties, kitty) {
		return "", fmt.Errorf("no saved secret called %q that you may use", name)
	}
	plain, err := s.aead.Open(nil, e.Nonce, e.Sealed, []byte(strings.ToLower(e.Name)))
	if err != nil {
		return "", fmt.Errorf("the secret %q cannot be opened with this key", e.Name)
	}
	return string(plain), nil
}

// Names are the secrets a kitty may use, by name.
func (s *Store) Names(kitty string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, e := range s.list {
		if contains(e.Kitties, kitty) {
			out = append(out, e.Name)
		}
	}
	sort.Strings(out)
	return out
}

// List is every secret, without its value.
func (s *Store) List() []Info {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Info, 0, len(s.list))
	for _, e := range s.list {
		out = append(out, Info{Name: e.Name, Kitties: append([]string{}, e.Kitties...), Saved: e.Saved})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// SetKitties changes which kitties may use a secret.
func (s *Store) SetKitties(name string, kitties []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.list[strings.ToLower(strings.Join(strings.Fields(name), " "))]
	if !ok {
		return fmt.Errorf("no such secret %q", name)
	}
	e.Kitties = append([]string{}, kitties...)
	return s.save()
}

// Delete forgets a secret.
func (s *Store) Delete(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := strings.ToLower(strings.Join(strings.Fields(name), " "))
	if _, ok := s.list[key]; !ok {
		return fmt.Errorf("no such secret %q", name)
	}
	delete(s.list, key)
	return s.save()
}

// ForgetKitty takes a removed kitty out of every secret's list.
func (s *Store) ForgetKitty(kitty string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.list {
		var keep []string
		for _, k := range e.Kitties {
			if k != kitty {
				keep = append(keep, k)
			}
		}
		e.Kitties = keep
	}
	return s.save()
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
