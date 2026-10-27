// Package skills gives the kitties a library of procedures they can look up and extend, in the
// spirit of motita's: a skill is a markdown document that says HOW to do a kind of work. The
// system prompt lists the names and summaries; a kitty reads one with `@skill read <name>` when
// it needs it and proposes a new one with `@skill save {...}` when it learned something. A
// proposal waits in the page until a person accepts it.
package skills

import (
	"embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/madkoding/kitties/internal/statefs"
)

//go:embed builtin/*.md
var builtinFS embed.FS

// Skill is one document.
type Skill struct {
	Name      string    `json:"name"`
	Title     string    `json:"title"`
	Summary   string    `json:"summary"`
	Body      string    `json:"body,omitempty"`
	Builtin   bool      `json:"builtin"`
	Proposed  bool      `json:"proposed"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Library is the documents of one data folder, with the built-in ones under them.
type Library struct {
	dir string
}

// New opens the library at dir (<data_dir>/skills); the folder is made on the first write.
func New(dir string) *Library { return &Library{dir: dir} }

// Dir is where the library lives.
func (l *Library) Dir() string { return l.dir }

var nameRe = regexp.MustCompile(`[^a-z0-9]+`)

// Name turns a title into a file name: lowercase, dashes, at most 60 characters.
func Name(raw string) string {
	n := strings.Trim(nameRe.ReplaceAllString(strings.ToLower(strings.TrimSpace(raw)), "-"), "-")
	if len(n) > 60 {
		n = strings.Trim(n[:60], "-")
	}
	return n
}

// parse reads the title (first heading) and the summary (first paragraph) of a document.
func parse(name, body string) Skill {
	s := Skill{Name: name, Body: body}
	for _, line := range strings.Split(body, "\n") {
		t := strings.TrimSpace(line)
		if t == "" {
			continue
		}
		if strings.HasPrefix(t, "#") {
			if s.Title == "" {
				s.Title = strings.TrimSpace(strings.TrimLeft(t, "#"))
			}
			continue
		}
		s.Summary = t
		break
	}
	if s.Title == "" {
		s.Title = name
	}
	if len(s.Summary) > 200 {
		s.Summary = s.Summary[:200] + "…"
	}
	return s
}

const maxBody = 64 << 10

func (l *Library) path(name string) string { return filepath.Join(l.dir, name+".md") }
func (l *Library) proposalPath(name string) string {
	return filepath.Join(l.dir, "proposed", name+".md")
}

func builtins() map[string]Skill {
	out := map[string]Skill{}
	entries, _ := builtinFS.ReadDir("builtin")
	for _, e := range entries {
		data, _ := builtinFS.ReadFile("builtin/" + e.Name())
		name := strings.TrimSuffix(e.Name(), ".md")
		s := parse(name, string(data))
		s.Builtin = true
		out[name] = s
	}
	return out
}

func (l *Library) readDir(dir string, proposed bool) (map[string]Skill, error) {
	out := map[string]Skill{}
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return out, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read the skills: %w", err)
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		info, _ := e.Info()
		name := strings.TrimSuffix(e.Name(), ".md")
		s := parse(name, string(data))
		s.Proposed = proposed
		if info != nil {
			s.UpdatedAt = info.ModTime()
		}
		out[name] = s
	}
	return out, nil
}

// List returns every skill (summaries only), the person's own over the built-in ones, and the
// proposals last.
func (l *Library) List() ([]Skill, error) {
	all := builtins()
	own, err := l.readDir(l.dir, false)
	if err != nil {
		return nil, err
	}
	for n, s := range own {
		all[n] = s
	}
	proposed, err := l.readDir(filepath.Join(l.dir, "proposed"), true)
	if err != nil {
		return nil, err
	}
	for n, s := range proposed {
		if _, taken := all[n]; !taken {
			all[n] = s
		}
	}
	out := make([]Skill, 0, len(all))
	for _, s := range all {
		s.Body = ""
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Proposed != out[j].Proposed {
			return !out[i].Proposed
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// Get returns a skill with its body: the person's own, else the built-in, else a proposal.
func (l *Library) Get(name string) (Skill, error) {
	name = Name(name)
	if data, err := os.ReadFile(l.path(name)); err == nil {
		s := parse(name, string(data))
		if info, err := os.Stat(l.path(name)); err == nil {
			s.UpdatedAt = info.ModTime()
		}
		return s, nil
	}
	if s, ok := builtins()[name]; ok {
		return s, nil
	}
	if data, err := os.ReadFile(l.proposalPath(name)); err == nil {
		s := parse(name, string(data))
		s.Proposed = true
		return s, nil
	}
	return Skill{}, fmt.Errorf("no such skill %q", name)
}

func write(path, body string) error {
	if strings.TrimSpace(body) == "" {
		return errors.New("the skill is empty")
	}
	if len(body) > maxBody {
		return fmt.Errorf("the skill is too long (%d bytes, at most %d)", len(body), maxBody)
	}
	if err := statefs.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create the skills folder: %w", err)
	}
	if err := statefs.WriteFile(path+".tmp", []byte(body), 0o600); err != nil {
		return fmt.Errorf("save the skill: %w", err)
	}
	return statefs.Rename(path+".tmp", path)
}

// Save writes a skill the person accepted or wrote, replacing a proposal of the same name.
func (l *Library) Save(name, body string) (Skill, error) {
	name = Name(name)
	if name == "" {
		return Skill{}, errors.New("the skill needs a name")
	}
	if err := write(l.path(name), body); err != nil {
		return Skill{}, err
	}
	_ = statefs.Remove(l.proposalPath(name))
	return l.Get(name)
}

// Propose writes a skill a kitty learned, to be accepted by a person.
func (l *Library) Propose(name, body string) (Skill, error) {
	name = Name(name)
	if name == "" {
		return Skill{}, errors.New("the skill needs a name")
	}
	if err := write(l.proposalPath(name), body); err != nil {
		return Skill{}, err
	}
	s := parse(name, body)
	s.Proposed = true
	return s, nil
}

// Accept moves a proposal into the library.
func (l *Library) Accept(name string) (Skill, error) {
	name = Name(name)
	data, err := os.ReadFile(l.proposalPath(name))
	if err != nil {
		return Skill{}, fmt.Errorf("no such proposal %q", name)
	}
	return l.Save(name, string(data))
}

// Delete removes a skill or a proposal of the person's own; a built-in cannot be deleted.
func (l *Library) Delete(name string) error {
	name = Name(name)
	err1 := statefs.Remove(l.path(name))
	err2 := statefs.Remove(l.proposalPath(name))
	if err1 != nil && err2 != nil {
		if _, ok := builtins()[name]; ok {
			return fmt.Errorf("%q is built in and cannot be deleted", name)
		}
		return fmt.Errorf("no such skill %q", name)
	}
	return nil
}

// Search returns the skills whose name, title or summary hold every word of the query.
func (l *Library) Search(query string, limit int) ([]Skill, error) {
	all, err := l.List()
	if err != nil {
		return nil, err
	}
	words := strings.Fields(strings.ToLower(query))
	var out []Skill
	for _, s := range all {
		if s.Proposed {
			continue
		}
		hay := strings.ToLower(s.Name + " " + s.Title + " " + s.Summary)
		ok := true
		for _, w := range words {
			if !strings.Contains(hay, w) {
				ok = false
				break
			}
		}
		if ok {
			out = append(out, s)
		}
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return out, nil
}

// Index renders the library for a system prompt: one line per skill.
func (l *Library) Index() string {
	all, err := l.List()
	if err != nil || len(all) == 0 {
		return ""
	}
	var b strings.Builder
	for _, s := range all {
		if s.Proposed {
			continue
		}
		fmt.Fprintf(&b, "- %s: %s\n", s.Name, s.Summary)
	}
	return b.String()
}
