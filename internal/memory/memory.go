// Package memory is what a kitty knows about the person it works for and about the work:
// preferences it was told or inferred, lessons from what went wrong, facts of a project, and a
// level of how demanding the person is. It grows from the person's feedback (a thumbs up or
// down, a yes or no to an action) and from what the kitty notes itself, is distilled into a
// short list now and then, and goes into the kitty's prompt, so it adapts to the person.
package memory

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/madkoding/kitties/internal/statefs"
)

// The scopes of a note: what the person likes, how the work goes, or a project.
const (
	ScopeUser = "user"
	ScopeWork = "work"
)

var projectScope = regexp.MustCompile(`^project:[a-z0-9][a-z0-9 _-]{0,39}$`)

// ValidScope reports whether s names a scope: user, work or project:<name>.
func ValidScope(s string) bool {
	return s == ScopeUser || s == ScopeWork || projectScope.MatchString(s)
}

// Slug is a project's name as a scope: lowercase letters, digits, spaces, dashes.
func Slug(name string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(name)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		case r == ' ':
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-_")
	if len(out) > 40 {
		out = strings.Trim(out[:40], "-_")
	}
	return out
}

// Note is one thing a kitty knows.
type Note struct {
	ID    string `json:"id"`
	Scope string `json:"scope"`
	Text  string `json:"text"`
	// Strength grows each time the same thing is learned again.
	Strength int       `json:"strength"`
	At       time.Time `json:"at"`
	Updated  time.Time `json:"updated"`
	// Source is who wrote it: person, kitty, feedback or distilled.
	Source string `json:"source"`
	// Pinned notes were written by the person: a distillation never drops them.
	Pinned bool `json:"pinned,omitempty"`
}

// Feedback is one verdict of the person on something a kitty did.
type Feedback struct {
	At     time.Time `json:"at"`
	Rating string    `json:"rating"` // up | down
	Note   string    `json:"note,omitempty"`
	// Excerpt is what the kitty said or did; Request is what it had been asked.
	Excerpt string `json:"excerpt,omitempty"`
	Request string `json:"request,omitempty"`
	// Source is turn or approval.
	Source string `json:"source"`
}

// Profile is how the person is with this kitty.
type Profile struct {
	// Demand is how demanding the person is, 1 (relaxed) to 5 (strict). It shapes how careful
	// the kitty is and how soon it is trusted with actions alone.
	Demand int `json:"demand"`
	// Auto lets the level follow the feedback; off, it stays where the person put it.
	Auto bool `json:"auto"`
	Up   int  `json:"up"`
	Down int  `json:"down"`
	// Recent are the last ratings, newest last ("u" or "d"): the window the level adapts on.
	Recent  []string  `json:"recent,omitempty"`
	Pending int       `json:"pending"` // feedback since the last distillation
	Updated time.Time `json:"updated"`
}

type file struct {
	Notes    []*Note    `json:"notes"`
	Profile  Profile    `json:"profile"`
	Feedback []Feedback `json:"feedback"`
}

// Limits of what is kept per kitty.
const (
	MaxNotes    = 60
	MaxFeedback = 60
	window      = 10
)

// Store keeps one file per kitty under dir.
type Store struct {
	dir string
	mu  sync.Mutex
	k   map[string]*file
	now func() time.Time
	id  func() string
}

// Open keeps the memories under dir.
func Open(dir string) *Store {
	return &Store{dir: dir, k: map[string]*file{}, now: time.Now, id: randomID}
}

func randomID() string {
	var b [5]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func (s *Store) path(kitty string) string {
	safe := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' {
			return r
		}
		return '_'
	}, kitty)
	return filepath.Join(s.dir, safe+".json")
}

// load returns a kitty's memory; callers hold the lock.
func (s *Store) load(kitty string) *file {
	if f, ok := s.k[kitty]; ok {
		return f
	}
	f := &file{Profile: Profile{Demand: 3, Auto: true}}
	if raw, err := os.ReadFile(s.path(kitty)); err == nil {
		var read file
		if json.Unmarshal(raw, &read) == nil {
			f = &read
			if f.Profile.Demand < 1 || f.Profile.Demand > 5 {
				f.Profile.Demand = 3
			}
		}
	}
	s.k[kitty] = f
	return f
}

