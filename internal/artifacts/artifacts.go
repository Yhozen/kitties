// Package artifacts keeps what the kitties produce and want to reuse: a report, a table, a
// diagram, a scene, a draft. One folder for the whole fleet (<data_dir>/artifacts), so a file a
// kitty saved in one chat can be read in another, by it or by a teammate, and a person can
// download or upload any of them from the page.
package artifacts

import (
	"errors"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/madkoding/kitties/internal/statefs"
)

// Artifact is one file.
type Artifact struct {
	Name      string    `json:"name"`
	Type      string    `json:"type"`
	Size      int64     `json:"size"`
	UpdatedAt time.Time `json:"updated_at"`
	// By is the kitty that saved it, when one did.
	By string `json:"by,omitempty"`
}

// Store is the folder.
type Store struct {
	dir string
}

const (
	maxFile  = 8 << 20
	maxFiles = 500
)

var nameRe = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9._ -]{0,118}[A-Za-z0-9])?$`)

// New opens the store at dir.
func New(dir string) *Store { return &Store{dir: dir} }

// Dir is where the files live.
func (s *Store) Dir() string { return s.dir }

// ValidName reports whether name is a plain file name: no folders, no hidden files.
func ValidName(name string) bool {
	return nameRe.MatchString(name) && !strings.Contains(name, "..") && !strings.HasPrefix(name, ".")
}

// Type guesses the media type from the name.
func Type(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".md", ".markdown":
		return "text/markdown"
	case ".excalidraw":
		return "application/json"
	case ".txt", "":
		return "text/plain"
	}
	if t := mime.TypeByExtension(ext); t != "" {
		return t
	}
	return "application/octet-stream"
}

// List returns every artifact, newest first.
func (s *Store) List() ([]Artifact, error) {
	entries, err := os.ReadDir(s.dir)
	if errors.Is(err, os.ErrNotExist) {
		return []Artifact{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read the artifacts: %w", err)
	}
	by := s.readOwners()
	out := []Artifact{}
	for _, e := range entries {
		if e.IsDir() || !ValidName(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, Artifact{Name: e.Name(), Type: Type(e.Name()), Size: info.Size(), UpdatedAt: info.ModTime(), By: by[e.Name()]})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	return out, nil
}

// ownersPath records which kitty saved which file.
func (s *Store) ownersPath() string { return filepath.Join(s.dir, ".owners") }

func (s *Store) readOwners() map[string]string {
	out := map[string]string{}
	data, err := os.ReadFile(s.ownersPath())
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(data), "\n") {
		if name, by, ok := strings.Cut(line, "\t"); ok {
			out[name] = by
		}
	}
	return out
}

func (s *Store) setOwner(name, by string) {
	owners := s.readOwners()
	if by == "" {
		delete(owners, name)
	} else {
		owners[name] = by
	}
	var b strings.Builder
	names := make([]string, 0, len(owners))
	for n := range owners {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		b.WriteString(n + "\t" + owners[n] + "\n")
	}
	_ = statefs.WriteFile(s.ownersPath(), []byte(b.String()), 0o600)
}

// Get reads one artifact.
func (s *Store) Get(name string) ([]byte, error) {
	if !ValidName(name) {
		return nil, fmt.Errorf("no such artifact %q", name)
	}
	data, err := os.ReadFile(filepath.Join(s.dir, name))
	if err != nil {
		return nil, fmt.Errorf("no such artifact %q", name)
	}
	return data, nil
}

// Put writes one artifact; by is the kitty that made it, empty for a person.
func (s *Store) Put(name string, data []byte, by string) (Artifact, error) {
	if !ValidName(name) {
		return Artifact{}, fmt.Errorf("%q is not a valid artifact name (letters, digits, dots, dashes, spaces; no folders)", name)
	}
	if len(data) > maxFile {
		return Artifact{}, fmt.Errorf("the artifact is too big (%d bytes, at most %d)", len(data), maxFile)
	}
	if list, err := s.List(); err == nil && len(list) >= maxFiles {
		exists := false
		for _, a := range list {
			exists = exists || a.Name == name
		}
		if !exists {
			return Artifact{}, fmt.Errorf("the library holds %d artifacts already; delete some first", maxFiles)
		}
	}
	if err := statefs.MkdirAll(s.dir, 0o700); err != nil {
		return Artifact{}, fmt.Errorf("create the artifacts folder: %w", err)
	}
	path := filepath.Join(s.dir, name)
	if err := statefs.WriteFile(path+".tmp", data, 0o600); err != nil {
		return Artifact{}, fmt.Errorf("save the artifact: %w", err)
	}
	if err := statefs.Rename(path+".tmp", path); err != nil {
		return Artifact{}, err
	}
	s.setOwner(name, by)
	info, _ := os.Stat(path)
	a := Artifact{Name: name, Type: Type(name), Size: int64(len(data)), By: by}
	if info != nil {
		a.UpdatedAt = info.ModTime()
	}
	return a, nil
}

// Delete removes one artifact.
func (s *Store) Delete(name string) error {
	if !ValidName(name) {
		return fmt.Errorf("no such artifact %q", name)
	}
	if err := statefs.Remove(filepath.Join(s.dir, name)); err != nil {
		return fmt.Errorf("no such artifact %q", name)
	}
	s.setOwner(name, "")
	return nil
}

// Index renders the library for a system prompt: one line per artifact, at most n.
func (s *Store) Index(n int) string {
	list, err := s.List()
	if err != nil || len(list) == 0 {
		return ""
	}
	var b strings.Builder
	for i, a := range list {
		if i >= n {
			fmt.Fprintf(&b, "- … and %d more\n", len(list)-n)
			break
		}
		by := ""
		if a.By != "" {
			by = ", by " + a.By
		}
		fmt.Fprintf(&b, "- %s (%s, %d bytes%s)\n", a.Name, a.Type, a.Size, by)
	}
	return b.String()
}
