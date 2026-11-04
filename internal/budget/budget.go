// Package budget counts what each kitty spends in a day: model tokens, and actions that reach
// other people or move money. The counts live in a JSON file, so a restart does not give a
// kitty a fresh day, and the days older than a fortnight are forgotten.
package budget

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/madkoding/kitties/internal/statefs"
)

// Day is what one kitty spent on one day.
type Day struct {
	Tokens  int `json:"tokens"`
	Actions int `json:"actions"`
	// Told is set once the person was told the token budget ran out, so it happens once a day.
	Told bool `json:"told,omitempty"`
}

// keep is how many days are remembered.
const keep = 14

// Store keeps the days per kitty.
type Store struct {
	path string
	mu   sync.Mutex
	d    map[string]map[string]*Day // kitty -> yyyy-mm-dd -> day
	now  func() time.Time
}

// Open reads the store at path (created on the first save).
func Open(path string) (*Store, error) {
	s := &Store{path: path, d: map[string]map[string]*Day{}, now: time.Now}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &s.d); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if s.d == nil {
		s.d = map[string]map[string]*Day{}
	}
	return s, nil
}

func (s *Store) today() string { return s.now().Format("2006-01-02") }

// day returns the record of a kitty today, creating it; callers hold the lock.
func (s *Store) day(kitty string) *Day {
	days := s.d[kitty]
	if days == nil {
		days = map[string]*Day{}
		s.d[kitty] = days
	}
	key := s.today()
	d := days[key]
	if d == nil {
		d = &Day{}
		days[key] = d
		if len(days) > keep {
			var keys []string
			for k := range days {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys[:len(keys)-keep] {
				delete(days, k)
			}
		}
	}
	return d
}

// save writes the file; callers hold the lock. A failure is returned but the counts stay in memory.
func (s *Store) save() error {
	raw, err := json.Marshal(s.d)
	if err != nil {
		return err
	}
	if err := statefs.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := statefs.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return statefs.Rename(tmp, s.path)
}

// AddTokens counts tokens spent by a kitty today.
func (s *Store) AddTokens(kitty string, n int) {
	if n <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.day(kitty).Tokens += n
	_ = s.save()
}

// AddActions counts actions a kitty took today.
func (s *Store) AddActions(kitty string, n int) {
	if n <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.day(kitty).Actions += n
	_ = s.save()
}

// Today is what a kitty has spent today.
func (s *Store) Today(kitty string) Day {
	s.mu.Lock()
	defer s.mu.Unlock()
	if d := s.d[kitty][s.today()]; d != nil {
		return *d
	}
	return Day{}
}

// Tell marks today's token warning as given and reports whether it was not given before.
func (s *Store) Tell(kitty string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.day(kitty)
	if d.Told {
		return false
	}
	d.Told = true
	_ = s.save()
	return true
}

// Forget drops a kitty's days.
func (s *Store) Forget(kitty string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.d[kitty]; !ok {
		return nil
	}
	delete(s.d, kitty)
	return s.save()
}
