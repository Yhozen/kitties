// Package keep holds the backups of what makes a kitty itself in a new container: its browser's
// cookies, sessions and saved passwords, and the keys of its programs. They are kept away from
// the container, sealed with the vault's key, one per kitty, and given back when the container is
// made anew (an update of the desktop, or a workspace that was lost).
package keep

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/madkoding/kitties/internal/statefs"
	"github.com/madkoding/kitties/internal/vault"
)

// Max is the largest backup kept.
const Max = 60 << 20

// ErrNone is what a kitty with no backup gets.
var ErrNone = errors.New("no backup of this kitty")

var idRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

// Info says when a backup was made and how big it is (as kept, sealed).
type Info struct {
	Saved time.Time `json:"saved"`
	Bytes int       `json:"bytes"`
}

// Store keeps the backups in a folder.
type Store struct {
	dir string
	box *vault.Box
}

// Open keeps backups in dir/backups, sealed with the key kept in dir.
func Open(dir string) (*Store, error) {
	box, err := vault.NewBox(dir)
	if err != nil {
		return nil, err
	}
	return &Store{dir: filepath.Join(dir, "backups"), box: box}, nil
}

func (s *Store) path(kitty string) (string, error) {
	if !idRe.MatchString(kitty) {
		return "", fmt.Errorf("%q is not a kitty id", kitty)
	}
	return filepath.Join(s.dir, kitty+".bin"), nil
}

// Save keeps a backup (a tar.gz) of a kitty, replacing the last.
func (s *Store) Save(kitty string, data []byte) error {
	p, err := s.path(kitty)
	if err != nil {
		return err
	}
	if len(data) == 0 || len(data) > Max {
		return fmt.Errorf("a backup is 1 byte to %d MB", Max>>20)
	}
	sealed, err := s.box.Seal(data, []byte("backup:"+kitty))
	if err != nil {
		return err
	}
	if err := statefs.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := statefs.WriteFile(tmp, sealed, 0o600); err != nil {
		return err
	}
	return statefs.Rename(tmp, p)
}

// Load opens the last backup of a kitty.
func (s *Store) Load(kitty string) ([]byte, Info, error) {
	p, err := s.path(kitty)
	if err != nil {
		return nil, Info{}, err
	}
	sealed, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, Info{}, ErrNone
	}
	if err != nil {
		return nil, Info{}, err
	}
	info, _ := s.Info(kitty)
	data, err := s.box.Open(sealed, []byte("backup:"+kitty))
	return data, info, err
}

// Info is what is known of a kitty's backup without opening it.
func (s *Store) Info(kitty string) (Info, bool) {
	p, err := s.path(kitty)
	if err != nil {
		return Info{}, false
	}
	st, err := os.Stat(p)
	if err != nil {
		return Info{}, false
	}
	return Info{Saved: st.ModTime().UTC(), Bytes: int(st.Size())}, true
}

// Forget deletes the backup of a kitty that was removed.
func (s *Store) Forget(kitty string) error {
	p, err := s.path(kitty)
	if err != nil {
		return err
	}
	if err := statefs.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
