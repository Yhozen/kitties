// Package chat runs the conversations: one person with one kitty, or a group where several
// kitties work together on the same thread.
//
// In a group, every message from the person goes to the kitties it mentions (@name), or to every
// member when it mentions none. Each kitty answers in turn and sees what the others said before
// it, labelled with their name, so the second one builds on the first instead of repeating it.
package chat

import (
	"context"
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

	"github.com/madkoding/kitties/internal/agenda"
	"github.com/madkoding/kitties/internal/approvals"
	"github.com/madkoding/kitties/internal/artifacts"
	"github.com/madkoding/kitties/internal/budget"
	"github.com/madkoding/kitties/internal/computer"
	"github.com/madkoding/kitties/internal/connector"
	"github.com/madkoding/kitties/internal/desktop"
	"github.com/madkoding/kitties/internal/kitty"
	"github.com/madkoding/kitties/internal/memory"
	"github.com/madkoding/kitties/internal/notify"
	"github.com/madkoding/kitties/internal/provider"
	"github.com/madkoding/kitties/internal/replay"
	"github.com/madkoding/kitties/internal/skills"
	"github.com/madkoding/kitties/internal/soul"
	"github.com/madkoding/kitties/internal/statefs"
	"github.com/madkoding/kitties/internal/vault"
)

// Turn is one message of a thread.
type Turn struct {
	At   time.Time `json:"at"`
	From string    `json:"from"` // "user", a kitty's name, or "system" for connector results
	// Kitty is the kitty id when From is a kitty.
	Kitty string `json:"kitty,omitempty"`
	Text  string `json:"text"`
	// Calls are the connectors the kitty used in this turn, if any.
	Calls []connector.Result `json:"calls,omitempty"`
	Usage provider.Usage     `json:"usage,omitempty"`
	// Steps are the actions the kitty took on its desktop in this turn, with their screenshots.
	Steps []Step `json:"steps,omitempty"`
	// Artifacts names the files the kitty saved to the library in this turn.
	Artifacts []string `json:"artifacts,omitempty"`
	// Skills names the skills it read or proposed in this turn.
	Skills []string `json:"skills,omitempty"`
	// Working is true while the kitty is still acting on its desktop for this turn.
	Working     bool `json:"working,omitempty"`
	Interrupted bool `json:"interrupted,omitempty"`
	// NeedsHelp is true when the kitty gave up on this turn and asked the person.
	NeedsHelp bool `json:"needs_help,omitempty"`
	// Resumable is true when the task stopped on its budget (time, tokens or rounds) and can go
	// on from where it was: the kitty's next answer gets the steps it had taken.
	Resumable bool `json:"resumable,omitempty"`
	// Delegations are the subtasks the kitty handed to other kitties in this turn.
	Delegations []Delegation `json:"delegations,omitempty"`
	// Approvals are the actions this turn held for the person's yes.
	Approvals []ApprovalRef `json:"approvals,omitempty"`
	// Feedback is what the person said about the turn: "up", "down" or empty.
	Feedback string `json:"feedback,omitempty"`
	// Limits are the limits the kitty set on its own actions in this turn, because the person
	// asked: the page shows them, and can take each back.
	Limits []LimitRef `json:"limits,omitempty"`
	// Detail is the technical form of what the text says in plain words (an error as the
	// service wrote it), for whoever asks to see technical details.
	Detail string `json:"detail,omitempty"`
}

// LimitRef is a limit a kitty set on itself: the mode it set (empty for a limit lifted) and the
// one there was before, which undoing it puts back.
type LimitRef struct {
	Connector string `json:"connector"`
	Action    string `json:"action"`
	Mode      string `json:"mode"`
	Previous  string `json:"previous,omitempty"`
}

// ApprovalRef points at an action held for approval.
type ApprovalRef struct {
	ID        string `json:"id"`
	Connector string `json:"connector"`
	Action    string `json:"action"`
	Summary   string `json:"summary"`
}

// Delegation is a subtask one kitty handed to another.
type Delegation struct {
	Kitty   string `json:"kitty"` // the other kitty's name
	KittyID string `json:"kitty_id"`
	Chat    string `json:"chat"` // where it happened
	Task    string `json:"task"`
	Result  string `json:"result,omitempty"`
	Error   string `json:"error,omitempty"`
}

// Step is one action on the desktop.
type Step struct {
	At     time.Time      `json:"at"`
	Action string         `json:"action"`
	Args   map[string]any `json:"args,omitempty"`
	Result string         `json:"result,omitempty"`
	Error  string         `json:"error,omitempty"`
	// Shot is the screenshot taken after this step, as a file name under the chat's shots
	// (served by the gateway); empty when the step took none.
	Shot string `json:"shot,omitempty"`
}

