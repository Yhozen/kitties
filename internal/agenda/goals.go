package agenda

import (
	"crypto/rand"
	"encoding/hex"
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

// Goal is something a kitty pursues on its own: on a schedule, when a service reports
// something, or when a person asks. The work happens in the goal's chat.
type Goal struct {
	ID    string `json:"id"`
	Kitty string `json:"kitty"` // kitty id
	Title string `json:"title"`
	// Text is what the kitty is told each time the goal runs.
	Text string `json:"text"`
	// Every is a cron expression; empty for a goal that only runs on events or by hand.
	Every string `json:"every,omitempty"`
	// On names the connectors whose incoming events run the goal.
	On      []string `json:"on,omitempty"`
	Enabled bool     `json:"enabled"`
	// Chat is the thread the goal is worked in, once there is one.
	Chat      string    `json:"chat,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	LastRun   time.Time `json:"last_run,omitempty"`
	NextRun   time.Time `json:"next_run,omitempty"`
	Runs      int       `json:"runs"`
	// LastResult is how the last run ended: done, blocked, escalated, delegated, failed.
	LastResult string `json:"last_result,omitempty"`
	// FromFile marks a goal that came from the configuration, which the page cannot edit.
	FromFile bool `json:"from_file,omitempty"`
}

// Validate checks a goal's fields and parses its schedule.
func (g *Goal) Validate() error {
	g.Title = strings.TrimSpace(g.Title)
	g.Text = strings.TrimSpace(g.Text)
	g.Every = strings.TrimSpace(g.Every)
	if g.Kitty == "" {
		return errors.New("a goal belongs to a kitty")
	}
	if g.Title == "" {
		return errors.New("a goal needs a title")
	}
	if g.Text == "" {
		g.Text = g.Title
	}
	if g.Every != "" {
		s, err := Parse(g.Every)
		if err != nil {
			return fmt.Errorf("schedule: %v", err)
		}
		g.Every = s.String()
	}
	if g.Every == "" && len(g.On) == 0 {
		return errors.New("a goal runs on a schedule (every), on events (on), or both")
	}
	for i, c := range g.On {
		g.On[i] = strings.TrimSpace(c)
		if g.On[i] == "" {
			return errors.New("on: an empty connector name")
		}
	}
	return nil
}

// Store keeps the goals in a JSON file.
type Store struct {
	path  string
	mu    sync.RWMutex
	goals map[string]*Goal
	now   func() time.Time
	newID func() string
}

// NewStore opens the goals at path (created on the first save).
func NewStore(path string) (*Store, error) {
	s := &Store{path: path, goals: map[string]*Goal{}, now: time.Now, newID: randomID}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return s, nil
		}
		return nil, err
	}
	var list []*Goal
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	interrupted := false
	for _, g := range list {
		if g.LastResult == "running" {
			g.LastResult = "interrupted"
			interrupted = true
		}
		s.goals[g.ID] = g
	}
	if interrupted {
		if err := s.save(); err != nil {
			return nil, err
		}
	}
	return s, nil
}

func randomID() string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// save writes the file; callers hold the lock.
func (s *Store) save() error {
	list := s.listLocked("")
	data, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	if err := statefs.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	return statefs.WriteFile(s.path, data, 0o600)
}

func (s *Store) listLocked(kitty string) []*Goal {
	var list []*Goal
	for _, g := range s.goals {
		if kitty == "" || g.Kitty == kitty {
			c := *g
			list = append(list, &c)
		}
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].Kitty != list[j].Kitty {
			return list[i].Kitty < list[j].Kitty
		}
		if !list[i].CreatedAt.Equal(list[j].CreatedAt) {
			return list[i].CreatedAt.Before(list[j].CreatedAt)
		}
		return list[i].ID < list[j].ID
	})
	return list
}

// List returns the goals, of one kitty when given, oldest first.
func (s *Store) List(kitty string) []*Goal {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.listLocked(kitty)
}

// Get returns one goal.
func (s *Store) Get(id string) (*Goal, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	g, ok := s.goals[id]
	if !ok {
		return nil, fmt.Errorf("no such goal %q", id)
	}
	c := *g
	return &c, nil
}

// Add keeps a new goal and returns it with its id and next run.
func (s *Store) Add(g Goal) (*Goal, error) {
	if err := g.Validate(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	g.ID = s.newID()
	g.CreatedAt = s.now()
	g.Runs, g.LastRun, g.LastResult = 0, time.Time{}, ""
	g.NextRun = nextRun(g, s.now())
	s.goals[g.ID] = &g
	if err := s.save(); err != nil {
		delete(s.goals, g.ID)
		return nil, err
	}
	c := g
	return &c, nil
}

// nextRun is when a goal with a schedule runs next, the zero time without one or when disabled.
func nextRun(g Goal, now time.Time) time.Time {
	if g.Every == "" || !g.Enabled {
		return time.Time{}
	}
	sched, err := Parse(g.Every)
	if err != nil {
		return time.Time{}
	}
	return sched.Next(now)
}

// Update changes a goal's title, text, schedule, triggers or enabled state.
func (s *Store) Update(id string, u Goal) (*Goal, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g, ok := s.goals[id]
	if !ok {
		return nil, fmt.Errorf("no such goal %q", id)
	}
	if g.FromFile {
		return nil, errors.New("this goal comes from the configuration file; edit it there")
	}
	next := *g
	next.Title, next.Text, next.Every, next.On, next.Enabled = u.Title, u.Text, u.Every, u.On, u.Enabled
	if err := next.Validate(); err != nil {
		return nil, err
	}
	next.NextRun = nextRun(next, s.now())
	s.goals[id] = &next
	if err := s.save(); err != nil {
		s.goals[id] = g
		return nil, err
	}
	c := next
	return &c, nil
}

// Remove forgets a goal.
func (s *Store) Remove(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	g, ok := s.goals[id]
	if !ok {
		return fmt.Errorf("no such goal %q", id)
	}
	if g.FromFile {
		return errors.New("this goal comes from the configuration file; remove it there")
	}
	delete(s.goals, id)
	return s.save()
}

// RemoveOf forgets every goal of a kitty (it was removed).
func (s *Store) RemoveOf(kitty string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for id, g := range s.goals {
		if g.Kitty == kitty {
			delete(s.goals, id)
			n++
		}
	}
	if n == 0 {
		return nil
	}
	return s.save()
}

// Sync replaces the goals that come from the configuration with these, keeping the run
// history of the ones that are still there (matched by kitty and title).
func (s *Store) Sync(fromFile []Goal) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	old := map[string]*Goal{}
	for id, g := range s.goals {
		if g.FromFile {
			old[g.Kitty+"\x00"+g.Title] = g
			delete(s.goals, id)
		}
	}
	for _, g := range fromFile {
		g.FromFile = true
		g.Enabled = true
		if err := g.Validate(); err != nil {
			return fmt.Errorf("goal %q of %s: %v", g.Title, g.Kitty, err)
		}
		if prev, ok := old[g.Kitty+"\x00"+g.Title]; ok {
			g.ID, g.CreatedAt, g.Chat, g.Runs, g.LastRun, g.LastResult = prev.ID, prev.CreatedAt, prev.Chat, prev.Runs, prev.LastRun, prev.LastResult
		} else {
			g.ID, g.CreatedAt = s.newID(), s.now()
		}
		g.NextRun = nextRun(g, s.now())
		c := g
		s.goals[g.ID] = &c
	}
	return s.save()
}

// started records that a run began: the count, the time and the next one.
func (s *Store) started(id string, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g, ok := s.goals[id]
	if !ok {
		return
	}
	g.Runs++
	g.LastRun = now
	g.LastResult = "running"
	g.NextRun = nextRun(*g, now)
	_ = s.save()
}

// skip moves a scheduled goal's next run on without counting a run (it was still busy).
func (s *Store) skip(id string, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if g, ok := s.goals[id]; ok {
		g.NextRun = nextRun(*g, now)
		_ = s.save()
	}
}

// attach remembers the chat a goal is worked in.
func (s *Store) attach(id, chatID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if g, ok := s.goals[id]; ok && chatID != "" && g.Chat != chatID {
		g.Chat = chatID
		_ = s.save()
	}
}

// Report records how a goal's last run ended.
func (s *Store) Report(id, result string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if g, ok := s.goals[id]; ok {
		g.LastResult = result
		_ = s.save()
	}
}

// due returns the enabled, scheduled goals whose next run is not after now.
func (s *Store) due(now time.Time) []*Goal {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*Goal
	for _, g := range s.listLocked("") {
		if g.Enabled && g.Every != "" && !g.NextRun.IsZero() && !g.NextRun.After(now) {
			out = append(out, g)
		}
	}
	return out
}

// listening returns the enabled goals that run on events of a connector.
func (s *Store) listening(connector string) []*Goal {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*Goal
	for _, g := range s.listLocked("") {
		if !g.Enabled {
			continue
		}
		for _, c := range g.On {
			if c == connector {
				out = append(out, g)
				break
			}
		}
	}
	return out
}
