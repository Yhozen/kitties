package agenda

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/madkoding/kitties/internal/statefs"
)

// The kinds of entry a journal holds.
const (
	KindRun       = "run"       // a goal started
	KindDone      = "done"      // the work finished
	KindBlocked   = "blocked"   // it could not finish (a limit, an error) and said so
	KindRetry     = "retry"     // it failed and tries another way
	KindEscalated = "escalated" // it asked the person for help
	KindDelegated = "delegated" // it handed work to another kitty
	KindRecovered = "recovered" // its container was brought back
	KindUpdated   = "updated"   // its desktop was moved to a newer image
	KindSkipped   = "skipped"   // a run was skipped (still busy)
	KindEvent     = "event"     // something arrived from a service
	KindApproval  = "approval"  // an action waited for a yes, or went ahead on trust
	KindLearned   = "learned"   // it noted something about the person or the work
)

// Entry is one line of a kitty's journal.
type Entry struct {
	At    time.Time `json:"at"`
	Kitty string    `json:"kitty"`
	Kind  string    `json:"kind"`
	Text  string    `json:"text"`
	Goal  string    `json:"goal,omitempty"`
	Chat  string    `json:"chat,omitempty"`
}

// Journal is an append-only record per kitty, one JSON line per entry under dir.
type Journal struct {
	dir string
	mu  sync.Mutex
	now func() time.Time
}

// NewJournal keeps the journals under dir.
func NewJournal(dir string) *Journal { return &Journal{dir: dir, now: time.Now} }

func (j *Journal) file(kitty string) string {
	return filepath.Join(j.dir, strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' {
			return r
		}
		return '_'
	}, kitty)+".jsonl")
}

// Add appends an entry (its time is set here when zero).
func (j *Journal) Add(e Entry) error {
	if e.At.IsZero() {
		e.At = j.now()
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if err := statefs.MkdirAll(j.dir, 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(e)
	if err != nil {
		return err
	}
	return statefs.AppendFile(j.file(e.Kitty), append(data, '\n'), 0o600)
}

// Recent returns the last n entries of a kitty, newest first.
func (j *Journal) Recent(kitty string, n int) []Entry {
	j.mu.Lock()
	defer j.mu.Unlock()
	f, err := os.Open(j.file(kitty))
	if err != nil {
		return nil
	}
	defer f.Close()
	var all []Entry
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		var e Entry
		if json.Unmarshal(sc.Bytes(), &e) == nil {
			all = append(all, e)
		}
	}
	if n > 0 && len(all) > n {
		all = all[len(all)-n:]
	}
	for i, k := 0, len(all)-1; i < k; i, k = i+1, k-1 {
		all[i], all[k] = all[k], all[i]
	}
	return all
}

// Forget removes a kitty's journal (it was removed).
func (j *Journal) Forget(kitty string) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	err := statefs.Remove(j.file(kitty))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