// Session is one thread.
type Session struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Members   []string  `json:"members"` // kitty ids
	Turns     []Turn    `json:"turns"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	// Goal is the goal this thread works on, when the scheduler opened it.
	Goal string `json:"goal,omitempty"`
	// Owner is the kitty that opened this thread to delegate, and Depth how many hand-overs
	// deep it is (a person's chat is 0).
	Owner string `json:"owner,omitempty"`
	Depth int    `json:"depth,omitempty"`
	// Help says the last turn is a kitty asking for help; set on the copies Get and List hand out.
	Help bool `json:"needs_help,omitempty"`
	// Summary stands for the first SummaryUpTo turns, which the kitties no longer see one by
	// one: a long thread keeps its early context in a few lines instead of dropping it.
	Summary     string `json:"summary,omitempty"`
	SummaryUpTo int    `json:"summary_up_to,omitempty"`
	// Pending records the initial model/connector turn before it becomes a desktop task.
	Pending string `json:"pending,omitempty"`
}

// NeedsHelp reports whether the last turn is a kitty asking the person for help.
func (s *Session) NeedsHelp() bool {
	return len(s.Turns) > 0 && s.Turns[len(s.Turns)-1].NeedsHelp
}

// Group reports whether the session has more than one kitty.
func (s *Session) Group() bool { return len(s.Members) > 1 }

// Working reports whether a kitty is still acting on its desktop in this session.
func (s *Session) Working() bool {
	if s.Pending != "" {
		return true
	}
	for i := range s.Turns {
		if s.Turns[i].Working {
			return true
		}
	}
	return false
}

// ErrBusy is returned when a message arrives while a kitty is still working on the thread.
var ErrBusy = errors.New("the kitties are still working on this chat")

// Fleet is what the chat needs from the orchestrator.
type Fleet interface {
	Get(ref string) (*kitty.Kitty, error)
	List() []*kitty.Kitty
	Brain(k *kitty.Kitty) (provider.Client, error)
	Connectors() *connector.Registry
}

// Service runs and stores the sessions.
type Service struct {
	shutdownCtx    context.Context
	cancelShutdown context.CancelFunc
	stopping       bool
	turnWG         sync.WaitGroup
	fleet          Fleet
	dir            string
	user           string

	mu       sync.RWMutex
	sessions map[string]*Session
	// running serialises the turns of one session.
	running map[string]*sync.Mutex
	// vault holds the secrets a kitty may type without reading them, nil when there is none.
	vault *vault.Store
	// helps are the kitties waiting for the person's answer, by turn (help.go).
	helps map[string]chan HelpAnswer
	now   func() time.Time
	newID func() string
	// MaxRounds bounds how many times a kitty may call connectors in one answer.
	MaxRounds int
	// MaxTurns is how much of the thread a kitty is shown.
	MaxTurns int
	// MaxSteps bounds how many desktop rounds a task may take in one turn.
	MaxSteps int
	// skills and arts are the libraries, nil when the deployment has none.
	skills *skills.Library
	arts   *artifacts.Store
	// tasks are the background desktop tasks in flight, by session id.
	tasks map[string]*task
	// watchers are the subscribers of each session.
	watchers map[string]map[chan Event]struct{}
	// nativeTools lets a kitty call tools in its provider's own format when it can.
	nativeTools bool
	// wg counts the background tasks, so a test (or a shutdown) can wait for them.
	wg sync.WaitGroup
	// DefaultLimits bound a task of a kitty that sets none of its own.
	DefaultLimits kitty.Limits
	// MaxDepth is how many hand-overs deep a delegation may go.
	MaxDepth int
	// journal and goals are the agenda's record and its report line, nil without an agenda.
	journal *agenda.Journal
	goals   Reporter
	// approvals holds the actions waiting for a yes, nil when nothing is held back.
	approvals *approvals.Store
	budget    *budget.Store
	// demand is how demanding a kitty's person is (1 relaxed to 5 strict); 3 when unset.
	demand func(kittyID string) int
	// notifier tells the person what happened outside the interface, nil when it does not.
	notifier notify.Sender
	// learnFromApproval hears every decision of the person, to learn from it; nil without memory.
	learnFromApproval func(approvals.Approval)
	// memory is what the kitties know about the person and the work, nil without it.
	memory *memory.Store
	// distilling marks the kitties whose memory is being consolidated, so it runs once at a time.
	distilling map[string]bool
	// CompactAfter is how many turns past the last summary a thread may grow before the early
	// ones are summarised; CompactKeep is how many of the latest stay as they were said.
	CompactAfter int
	CompactKeep  int
	// pollEvery is how often a delegating kitty looks whether the other one finished.
	pollEvery time.Duration
}

// Reporter hears how a goal's run ended.
type Reporter interface {
	Report(goalID, result string)
}

// task is one desktop task running in the background.
type task struct {
	cancel context.CancelFunc
}

// Event is what a watcher of a session is told.
type Event struct {
	Type    string `json:"type"` // turn | update | done | deleted
	Session string `json:"session"`
	Index   int    `json:"index"`
	Turn    *Turn  `json:"turn,omitempty"`
}

// Subscribe watches a session: every new or changed turn arrives on the channel until unsubscribe.
func (s *Service) Subscribe(id string) (<-chan Event, func()) {
	ch := make(chan Event, 64)
	s.mu.Lock()
	if s.watchers == nil {
		s.watchers = map[string]map[chan Event]struct{}{}
	}
	if s.watchers[id] == nil {
		s.watchers[id] = map[chan Event]struct{}{}
	}
	s.watchers[id][ch] = struct{}{}
	s.mu.Unlock()
	return ch, func() {
		s.mu.Lock()
		if set := s.watchers[id]; set != nil {
			delete(set, ch)
		}
		s.mu.Unlock()
	}
}

// emitLocked tells the watchers of a session; the caller holds the lock. A slow watcher loses
// the event rather than holding everyone else.
func (s *Service) emitLocked(ev Event) {
	for ch := range s.watchers[ev.Session] {
		select {
		case ch <- ev:
		default:
		}
	}
}

// SetNativeTools is whether kitties call tools natively when their provider can (on by default).
func (s *Service) SetNativeTools(on bool) { s.nativeTools = on }

// New creates the service, loading the sessions kept in dir.
func New(fleet Fleet, dir string) (*Service, error) {
	s := &Service{fleet: fleet, dir: dir, sessions: map[string]*Session{}, running: map[string]*sync.Mutex{},
		now: time.Now, newID: randomID, MaxRounds: 4, MaxTurns: 60, MaxSteps: 25, tasks: map[string]*task{}, nativeTools: true,
		DefaultLimits: kitty.Limits{MaxTokens: 400000, MaxSeconds: 1800, Retries: 1}, MaxDepth: 2, pollEvery: 200 * time.Millisecond,
		distilling: map[string]bool{}, CompactAfter: 40, CompactKeep: 16}
	s.shutdownCtx, s.cancelShutdown = context.WithCancel(context.Background())
	if err := s.load(); err != nil {
		s.cancelShutdown()
		return nil, err
	}
	return s, nil
}

// SetUser sets how kitties refer to the person.
func (s *Service) SetUser(name string) { s.user = name }

// SetLibrary gives the kitties the skills and the artifacts.
func (s *Service) SetLibrary(sk *skills.Library, arts *artifacts.Store) {
	s.skills, s.arts = sk, arts
}

// libraryPrompt tells a kitty what it can look up and keep.
func (s *Service) libraryPrompt() string {
	var b strings.Builder
	if s.skills != nil {
		b.WriteString("You have a library of skills (procedures). Read one with a line `@skill read <name>` " +
			"before a task it covers; when you learn a procedure worth keeping, propose it with " +
			"`@skill save {\"name\": \"…\", \"body\": \"# Title\\n\\nHow to…\"}` (a person accepts it).\n")
		if idx := s.skills.Index(); idx != "" {
			b.WriteString("Skills:\n" + idx)
		}
	}
	if s.arts != nil {
		b.WriteString("You have a library of artifacts (files) shared by every kitty. Keep a result for later " +
			"with `@artifact save {\"name\": \"report.md\", \"content\": \"…\"}`, read one with " +
			"`@artifact read <name>`, list them with `@artifact list`.\n")
		if idx := s.arts.Index(12); idx != "" {
			b.WriteString("Artifacts:\n" + idx)
		}
	}
	return b.String()
}

// Directive is one `@skill` or `@artifact` line of a reply.
type Directive struct {
	Kind string // skill | artifact
	Verb string // read | save | list
	Args map[string]any
	Raw  string
}

