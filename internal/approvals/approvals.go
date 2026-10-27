// Package approvals is how a kitty stays within what its person is comfortable with: an action
// that reaches other people or moves money is held until the person says yes, and a kitty that
// keeps getting yes for the same thing earns the right to do it on its own. The more demanding
// the person has shown to be, the more yeses it takes, and some actions are never done unasked.
package approvals

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

	"github.com/madkoding/kitties/internal/connector"
	"github.com/madkoding/kitties/internal/statefs"
)

// The states of a request.
const (
	Pending  = "pending"
	Approved = "approved"
	Rejected = "rejected"
)

// Approval is one action a kitty wants to take and is waiting to be allowed.
type Approval struct {
	ID        string `json:"id"`
	Kitty     string `json:"kitty"` // kitty id
	KittyName string `json:"kitty_name"`
	Connector string `json:"connector"`
	Kind      string `json:"kind"`
	Action    string `json:"action"`
	// Args are what the kitty asked the connector to do.
	Args map[string]any `json:"args"`
	// Summary says it in a line for the person.
	Summary string `json:"summary"`
	// Risk is "ask" (done on its own once trusted) or "always" (never done unasked).
	Risk string `json:"risk"`
	Chat string `json:"chat,omitempty"`
	Goal string `json:"goal,omitempty"`

	Status    string    `json:"status"`
	Reason    string    `json:"reason,omitempty"` // why the person said no
	Always    bool      `json:"always,omitempty"` // the yes came with "and from now on"
	At        time.Time `json:"at"`
	DecidedAt time.Time `json:"decided_at,omitempty"`
	// Result and Error are how the action went once approved.
	Result string `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

// Rule is how a kind of action of a kitty is limited: always allowed, asked about first, or never
// done. The person sets it, or the kitty when the person asks it to.
type Rule struct {
	ID        string    `json:"id"`
	Kitty     string    `json:"kitty"`
	KittyName string    `json:"kitty_name,omitempty"`
	Connector string    `json:"connector"`
	Action    string    `json:"action"`
	Mode      string    `json:"mode"` // auto | ask | never
	Created   time.Time `json:"created"`
}

// Stat is the history of one kind of action of a kitty: the yeses in a row, and the noes.
type Stat struct {
	Streak   int `json:"streak"`
	Approved int `json:"approved"`
	Rejected int `json:"rejected"`
}

// Verdict is what Check says about an action about to run.
type Verdict struct {
	// Run is true when the action may go ahead without asking; Blocked when it may not be done.
	Run     bool `json:"run"`
	Blocked bool `json:"blocked,omitempty"`
	// Why says so, for the journal.
	Why string `json:"why"`
}

// Threshold is how many yeses in a row earn a kitty the right to do a kind of action on its own,
// for a person this demanding (1 relaxed to 5 strict); 0 means never.
func Threshold(demand int) int {
	switch {
	case demand <= 1:
		return 2
	case demand == 2:
		return 4
	case demand == 3:
		return 6
	case demand == 4:
		return 12
	}
	return 0
}

// Store keeps the requests, the rules and the history in a JSON file.
type Store struct {
	path string
	mu   sync.Mutex
	d    data
	now  func() time.Time
	id   func() string
}

type data struct {
	Approvals []*Approval      `json:"approvals"`
	Rules     []*Rule          `json:"rules"`
	Stats     map[string]*Stat `json:"stats"`
}

// maxKept bounds how many decided requests are remembered.
var maxKept = 500

// Open reads the store at path (created on the first save).
func Open(path string) (*Store, error) {
	s := &Store{path: path, d: data{Stats: map[string]*Stat{}}, now: time.Now, id: randomID}
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
	if s.d.Stats == nil {
		s.d.Stats = map[string]*Stat{}
	}
	return s, nil
}

func randomID() string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func (s *Store) save() error {
	raw, err := json.MarshalIndent(s.d, "", "  ")
	if err != nil {
		return err
	}
	if err := statefs.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	return statefs.WriteFile(s.path, raw, 0o600)
}

func statKey(kitty, conn, action string) string { return kitty + "\x00" + conn + "\x00" + action }

// Check says whether an action may run. Nothing is limited unless someone set it, since what
// an account may do is the service's to limit: a rule for this action of the kitty (or for every
// action of the connector, "*") says auto, ask or never; without one, a kitty in "ask" mode holds
// what reaches other people until it earned trust with it, and any other kitty acts.
func (s *Store) Check(kitty, conn, action, risk, mode string, demand int) Verdict {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r := s.ruleLocked(kitty, conn, action); r != nil {
		switch r.Mode {
		case ModeAuto:
			return Verdict{Run: true, Why: "allowed for good by the person"}
		case ModeNever:
			return Verdict{Blocked: true, Why: "the person asked that this is never done"}
		}
		return Verdict{Why: "the person asked to be asked about this"}
	}
	if mode != ModeAsk || risk == "" {
		return Verdict{Run: true, Why: WhyFree}
	}
	if st := s.d.Stats[statKey(kitty, conn, action)]; st != nil {
		if need := Threshold(demand); need > 0 && st.Streak >= need {
			return Verdict{Run: true, Why: fmt.Sprintf("trusted: %d approvals in a row", st.Streak)}
		}
	}
	return Verdict{Why: "waiting for the person"}
}

// WhyFree is the verdict of an action nothing limits.
const WhyFree = "no limit set"

// The modes of a rule.
const (
	ModeAuto  = "auto"
	ModeAsk   = "ask"
	ModeNever = "never"
)

// AnyAction, as a rule's action, covers every action of the connector.
const AnyAction = "*"

// ruleLocked is the rule for an action: its own, or the connector's for any action.
func (s *Store) ruleLocked(kitty, conn, action string) *Rule {
	var any *Rule
	for _, r := range s.d.Rules {
		if r.Kitty != kitty || r.Connector != conn {
			continue
		}
		if r.Action == action {
			return r
		}
		if r.Action == AnyAction {
			any = r
		}
	}
	return any
}

// ModeOf is the mode of the rule for exactly this action of the kitty ("*" for the whole
// connection), empty when there is none.
func (s *Store) ModeOf(kitty, conn, action string) string {
	if action == "" {
		action = AnyAction
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.d.Rules {
		if r.Kitty == kitty && r.Connector == conn && r.Action == strings.ToLower(action) {
			return r.Mode
		}
	}
	return ""
}

// SetRule sets how an action of a kitty is limited (auto, ask or never), or takes the limit
// away with an empty mode. The action "*" covers every action of the connector.
func (s *Store) SetRule(r Rule) (*Rule, error) {
	r.Connector, r.Action = strings.TrimSpace(r.Connector), strings.ToLower(strings.TrimSpace(r.Action))
	if r.Kitty == "" || r.Connector == "" {
		return nil, errors.New("a limit needs a kitty and a connection")
	}
	if r.Action == "" {
		r.Action = AnyAction
	}
	switch r.Mode {
	case ModeAuto, ModeAsk, ModeNever, "":
	default:
		return nil, fmt.Errorf("a limit is ask, never or auto, not %q", r.Mode)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, old := range s.d.Rules {
		if old.Kitty == r.Kitty && old.Connector == r.Connector && old.Action == r.Action {
			if r.Mode == "" {
				s.d.Rules = append(s.d.Rules[:i], s.d.Rules[i+1:]...)
				return nil, s.save()
			}
			old.Mode = r.Mode
			c := *old
			return &c, s.save()
		}
	}
	if r.Mode == "" {
		return nil, nil
	}
	r.ID, r.Created = s.id(), s.now()
	s.d.Rules = append(s.d.Rules, &r)
	c := r
	return &c, s.save()
}

// Request keeps an action to be approved. The same action asked again while it waits is the
// same request, so a kitty that retries does not pile them up.
func (s *Store) Request(a Approval) (*Approval, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	args, _ := json.Marshal(a.Args)
	for _, p := range s.d.Approvals {
		if p.Status == Pending && p.Kitty == a.Kitty && p.Connector == a.Connector && p.Action == a.Action {
			if old, _ := json.Marshal(p.Args); string(old) == string(args) {
				c := *p
				return &c, nil
			}
		}
	}
	a.ID, a.Status, a.At = s.id(), Pending, s.now()
	s.d.Approvals = append(s.d.Approvals, &a)
	s.trim()
	if err := s.save(); err != nil {
		s.d.Approvals = s.d.Approvals[:len(s.d.Approvals)-1]
		return nil, err
	}
	c := a
	return &c, nil
}

// trim forgets the oldest decided requests beyond maxKept; callers hold the lock.
func (s *Store) trim() {
	if len(s.d.Approvals) <= maxKept {
		return
	}
	var kept []*Approval
	drop := len(s.d.Approvals) - maxKept
	for _, a := range s.d.Approvals {
		if drop > 0 && a.Status != Pending {
			drop--
			continue
		}
		kept = append(kept, a)
	}
	s.d.Approvals = kept
}

// Decide records the person's answer. A yes with always also allows the action for good; a no
// takes the reason along and starts the kitty's streak over.
func (s *Store) Decide(id string, approve bool, reason string, always bool) (*Approval, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a := s.find(id)
	if a == nil {
		return nil, fmt.Errorf("no such approval %q", id)
	}
	if a.Status != Pending {
		return nil, fmt.Errorf("approval %q is already %s", id, a.Status)
	}
	if always && !approve {
		return nil, errors.New("only a yes can be for good")
	}
	a.DecidedAt = s.now()
	key := statKey(a.Kitty, a.Connector, a.Action)
	st := s.d.Stats[key]
	if st == nil {
		st = &Stat{}
		s.d.Stats[key] = st
	}
	if approve {
		a.Status = Approved
		a.Always = always
		st.Approved++
		st.Streak++
		if always {
			s.setRule(a, "auto")
		}
	} else {
		a.Status = Rejected
		a.Reason = strings.TrimSpace(reason)
		st.Rejected++
		st.Streak = 0
	}
	if err := s.save(); err != nil {
		return nil, err
	}
	c := *a
	return &c, nil
}

// setRule makes the rule for the action's kind; callers hold the lock.
func (s *Store) setRule(a *Approval, mode string) {
	for _, r := range s.d.Rules {
		if r.Kitty == a.Kitty && r.Connector == a.Connector && r.Action == a.Action {
			r.Mode = mode
			return
		}
	}
	s.d.Rules = append(s.d.Rules, &Rule{ID: s.id(), Kitty: a.Kitty, KittyName: a.KittyName, Connector: a.Connector, Action: a.Action, Mode: mode, Created: s.now()})
}

func (s *Store) find(id string) *Approval {
	for _, a := range s.d.Approvals {
		if a.ID == id {
			return a
		}
	}
	return nil
}

// Done records how an approved action went.
func (s *Store) Done(id, result, errText string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if a := s.find(id); a != nil {
		a.Result, a.Error = result, errText
		_ = s.save()
	}
}

// Get returns one request.
func (s *Store) Get(id string) (*Approval, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a := s.find(id)
	if a == nil {
		return nil, fmt.Errorf("no such approval %q", id)
	}
	c := *a
	return &c, nil
}

// List returns requests, newest first: those in a status ("" for all), at most limit (0 for all).
func (s *Store) List(status string, limit int) []Approval {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Approval
	for i := len(s.d.Approvals) - 1; i >= 0; i-- {
		a := s.d.Approvals[i]
		if status == "" || a.Status == status {
			out = append(out, *a)
			if limit > 0 && len(out) == limit {
				break
			}
		}
	}
	return out
}

// Rules returns what the person decided for good, by kitty and action.
func (s *Store) Rules() []Rule {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Rule, 0, len(s.d.Rules))
	for _, r := range s.d.Rules {
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Kitty != out[j].Kitty {
			return out[i].Kitty < out[j].Kitty
		}
		return out[i].Connector+out[i].Action < out[j].Connector+out[j].Action
	})
	return out
}

// RemoveRule takes a decision back: the kitty is asked again, and its streak starts over.
func (s *Store) RemoveRule(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, r := range s.d.Rules {
		if r.ID == id {
			s.d.Rules = append(s.d.Rules[:i], s.d.Rules[i+1:]...)
			if st := s.d.Stats[statKey(r.Kitty, r.Connector, r.Action)]; st != nil {
				st.Streak = 0
			}
			return s.save()
		}
	}
	return fmt.Errorf("no such rule %q", id)
}

// Stats returns the history of a kitty's kinds of action, keyed "connector.action".
func (s *Store) Stats(kitty string) map[string]Stat {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]Stat{}
	prefix := kitty + "\x00"
	for k, st := range s.d.Stats {
		if strings.HasPrefix(k, prefix) {
			out[strings.ReplaceAll(strings.TrimPrefix(k, prefix), "\x00", ".")] = *st
		}
	}
	return out
}

// Forget drops everything about a kitty that was removed.
func (s *Store) Forget(kitty string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var kept []*Approval
	for _, a := range s.d.Approvals {
		if a.Kitty != kitty {
			kept = append(kept, a)
		}
	}
	var rules []*Rule
	for _, r := range s.d.Rules {
		if r.Kitty != kitty {
			rules = append(rules, r)
		}
	}
	for k := range s.d.Stats {
		if strings.HasPrefix(k, kitty+"\x00") {
			delete(s.d.Stats, k)
		}
	}
	s.d.Approvals, s.d.Rules = kept, rules
	return s.save()
}

// Summarise says an action in a line for the person: where, what, and the words it carries.
func Summarise(conn, action string, args map[string]any) string {
	var parts []string
	for _, k := range []string{"to", "channel", "uri", "id", "post", "title", "subject", "text", "message", "body", "status", "content", "amount", "payment", "method", "path"} {
		if v, ok := args[k]; ok && v != nil && fmt.Sprint(v) != "" {
			parts = append(parts, k+": "+clip(fmt.Sprint(v), 280))
		}
		if len(parts) == 4 {
			break
		}
	}
	line := conn + "." + action
	if len(parts) > 0 {
		line += " — " + strings.Join(parts, "; ")
	}
	return clip(line, 700)
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// RiskText names a connector.Risk as the store keeps it.
func RiskText(r connector.Risk) string { return r.String() }