func (s *Store) save(kitty string, f *file) {
	raw, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return
	}
	if statefs.MkdirAll(s.dir, 0o700) == nil {
		_ = statefs.WriteFile(s.path(kitty), raw, 0o600)
	}
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func norm(s string) string { return strings.ToLower(strings.Join(strings.Fields(s), " ")) }

// Remember keeps a note. The same thing learned again strengthens the note instead of
// repeating it; past MaxNotes the weakest, oldest unpinned note makes room.
func (s *Store) Remember(kitty, scope, text, source string, pinned bool) (*Note, error) {
	text = clip(strings.Join(strings.Fields(text), " "), 240)
	if text == "" {
		return nil, errors.New("a note needs text")
	}
	if scope == "" {
		scope = ScopeUser
	}
	if !ValidScope(scope) {
		return nil, fmt.Errorf("scope %q is not user, work or project:<name>", scope)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	f := s.load(kitty)
	for _, n := range f.Notes {
		if n.Scope == scope && norm(n.Text) == norm(text) {
			n.Strength++
			n.Updated = s.now()
			n.Pinned = n.Pinned || pinned
			s.save(kitty, f)
			c := *n
			return &c, nil
		}
	}
	n := &Note{ID: s.id(), Scope: scope, Text: text, Strength: 1, At: s.now(), Updated: s.now(), Source: source, Pinned: pinned}
	f.Notes = append(f.Notes, n)
	if len(f.Notes) > MaxNotes {
		s.evict(f)
	}
	s.save(kitty, f)
	c := *n
	return &c, nil
}

// evict drops the weakest, oldest note that is not pinned; callers hold the lock.
func (s *Store) evict(f *file) {
	worst := -1
	for i, n := range f.Notes {
		if n.Pinned {
			continue
		}
		if worst < 0 || n.Strength < f.Notes[worst].Strength || (n.Strength == f.Notes[worst].Strength && n.Updated.Before(f.Notes[worst].Updated)) {
			worst = i
		}
	}
	if worst >= 0 {
		f.Notes = append(f.Notes[:worst], f.Notes[worst+1:]...)
	}
}

// Forget removes one note.
func (s *Store) Forget(kitty, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	f := s.load(kitty)
	for i, n := range f.Notes {
		if n.ID == id {
			f.Notes = append(f.Notes[:i], f.Notes[i+1:]...)
			s.save(kitty, f)
			return nil
		}
	}
	return fmt.Errorf("no such note %q", id)
}

// ForgetKitty removes everything about a kitty that was removed.
func (s *Store) ForgetKitty(kitty string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.k, kitty)
	err := statefs.Remove(s.path(kitty))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// Notes returns a kitty's notes of a scope ("" for all), strongest first.
func (s *Store) Notes(kitty, scope string) []Note {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Note
	for _, n := range s.load(kitty).Notes {
		if scope == "" || n.Scope == scope {
			out = append(out, *n)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Strength != out[j].Strength {
			return out[i].Strength > out[j].Strength
		}
		return out[i].Updated.After(out[j].Updated)
	})
	return out
}

// Profile returns how the person is with the kitty.
func (s *Store) Profile(kitty string) Profile {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.load(kitty).Profile
	p.Recent = append([]string(nil), p.Recent...)
	return p
}

// SetProfile sets the level by hand (and whether it keeps following the feedback).
func (s *Store) SetProfile(kitty string, demand int, auto bool) (Profile, error) {
	if demand < 1 || demand > 5 {
		return Profile{}, errors.New("demand is a level from 1 (relaxed) to 5 (strict)")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	f := s.load(kitty)
	f.Profile.Demand, f.Profile.Auto = demand, auto
	f.Profile.Recent = nil
	f.Profile.Updated = s.now()
	s.save(kitty, f)
	return f.Profile, nil
}

// Demand is how demanding the person is with the kitty.
func (s *Store) Demand(kitty string) int { return s.Profile(kitty).Demand }

// Record keeps a verdict, and when the level follows the feedback, moves it: four downs in
// the last ten ratings make the person more demanding in the kitty's eyes, ten ups in a row
// make them more relaxed. It says whether the level changed.
func (s *Store) Record(kitty string, fb Feedback) (Profile, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f := s.load(kitty)
	if fb.At.IsZero() {
		fb.At = s.now()
	}
	fb.Excerpt, fb.Request, fb.Note = clip(fb.Excerpt, 300), clip(fb.Request, 300), clip(fb.Note, 300)
	f.Feedback = append(f.Feedback, fb)
	if len(f.Feedback) > MaxFeedback {
		f.Feedback = f.Feedback[len(f.Feedback)-MaxFeedback:]
	}
	p := &f.Profile
	mark := "u"
	if fb.Rating == "down" {
		mark = "d"
		p.Down++
	} else {
		p.Up++
	}
	p.Recent = append(p.Recent, mark)
	if len(p.Recent) > window {
		p.Recent = p.Recent[len(p.Recent)-window:]
	}
	p.Pending++
	p.Updated = s.now()
	changed := false
	if p.Auto {
		downs := strings.Count(strings.Join(p.Recent, ""), "d")
		switch {
		case downs >= 4 && p.Demand < 5:
			p.Demand++
			p.Recent, changed = nil, true
		case len(p.Recent) == window && downs == 0 && p.Demand > 1:
			p.Demand--
			p.Recent, changed = nil, true
		}
	}
	s.save(kitty, f)
	out := *p
	out.Recent = append([]string(nil), p.Recent...)
	return out, changed
}

// Pending is how much feedback came since the last distillation.
func (s *Store) Pending(kitty string) int { return s.Profile(kitty).Pending }

// Recent returns the last n verdicts, oldest first.
func (s *Store) Recent(kitty string, n int) []Feedback {
	s.mu.Lock()
	defer s.mu.Unlock()
	all := s.load(kitty).Feedback
	if n > 0 && len(all) > n {
		all = all[len(all)-n:]
	}
	return append([]Feedback(nil), all...)
}

// Distilled replaces the notes that are not pinned with a consolidated list and starts the
// feedback count over.
func (s *Store) Distilled(kitty string, notes []Note) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f := s.load(kitty)
	var kept []*Note
	for _, n := range f.Notes {
		if n.Pinned {
			kept = append(kept, n)
		}
	}
	for _, n := range notes {
		dup := false
		for _, k := range kept {
			dup = dup || (k.Scope == n.Scope && norm(k.Text) == norm(n.Text))
		}
		if dup || !ValidScope(n.Scope) || strings.TrimSpace(n.Text) == "" {
			continue
		}
		kept = append(kept, &Note{ID: s.id(), Scope: n.Scope, Text: clip(n.Text, 240), Strength: max(1, n.Strength), At: s.now(), Updated: s.now(), Source: "distilled"})
	}
	f.Notes = kept
	f.Profile.Pending = 0
	s.save(kitty, f)
}

// levels say how to work for a person of each level.
var levels = map[int]string{
	1: "They are relaxed: use your own judgement, do not ask about small things, and keep your reports brief.",
	2: "They are easygoing: act on your own for the usual, and mention what matters.",
	3: "They are balanced: check the important things, and say what you did.",
	4: "They are demanding: double-check your work, give your evidence, and ask before assuming anything that matters.",
	5: "They are strict: be exacting. Verify everything twice, show your evidence, never assume, and ask before anything that cannot be undone.",
}

// LevelText says how a level asks the kitty to work.
func LevelText(demand int) string { return levels[min(5, max(1, demand))] }

// Prompt is what goes into the kitty's prompt: what it learned, and how demanding the person is.
// project, when not empty, adds the notes of that project.
func (s *Store) Prompt(kitty, person, project string) string {
	if person == "" {
		person = "the person"
	}
	notes := s.Notes(kitty, "")
	p := s.Profile(kitty)
	var user, work, proj []string
	for _, n := range notes {
		line := "- " + n.Text
		switch {
		case n.Scope == ScopeUser && len(user) < 12:
			user = append(user, line)
		case n.Scope == ScopeWork && len(work) < 8:
			work = append(work, line)
		case project != "" && n.Scope == "project:"+project && len(proj) < 10:
			proj = append(proj, line)
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "How demanding %s is with you: %d of 5. %s\n", person, p.Demand, LevelText(p.Demand))
	if len(user) > 0 {
		fmt.Fprintf(&b, "What you have learned about %s and how they like things done (follow it):\n%s\n", person, strings.Join(user, "\n"))
	}
	if len(work) > 0 {
		fmt.Fprintf(&b, "Lessons about the work:\n%s\n", strings.Join(work, "\n"))
	}
	if len(proj) > 0 {
		fmt.Fprintf(&b, "What you know about this project:\n%s\n", strings.Join(proj, "\n"))
	}
	return b.String()
}