// parseDirectives finds the library lines of a reply and returns them with the remaining text.
func parseDirectives(text string) ([]Directive, string) {
	var out []Directive
	var kept []string
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(strings.Trim(strings.TrimSpace(line), "`"))
		kind := ""
		switch {
		case strings.HasPrefix(trimmed, "@skill "):
			kind = "skill"
		case strings.HasPrefix(trimmed, "@artifact "):
			kind = "artifact"
		case strings.HasPrefix(trimmed, "@delegate "):
			kind = "delegate"
		case strings.HasPrefix(trimmed, "@memory "):
			kind = "memory"
		case strings.HasPrefix(trimmed, "@limit "):
			kind = "limit"
		default:
			kept = append(kept, line)
			continue
		}
		rest := strings.TrimSpace(strings.TrimPrefix(trimmed, "@"+kind+" "))
		verb, argsText, _ := strings.Cut(rest, " ")
		d := Directive{Kind: kind, Verb: strings.ToLower(strings.TrimSpace(verb)), Raw: trimmed, Args: map[string]any{}}
		if argsText = strings.TrimSpace(argsText); argsText != "" {
			if err := json.Unmarshal([]byte(argsText), &d.Args); err != nil {
				key := "name"
				switch kind {
				case "delegate":
					key = "task"
				case "memory":
					key = "text"
				}
				d.Args[key] = strings.Trim(argsText, "\"' ")
			}
		}
		out = append(out, d)
	}
	return out, strings.TrimSpace(strings.Join(kept, "\n"))
}

func argText(args map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := args[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

// runDirective executes one library line for a kitty and says what happened.
func (s *Service) runDirective(d Directive, k *kitty.Kitty, turn *Turn) string {
	name := argText(d.Args, "name", "skill", "file")
	switch d.Kind {
	case "skill":
		if s.skills == nil {
			return "[skill] there is no skills library here"
		}
		switch d.Verb {
		case "read", "get", "show":
			sk, err := s.skills.Get(name)
			if err != nil {
				return "[skill " + name + "] " + err.Error()
			}
			turn.Skills = append(turn.Skills, sk.Name)
			return "[skill " + sk.Name + "]\n" + sk.Body
		case "save", "propose", "write":
			body := argText(d.Args, "body", "content", "text")
			sk, err := s.skills.Propose(name, body)
			if err != nil {
				return "[skill save] " + err.Error()
			}
			turn.Skills = append(turn.Skills, sk.Name)
			return "[skill " + sk.Name + "] proposed; a person will accept it from the library"
		case "list", "search":
			found, err := s.skills.Search(argText(d.Args, "query", "name"), 20)
			if err != nil {
				return "[skill list] " + err.Error()
			}
			var b strings.Builder
			for _, sk := range found {
				fmt.Fprintf(&b, "- %s: %s\n", sk.Name, sk.Summary)
			}
			return "[skills]\n" + strings.TrimSpace(b.String())
		}
	case "artifact":
		if s.arts == nil {
			return "[artifact] there is no artifacts library here"
		}
		switch d.Verb {
		case "save", "write", "put":
			content := argText(d.Args, "content", "text", "body")
			a, err := s.arts.Put(name, []byte(content), k.Name)
			if err != nil {
				return "[artifact save] " + err.Error()
			}
			turn.Artifacts = append(turn.Artifacts, a.Name)
			return "[artifact " + a.Name + "] saved (" + a.Type + ", " + fmt.Sprint(a.Size) + " bytes)"
		case "read", "get", "open":
			data, err := s.arts.Get(name)
			if err != nil {
				return "[artifact " + name + "] " + err.Error()
			}
			text := string(data)
			if len(text) > 6000 {
				text = text[:6000] + "…"
			}
			return "[artifact " + name + "]\n" + text
		case "list", "ls":
			idx := s.arts.Index(50)
			if idx == "" {
				idx = "(none yet)"
			}
			return "[artifacts]\n" + strings.TrimSpace(idx)
		}
	}
	return "[" + d.Kind + "] unknown verb " + d.Verb + " (read, save or list)"
}

// keepFiles saves the files connectors answered with into the artifacts library.
func (s *Service) keepFiles(results []connector.Result, k *kitty.Kitty, turn *Turn) {
	for i := range results {
		if results[i].File == nil || s.arts == nil {
			continue
		}
		a, err := s.arts.Put(results[i].File.Name, results[i].File.Data, k.Name)
		if err != nil {
			results[i].Err = err.Error()
			continue
		}
		results[i].Artifact = a.Name
		turn.Artifacts = append(turn.Artifacts, a.Name)
	}
}

func randomID() string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func (s *Service) load() error {
	entries, err := os.ReadDir(s.dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read the chats: %w", err)
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(s.dir, e.Name()))
		if err != nil {
			return err
		}
		var sess Session
		if err := json.Unmarshal(data, &sess); err != nil {
			return fmt.Errorf("the chat %s is damaged: %w", e.Name(), err)
		}
		changed := false
		for i := range sess.Turns {
			if sess.Turns[i].Working {
				t := &sess.Turns[i]
				t.Working, t.Interrupted, t.NeedsHelp, t.Resumable = false, true, true, true
				t.Detail = "Gateway restarted during this task. Review completed actions before continuing; nothing was replayed."
				changed = true
			}
		}
		if sess.Pending != "" {
			name := sess.Pending
			if k, err := s.fleet.Get(sess.Pending); err == nil {
				name = k.Name
			}
			sess.Turns = append(sess.Turns, Turn{At: s.now(), From: name, Kitty: sess.Pending, Interrupted: true, NeedsHelp: true, Resumable: true, Text: "The gateway restarted while I was answering. Review any completed actions before asking me to continue."})
			sess.Pending = ""
			changed = true
		}
		s.sessions[sess.ID] = &sess
		if changed {
			if err := s.save(&sess); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Service) save(sess *Session) error {
	if err := statefs.MkdirAll(s.dir, 0o700); err != nil {
		return fmt.Errorf("create the chats folder: %w", err)
	}
	data, err := json.MarshalIndent(sess, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(s.dir, sess.ID+".json")
	if err := statefs.WriteFile(path+".tmp", data, 0o600); err != nil {
		return fmt.Errorf("save the chat: %w", err)
	}
	return statefs.Rename(path+".tmp", path)
}

// Create opens a session with the given kitties (ids or names).
func (s *Service) Create(title string, members []string) (*Session, error) {
	if len(members) == 0 {
		return nil, errors.New("a chat needs at least one kitty")
	}
	ids := make([]string, 0, len(members))
	names := make([]string, 0, len(members))
	seen := map[string]bool{}
	for _, ref := range members {
		k, err := s.fleet.Get(ref)
		if err != nil {
			return nil, err
		}
		if seen[k.ID] {
			continue
		}
		seen[k.ID] = true
		ids = append(ids, k.ID)
		names = append(names, k.Name)
	}
	if title == "" {
		title = strings.Join(names, ", ")
	}
	now := s.now()
	sess := &Session{ID: s.newID(), Title: title, Members: ids, Turns: []Turn{}, CreatedAt: now, UpdatedAt: now}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopping {
		return nil, ErrShuttingDown
	}
	s.sessions[sess.ID] = sess
	if err := s.save(sess); err != nil {
		delete(s.sessions, sess.ID)
		return nil, err
	}
	return sess, nil
}

// AddMembers adds kitties to a session.
func (s *Service) AddMembers(id string, members []string) (*Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[id]
	if !ok {
		return nil, fmt.Errorf("no such chat %q", id)
	}
	for _, ref := range members {
		k, err := s.fleet.Get(ref)
		if err != nil {
			return nil, err
		}
		if !contains(sess.Members, k.ID) {
			sess.Members = append(sess.Members, k.ID)
		}
	}
	sess.UpdatedAt = s.now()
	return sess, s.save(sess)
}

// RemoveMember takes a kitty out of a session.
func (s *Service) RemoveMember(id, ref string) (*Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[id]
	if !ok {
		return nil, fmt.Errorf("no such chat %q", id)
	}
	k, err := s.fleet.Get(ref)
	if err != nil {
		return nil, err
	}
	if len(sess.Members) == 1 && sess.Members[0] == k.ID {
		return nil, errors.New("a chat needs at least one kitty: delete the chat instead")
	}
	kept := sess.Members[:0]
	for _, m := range sess.Members {
		if m != k.ID {
			kept = append(kept, m)
		}
	}
	sess.Members = kept
	sess.UpdatedAt = s.now()
	return sess, s.save(sess)
}

// LeaveChats takes a removed kitty out of every chat, and deletes the chats it leaves with no
// kitty at all: a chat with nobody to answer is not a chat.
func (s *Service) LeaveChats(id string) error {
	return s.Prune(func(member string) bool { return member != id })
}

// Prune keeps, in every chat, only the members that still exist, and deletes the chats left
// with none (for instance the ones whose kitties were removed before chats were cleaned up).
func (s *Service) Prune(exists func(id string) bool) error {
	s.mu.Lock()
	var empty []string
	var firstErr error
	for id, sess := range s.sessions {
		kept := make([]string, 0, len(sess.Members))
		for _, m := range sess.Members {
			if exists(m) {
				kept = append(kept, m)
			}
		}
		if len(kept) == len(sess.Members) {
			continue
		}
		if len(kept) == 0 {
			empty = append(empty, id)
			continue
		}
		sess.Members = kept
		if err := s.save(sess); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	s.mu.Unlock()
	for _, id := range empty {
		if err := s.Delete(id); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// Get returns a copy of the session.
func (s *Service) Get(id string) (*Session, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	sess, ok := s.sessions[id]
	if !ok {
		return nil, fmt.Errorf("no such chat %q", id)
	}
	c := *sess
	c.Members = append([]string(nil), sess.Members...)
	c.Turns = append([]Turn(nil), sess.Turns...)
	c.Help = sess.NeedsHelp()
	return &c, nil
}

// List returns every session, newest first, without the turns.
func (s *Service) List() []*Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*Session, 0, len(s.sessions))
	for _, sess := range s.sessions {
		c := *sess
		c.Turns = nil
		c.Help = sess.NeedsHelp()
		out = append(out, &c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	return out
}

// Delete removes a session.
func (s *Service) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.sessions[id]; !ok {
		return fmt.Errorf("no such chat %q", id)
	}
	if t, ok := s.tasks[id]; ok {
		t.cancel()
	}
	delete(s.sessions, id)
	s.emitLocked(Event{Type: "deleted", Session: id})
	_ = statefs.RemoveAll(filepath.Join(s.dir, id))
	err := statefs.Remove(filepath.Join(s.dir, id+".json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

var mention = regexp.MustCompile(`@([a-z0-9][a-z0-9-]*)`)

// Send posts the person's message and returns the kitties' replies.
func (s *Service) Send(ctx context.Context, id, text string) ([]Turn, error) {
	return s.send(ctx, id, "user", "", text)
}

// send posts a message from someone (the person, the scheduler, or a kitty delegating) and has
// the kitties answer it.
func (s *Service) send(ctx context.Context, id, from, fromID, text string) ([]Turn, error) {
	ctx, done, err := s.beginTurn(ctx)
	if err != nil {
		return nil, err
	}
	defer done()
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, errors.New("the message is empty")
	}
	lock := s.lockFor(id)
	lock.Lock()
	defer lock.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	s.mu.Lock()
	sess, ok := s.sessions[id]
	if !ok {
		s.mu.Unlock()
		return nil, fmt.Errorf("no such chat %q", id)
	}
	if sess.Working() {
		s.mu.Unlock()
		return nil, ErrBusy
	}
	sess.Turns = append(sess.Turns, Turn{At: s.now(), From: from, Kitty: fromID, Text: text})
	sess.UpdatedAt = s.now()
	members := append([]string(nil), sess.Members...)
	goal := sess.Goal
	err = s.save(sess)
	s.emitLocked(Event{Type: "turn", Session: id, Index: len(sess.Turns) - 1, Turn: &sess.Turns[len(sess.Turns)-1]})
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}

	kitties := make([]*kitty.Kitty, 0, len(members))
	for _, m := range members {
		k, err := s.fleet.Get(m)
		if err != nil {
			continue
		}
		kitties = append(kitties, k)
	}
	if len(kitties) == 0 {
		return nil, errors.New("the chat has no kitties left")
	}
	responders := s.responders(kitties, text)
	var replies []Turn
	for _, k := range responders {
		if err := ctx.Err(); err != nil {
			return replies, err
		}
		s.mu.Lock()
		sess.Pending = k.ID
		err := s.save(sess)
		s.mu.Unlock()
		if err != nil {
			return replies, err
		}
		turn, pending, err := s.answerWithActivity(ctx, id, k, kitties)
		if err != nil {
			turn = Turn{At: s.now(), From: k.Name, Kitty: k.ID, Text: "(" + k.Name + " could not answer: " + Plain(err.Error()) + ")", Detail: err.Error()}
		}
		s.mu.Lock()
		sess.Pending = ""
		sess.Turns = append(sess.Turns, turn)
		index := len(sess.Turns) - 1
		sess.UpdatedAt = s.now()
		saveErr := s.save(sess)
		s.emitLocked(Event{Type: "turn", Session: id, Index: index, Turn: &sess.Turns[index]})
		s.mu.Unlock()
		if saveErr != nil {
			if pending != nil && pending.release != nil {
				pending.release()
			}
			return replies, saveErr
		}
		replies = append(replies, turn)
		if pending != nil {
			s.startTask(id, index, k, pending)
			// The kitties after this one in a group wait for the task: they answer on the
			// person's next message, with the task's result in the thread.
			return replies, nil
		}
		if goal != "" {
			// A goal answered in words alone: the run is over.
			result := "done"
			if err != nil {
				result = "blocked"
			}
			s.reportGoal(k, goal, id, result, turn.Text)
		}
	}
	return replies, nil
}

// Cancel stops the desktop task running in a session, if any.
func (s *Service) Cancel(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tasks[id]
	if !ok {
		return false
	}
	t.cancel()
	return true
}

// Wait blocks until every background task has ended.
func (s *Service) Wait() { s.wg.Wait() }

// Shot reads one screenshot of a session.
func (s *Service) Shot(id, name string) ([]byte, error) {
	if !shotName.MatchString(name) {
		return nil, fmt.Errorf("no such screenshot %q", name)
	}
	if _, err := s.Get(id); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(s.dir, id, name))
	if err != nil {
		return nil, fmt.Errorf("no such screenshot %q", name)
	}
	return data, nil
}

// AnyBusy reports whether any kitty is in the middle of a task, in any chat.
func (s *Service) AnyBusy() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, sess := range s.sessions {
		if sess.Pending != "" {
			return true
		}
		for _, t := range sess.Turns {
			if t.Working {
				return true
			}
		}
	}
	return false
}

// KittyBusy reports whether a kitty is in the middle of a task, in any chat.
func (s *Service) KittyBusy(kittyID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, sess := range s.sessions {
		if sess.Pending == kittyID {
			return true
		}
		for _, t := range sess.Turns {
			if t.Working && t.Kitty == kittyID {
				return true
			}
		}
	}
	return false
}

// Replay is the film of a turn's desktop task: its screenshots, in order, as an animated GIF.
func (s *Service) Replay(id string, index int) ([]byte, error) {
	sess, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if index < 0 || index >= len(sess.Turns) {
		return nil, fmt.Errorf("no such turn %d", index)
	}
	var shots [][]byte
	for _, st := range sess.Turns[index].Steps {
		if st.Shot == "" {
			continue
		}
		if data, err := s.Shot(id, st.Shot); err == nil {
			shots = append(shots, data)
		}
	}
	return replay.GIF(shots, replay.Default)
}

var shotName = regexp.MustCompile(`^[0-9]+-[0-9]+\.png$`)

func (s *Service) lockFor(id string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	l, ok := s.running[id]
	if !ok {
		l = &sync.Mutex{}
		s.running[id] = l
	}
	return l
}

// responders picks who answers: the kitties the message mentions, or every member.
func (s *Service) responders(kitties []*kitty.Kitty, text string) []*kitty.Kitty {
	if len(kitties) == 1 {
		return kitties
	}
	var picked []*kitty.Kitty
	for _, m := range mention.FindAllStringSubmatch(strings.ToLower(text), -1) {
		for _, k := range kitties {
			if k.Name == m[1] && !containsKitty(picked, k) {
				picked = append(picked, k)
			}
		}
	}
	if len(picked) == 0 {
		return kitties
	}
	return picked
}

func containsKitty(list []*kitty.Kitty, k *kitty.Kitty) bool {
	for _, x := range list {
		if x.ID == k.ID {
			return true
		}
	}
	return false
}

// pendingTask is a turn whose kitty asked to act on its desktop: the loop continues in the
// background from these messages and actions.
type pendingTask struct {
	admissionContext context.Context
	release          func()
	brain            provider.Client
	messages         []provider.Message
	tools            []provider.Tool
	native           bool
	reply            provider.Reply
	text             string
	actions          []action
	allowed          map[string]string
	// pre are the outcomes of the batch's connector and library actions, already run in the
	// call that answered the person, by their index in actions.
	pre map[int]outcome
}

// ask asks the brain, with the tools when native.
func ask(ctx context.Context, brain provider.Client, native bool, messages []provider.Message, tools []provider.Tool) (provider.Reply, error) {
	if native {
		if tc, ok := brain.(provider.ToolClient); ok {
			return tc.CompleteTools(ctx, messages, tools)
		}
	}
	return brain.Complete(ctx, messages)
}

type activityFleet interface {
	Acquire(context.Context, string) (func(), error)
}

func (s *Service) answerWithActivity(ctx context.Context, id string, k *kitty.Kitty, members []*kitty.Kitty) (Turn, *pendingTask, error) {
	release := func() {}
	if fleet, ok := s.fleet.(interface {
		AcquireActivity(context.Context, string) (context.Context, func(), error)
	}); ok {
		var err error
		ctx, release, err = fleet.AcquireActivity(ctx, k.ID)
		if err != nil {
			return Turn{}, nil, err
		}
	} else if fleet, ok := s.fleet.(activityFleet); ok {
		var err error
		release, err = fleet.Acquire(ctx, k.ID)
		if err != nil {
			return Turn{}, nil, err
		}
	}
	turn, pending, err := s.answer(computer.WithActivity(ctx, k.ID), id, k, members)
	if pending != nil {
		pending.release = release
		pending.admissionContext = ctx
	} else {
		release()
	}
	return turn, pending, err
}

// answer asks one kitty for its turn, running the connectors it calls. When the kitty asks to
// act on its desktop, the turn is returned as it stands with the pending task to continue.
func (s *Service) answer(ctx context.Context, id string, k *kitty.Kitty, members []*kitty.Kitty) (Turn, *pendingTask, error) {
	brain, err := s.fleet.Brain(k)
	if err != nil {
		return Turn{}, nil, err
	}
	allowed := s.fleet.Connectors().Descriptions(k.Connectors)
	var group []string
	for _, m := range members {
		if m.ID != k.ID {
			group = append(group, m.Name)
		}
	}
	system := k.Soul.SystemPrompt(soul.Context{
		KittyName: k.Name, Desktop: k.Desktop, Workspace: workspaceOf(k), Group: group, Connectors: allowed, User: s.user,
		Peers: s.peers(k, id),
	})
	if k.Desktop {
		system += "\n" + desktop.Catalogue()
		if s.vault != nil {
			if names := s.vault.Names(k.ID); len(names) > 0 {
				system += "\nSecrets the person saved for you to type with type_secret (you are never shown them): " + strings.Join(names, ", ") + ".\n"
			}
		}
	}
	if lib := s.libraryPrompt(); lib != "" {
		system += "\n" + lib
	}
	s.compact(ctx, id, brain)
	sess, err := s.Get(id)
	if err != nil {
		return Turn{}, nil, err
	}
	system += s.memoryPrompt(k, sess)
	system += s.limitPrompt(allowed)
	if sess.Summary != "" {
		system += fmt.Sprintf("\nEarlier in this conversation (a summary of its first %d messages, which you no longer see one by one):\n%s\n", sess.SummaryUpTo, sess.Summary)
	}
	messages := s.transcript(system, sess.Turns[min(sess.SummaryUpTo, len(sess.Turns)):], k)

	native := false
	var tools []provider.Tool
	if tc, ok := brain.(provider.ToolClient); ok && s.nativeTools && tc.SupportsTools() {
		tools = s.toolSet(k, allowed)
		native = len(tools) > 0
	}
	turn := Turn{From: k.Name, Kitty: k.ID}
	var parts []string
	for round := 0; round < s.MaxRounds; round++ {
		if err := s.overTokens(k); err != nil {
			return Turn{}, nil, err
		}
		reply, err := ask(ctx, brain, native, messages, tools)
		if err != nil {
			return Turn{}, nil, err
		}
		s.spendTokens(k, reply.Usage)
		turn.Usage.Input += reply.Usage.Input
		turn.Usage.Output += reply.Usage.Output
		var actions []action
		text := reply.Content
		if native && len(reply.Calls) > 0 {
			actions = fromCalls(reply.Calls)
		} else {
			actions, text = fromText(reply.Content)
		}
		if text = strings.TrimSpace(text); text != "" {
			parts = append(parts, text)
		}
		// Without a display a desktop tool is just words, and without connectors a connector
		// call is too: both are dropped rather than answered.
		kept := actions[:0]
		for _, a := range actions {
			if (a.kind == "tool" && !k.Desktop) || (a.kind == "connector" && len(allowed) == 0) {
				continue
			}
			if a.kind == "delegate" && !s.canDelegate(k) {
				continue
			}
			kept = append(kept, a)
		}
		actions = kept
		if len(actions) == 0 {
			break
		}
		if hasDesktopAction(actions) {
			// Connector and library actions run first, in this call; the display's go on in
			// the background with everything the model needs to continue.
			pre := map[int]outcome{}
			for i, a := range actions {
				if a.kind != "tool" {
					pre[i] = s.runNonDesktop(ctx, id, []action{a}, k, allowed, &turn)[0]
				}
			}
			turn.At = s.now()
			turn.Text = strings.TrimSpace(strings.Join(parts, "\n\n"))
			turn.Working = true
			return turn, &pendingTask{brain: brain, messages: messages, tools: tools, native: native, reply: reply, text: reply.Content, actions: actions, allowed: allowed, pre: pre}, nil
		}
		outs := s.runNonDesktop(ctx, id, actions, k, allowed, &turn)
		messages = append(messages, feedback(native, reply, reply.Content, outs, nil)...)
	}
	turn.At = s.now()
	turn.Text = strings.TrimSpace(strings.Join(parts, "\n\n"))
	if turn.Text == "" {
		turn.Text = "(" + k.Name + " had nothing to add)"
	}
	return turn, nil, nil
}

// startTask continues a turn in the background: the kitty acts on its desktop, sees the
// screenshot, and goes on until it says done or the steps run out.
func (s *Service) startTask(id string, index int, k *kitty.Kitty, p *pendingTask) {
	parent := s.shutdownCtx
	if p.admissionContext != nil {
		parent = context.WithoutCancel(p.admissionContext)
	}
	ctx, cancel := context.WithCancel(parent)
	stopShutdown := context.AfterFunc(s.shutdownCtx, cancel)
	s.mu.Lock()
	s.tasks[id] = &task{cancel: cancel}
	s.mu.Unlock()
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer cancel()
		defer stopShutdown()
		if p.release != nil {
			defer p.release()
		}
		s.runTask(computer.WithActivity(ctx, k.ID), id, index, k, p)
		s.mu.Lock()
		delete(s.tasks, id)
		s.mu.Unlock()
	}()
}

// runner is the fleet as a desktop runner, when it is one.
// helpWait is how long a kitty that asked for help waits for the person to take its desktop.
var helpWait = 15 * time.Minute

// askHelp is the kitty asking the person to take its desktop over: the step shows a button to
// take control in the chat, a notification goes out, and the kitty waits until the person has
// taken the desktop and given it back (or does not come in time).
func (s *Service) askHelp(ctx context.Context, id string, index int, k *kitty.Kitty, reason string) string {
	// asked is taken before anything the person can see of the request: a desktop taken and given
	// back right after the step shows up still counts.
	asked := time.Now()
	reason = strings.TrimSpace(reason)
	if reason == "" || reason == "<nil>" {
		reason = "something on the desktop needs you"
	}
	s.appendStep(id, index, Step{At: s.now(), Action: "ask_help", Args: map[string]any{"reason": reason}, Result: reason})
	// The person sees what the kitty sees: its screen goes with the request.
	if runner := s.runner(); runner != nil {
		if png, err := runner.Screenshot(ctx, k.ID); err == nil {
			if name, err := s.saveShot(id, index, png); err == nil {
				s.markShot(id, index, name)
			}
		}
	}
	s.tell(notify.Help, k, "needs your hands on its desktop", reason, id)
	answers, stop := s.expectHelp(id, index)
	defer stop()
	h, ok := s.fleet.(holder)
	if !ok {
		return "nobody can take your desktop from here: say in your answer what you need, and stop"
	}
	started, _ := s.fleet.(holdStarter)
	deadline := time.NewTimer(helpWait)
	defer deadline.Stop()
	t := time.NewTicker(heldEvery)
	defer t.Stop()
	came := false
	for {
		held := h.Held(k.ID)
		came = came || held || started != nil && started.HoldStarted(k.ID).After(asked)
		if came && !held {
			s.appendStep(id, index, Step{At: s.now(), Action: "helped", Result: "took the desktop and gave it back"})
			return "the person took your desktop and gave it back: look at the screenshot and continue"
		}
		select {
		case <-ctx.Done():
			return "stopped"
		case a := <-answers:
			return s.applyHelp(ctx, id, index, k, a)
		case <-deadline.C:
			if !came {
				return fmt.Sprintf("nobody came in %d minutes: say in your answer what you need from the person, and stop", int(helpWait.Minutes()))
			}
		case <-t.C:
		}
	}
}

// holder knows whether the person has taken a kitty's display over (the orchestrator does).
type holder interface{ Held(id string) bool }

// holdStarter knows when the person last took a kitty's display.
type holdStarter interface{ HoldStarted(id string) time.Time }

// heldEvery is how often a kitty waiting for its display looks whether it is back.
var heldEvery = time.Second

// waitWhileHeld waits, before an action on the display, while the person uses it: the two never
// fight over the mouse. The wait shows in the chat as one step.
func (s *Service) waitWhileHeld(ctx context.Context, id string, index int, kittyID string) {
	h, ok := s.fleet.(holder)
	if !ok || !h.Held(kittyID) {
		return
	}
	s.appendStep(id, index, Step{At: s.now(), Action: "held", Result: "the person is using the desktop: waiting until they give it back"})
	t := time.NewTicker(heldEvery)
	defer t.Stop()
	for h.Held(kittyID) {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (s *Service) runner() desktop.Runner {
	r, _ := s.fleet.(desktop.Runner)
	return r
}

// taskState is what a background task carries between its rounds and attempts.
type taskState struct {
	messages  []provider.Message
	actions   []action
	reply     provider.Reply
	replyText string
	parts     []string
	final     string
	tokens    int
	rounds    int
	// lastShot and same follow the screen the kitty keeps seeing (stuck.go).
	lastShot [32]byte
	same     int
	// pre are the outcomes of the first batch's non-desktop actions, run before the task.
	pre map[int]outcome
	// detail is why the task failed, as the error said it.
	detail string
}

// runTask drives a desktop task to its end within the kitty's limits: rounds of actions, a
// screenshot after each, and the brain's next move; a failed attempt is tried another way as
// many times as the limits allow, and a task given up on is handed to the backup kitty or
// left with the person.
func (s *Service) runTask(ctx context.Context, id string, index int, k *kitty.Kitty, p *pendingTask) {
	limits := k.Limits.Or(s.DefaultLimits)
	if limits.MaxSeconds > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(limits.MaxSeconds)*time.Second)
		defer cancel()
	}
	st := &taskState{messages: p.messages, actions: p.actions, reply: p.reply, replyText: p.text, pre: p.pre, tokens: p.reply.Usage.Input + p.reply.Usage.Output}
	fail, retryable := "", false
	for attempt := 0; ; attempt++ {
		fail, retryable = s.attempt(ctx, id, index, k, p, st, limits)
		if fail == "" || !retryable || attempt >= limits.Retries {
			break
		}
		s.note(k, agenda.KindRetry, "", id, fmt.Sprintf("attempt %d failed (%s); trying another way", attempt+1, fail))
		st.parts = append(st.parts, fmt.Sprintf("(attempt %d failed: %s; trying another way)", attempt+1, fail))
		st.messages = append(st.messages, provider.Message{Role: "user", Content: "That attempt failed: " + fail + ". Try a different approach: do not repeat the same actions, and call done when the task is finished."})
		st.actions, st.rounds = nil, 0
	}
	if st.final != "" {
		st.parts = append(st.parts, st.final)
	}
	result, needsHelp := "done", false
	if fail != "" {
		result = "blocked"
		st.parts = append(st.parts, "("+k.Name+" could not finish: "+Plain(fail)+")")
		st.detail = fail
		if !errors.Is(ctx.Err(), context.Canceled) {
			// Given up, not stopped by a person: the backup takes over, or the person is asked.
			var handed string
			result, needsHelp, handed = s.giveUp(id, index, k, fail)
			if handed != "" {
				st.parts = append(st.parts, handed)
			}
		}
	}
	s.closeTask(id, index, k, strings.TrimSpace(strings.Join(st.parts, "\n\n")), needsHelp, result)
	if st.detail != "" {
		s.edit(id, index, func(t *Turn) {
			t.Detail = st.detail
			t.Resumable = strings.HasPrefix(fail, "stopped")
		})
	}
}

// recapSteps is how many of its last steps a kitty is reminded of when it goes on with a task.
const recapSteps = 30

// recap is what a kitty did in a task that stopped on its budget, for it to go on from there
// rather than start again: why it stopped, and its last steps with their results.
func recap(t Turn) string {
	var b strings.Builder
	fmt.Fprintf(&b, "(The task above stopped before it was finished: %s. The desktop is as I left it. My last steps were:", t.Detail)
	steps := t.Steps
	if len(steps) > recapSteps {
		steps = steps[len(steps)-recapSteps:]
	}
	for _, st := range steps {
		args, _ := json.Marshal(st.Args)
		line := "\n- " + st.Action + " " + string(args)
		if st.Error != "" {
			line += " -> failed: " + clip(st.Error, 160)
		} else if r := strings.TrimSpace(st.Result); r != "" {
			line += " -> " + clip(strings.ReplaceAll(r, "\n", " "), 160)
		}
		b.WriteString(line)
	}
	b.WriteString("\nWhen asked to go on, look at the screen first and continue from there, without repeating what worked.)")
	return b.String()
}

// attempt runs rounds until the task is done, the model stops asking for actions, or something
// gives: it returns why, and whether another attempt makes sense.
func (s *Service) attempt(ctx context.Context, id string, index int, k *kitty.Kitty, p *pendingTask, st *taskState, limits kitty.Limits) (fail string, retryable bool) {
	runner := s.runner()
	maxRounds := limits.MaxRounds
	if maxRounds == 0 {
		maxRounds = s.MaxSteps
	}
	for ; ; st.rounds++ {
		if runner == nil {
			return "this kitty has no desktop runner", false
		}
		if st.rounds >= maxRounds && !endsTask(st.actions) {
			return fmt.Sprintf("stopped after %d rounds without finishing", maxRounds), true
		}
		if ctx.Err() != nil {
			return stopReason(ctx, limits), false
		}
		var outs []outcome
		done := false
		// looked is whether something of this batch can have changed the display: only then a
		// new screenshot is worth its tokens.
		looked := false
		for i, a := range st.actions {
			if a.kind != "tool" {
				if o, ok := st.pre[i]; ok {
					outs = append(outs, o)
					continue
				}
				// A library, connector or delegation action in a later round runs here.
				var turn Turn
				o := s.runNonDesktop(ctx, id, []action{a}, k, p.allowed, &turn)
				s.edit(id, index, func(t *Turn) {
					t.Calls = append(t.Calls, turn.Calls...)
					t.Artifacts = append(t.Artifacts, turn.Artifacts...)
					t.Skills = append(t.Skills, turn.Skills...)
					t.Delegations = append(t.Delegations, turn.Delegations...)
				})
				outs = append(outs, o...)
				continue
			}
			da := desktop.Action{Name: a.name, Args: a.args, Raw: a.raw}
			if summary, ok := da.Done(); ok {
				st.final, done = summary, true
				s.appendStep(id, index, Step{At: s.now(), Action: a.name, Args: a.args, Result: summary})
				outs = append(outs, outcome{action: a, text: "finished"})
				break
			}
			if da.Name == "ask_help" {
				looked = true
				outs = append(outs, outcome{action: a, text: s.askHelp(ctx, id, index, k, fmt.Sprint(a.args["reason"]))})
				if ctx.Err() != nil {
					break
				}
				continue
			}
			if da.Name == "type_secret" {
				looked = true
				o := s.typeSecret(ctx, id, index, k, a)
				outs = append(outs, o)
				if ctx.Err() != nil {
					break
				}
				continue
			}
			s.waitWhileHeld(ctx, id, index, k.ID)
			looked = looked || da.Visual()
			out, err := desktop.Run(ctx, runner, k.ID, da)
			step := Step{At: s.now(), Action: a.name, Args: a.args, Result: out}
			o := outcome{action: a, text: out}
			if err != nil {
				step.Error = err.Error()
				o.err = err.Error()
			}
			outs = append(outs, o)
			s.appendStep(id, index, step)
			if ctx.Err() != nil {
				break
			}
		}
		st.pre = nil
		if done {
			return "", false
		}
		if ctx.Err() != nil {
			return stopReason(ctx, limits), false
		}
		if len(st.actions) > 0 {
			extra := provider.Message{Role: "user", Content: "Nothing on the display can have changed, so no screenshot comes with this: ask for screenshot or read_screen when you need to look. Continue with your next actions, or call done when the task is finished."}
			if looked {
				png, err := runner.Screenshot(ctx, k.ID)
				if err == nil && st.watchScreen(png) {
					extra = s.unstick(ctx, runner, id, index, k, png)
				} else {
					extra = s.screenMessage(id, index, png, err)
				}
			}
			st.messages = append(st.messages, feedback(p.native, st.reply, st.replyText, outs, &extra)...)
		}
		if len(st.messages) > s.MaxTurns*2 {
			st.messages = append(st.messages[:1], st.messages[len(st.messages)-s.MaxTurns*2:]...)
		}
		if err := s.overTokens(k); err != nil {
			return "stopped: " + err.Error(), false
		}
		answer, err := ask(ctx, p.brain, p.native, st.messages, p.tools)
		if err != nil {
			if ctx.Err() != nil {
				return stopReason(ctx, limits), false
			}
			return err.Error(), true
		}
		s.spendTokens(k, answer.Usage)
		s.addUsage(id, index, answer.Usage)
		st.tokens += answer.Usage.Input + answer.Usage.Output
		if limits.MaxTokens > 0 && st.tokens > limits.MaxTokens {
			return fmt.Sprintf("stopped: the token budget (%d) is spent", limits.MaxTokens), false
		}
		st.reply, st.replyText = answer, answer.Content
		var text string
		if p.native && len(answer.Calls) > 0 {
			st.actions, text = fromCalls(answer.Calls), answer.Content
		} else {
			st.actions, text = fromText(answer.Content)
		}
		if text = strings.TrimSpace(text); text != "" {
			st.parts = append(st.parts, text)
		}
		if len(st.actions) == 0 {
			return "", false
		}
	}
}

// screenMessage is what the kitty is told after actions that can have changed its display: the
// screenshot, which is also kept for the chat's step, or why there is none.
func (s *Service) screenMessage(id string, index int, png []byte, err error) provider.Message {
	return s.screenMessageWith(id, index, png, err, "")
}

// screenMessageWith is screenMessage with something said before it.
func (s *Service) screenMessageWith(id string, index int, png []byte, err error, before string) provider.Message {
	m := provider.Message{Role: "user", Content: "Here is the screenshot of your display now. Continue with your next actions, or call done when the task is finished."}
	if err != nil {
		m.Content = "The screenshot failed: " + err.Error() + ". Continue with your next actions, or call done when the task is finished."
	} else if name, err := s.saveShot(id, index, png); err == nil {
		s.markShot(id, index, name)
		m.Images = []provider.Image{{MIME: "image/png", Data: png}}
	}
	if before != "" {
		m.Content = before + "\n" + m.Content
	}
	return m
}

// endsTask reports whether a batch calls done: that batch runs even past the round limit.
func endsTask(actions []action) bool {
	for _, a := range actions {
		if a.kind == "tool" {
			if _, ok := (desktop.Action{Name: a.name, Args: a.args, Raw: a.raw}).Done(); ok {
				return true
			}
		}
	}
	return false
}

// stopReason says why a context ended a task.
func stopReason(ctx context.Context, limits kitty.Limits) string {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fmt.Sprintf("stopped: the time budget (%ds) is spent", limits.MaxSeconds)
	}
	return "the task was cancelled"
}

// edit changes one turn of a session under the lock and saves it.
func (s *Service) edit(id string, index int, fn func(*Turn)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[id]
	if !ok || index >= len(sess.Turns) {
		return
	}
	fn(&sess.Turns[index])
	sess.UpdatedAt = s.now()
	_ = s.save(sess)
	kind := "update"
	if !sess.Turns[index].Working {
		kind = "done"
	}
	s.emitLocked(Event{Type: kind, Session: id, Index: index, Turn: &sess.Turns[index]})
}

func (s *Service) appendStep(id string, index int, step Step) {
	s.edit(id, index, func(t *Turn) { t.Steps = append(t.Steps, step) })
}

func (s *Service) markShot(id string, index int, name string) {
	s.edit(id, index, func(t *Turn) {
		if len(t.Steps) > 0 {
			// A copy: whoever holds the turn's steps (a reader of the session, a subscriber)
			// never sees an element change under it.
			steps := append([]Step(nil), t.Steps...)
			steps[len(steps)-1].Shot = name
			t.Steps = steps
		} else {
			t.Steps = append(t.Steps, Step{At: s.now(), Action: "screenshot", Shot: name})
		}
	})
}

func (s *Service) addUsage(id string, index int, u provider.Usage) {
	s.edit(id, index, func(t *Turn) {
		t.Usage.Input += u.Input
		t.Usage.Output += u.Output
	})
}

// closeTask ends a turn's background work: the text, whether the person is needed, and the
// goal's result when the thread works a goal.
func (s *Service) closeTask(id string, index int, k *kitty.Kitty, text string, needsHelp bool, result string) {
	s.edit(id, index, func(t *Turn) {
		t.Working = false
		t.NeedsHelp = needsHelp
		if text != "" {
			if t.Text != "" {
				t.Text += "\n\n"
			}
			t.Text += text
		}
		if t.Text == "" {
			t.Text = "(" + t.From + " finished without a word)"
		}
	})
	if needsHelp {
		s.tell(notify.Help, k, "needs your help", summaryLine(text), id)
	}
	if goal := s.goalOf(id); goal != "" {
		s.reportGoal(k, goal, id, result, text)
	}
}

// saveShot writes a screenshot under the session's folder and returns its name.
func (s *Service) saveShot(id string, index int, png []byte) (string, error) {
	dir := filepath.Join(s.dir, id)
	if err := statefs.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	n := 0
	s.mu.RLock()
	if sess, ok := s.sessions[id]; ok && index < len(sess.Turns) {
		n = len(sess.Turns[index].Steps)
	}
	s.mu.RUnlock()
	name := fmt.Sprintf("%d-%d.png", index, n)
	return name, statefs.WriteFile(filepath.Join(dir, name), png, 0o600)
}

func workspaceOf(k *kitty.Kitty) string {
	if k.Desktop {
		return "/home/kitty/work"
	}
	return ""
}

// transcript renders the thread as the kitty sees it: its own turns as the assistant, everyone
// else's as the user, labelled by name in a group.
func (s *Service) transcript(system string, turns []Turn, k *kitty.Kitty) []provider.Message {
	if len(turns) > s.MaxTurns {
		turns = turns[len(turns)-s.MaxTurns:]
	}
	messages := []provider.Message{{Role: "system", Content: system}}
	var pending []string
	flush := func() {
		if len(pending) > 0 {
			messages = append(messages, provider.Message{Role: "user", Content: strings.Join(pending, "\n\n")})
			pending = nil
		}
	}
	for _, t := range turns {
		if t.Kitty == k.ID {
			flush()
			content := t.Text
			if t.Resumable {
				content += "\n\n" + recap(t)
			}
			messages = append(messages, provider.Message{Role: "assistant", Content: content})
			continue
		}
		label := t.From
		if t.From == "user" {
			label = s.user
			if label == "" {
				label = "User"
			}
		}
		pending = append(pending, "["+label+"]: "+t.Text)
	}
	flush()
	if last := messages[len(messages)-1]; last.Role != "user" {
		messages = append(messages, provider.Message{Role: "user", Content: "(continue)"})
	}
	return messages
}
