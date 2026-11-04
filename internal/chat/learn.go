package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/madkoding/kitties/internal/agenda"
	"github.com/madkoding/kitties/internal/approvals"
	"github.com/madkoding/kitties/internal/kitty"
	"github.com/madkoding/kitties/internal/maintenance"
	"github.com/madkoding/kitties/internal/memory"
	"github.com/madkoding/kitties/internal/provider"
)

// LEARNING THE PERSON.
//
// A kitty keeps notes about the person and the work (memory). They come from the person's
// feedback on what the kitty said (a thumbs up or down, with a word), from the yes or no to the
// actions it asked about, and from what the kitty notes itself. The feedback also moves how
// demanding the person looks to the kitty, which shapes how careful it is and how soon it is
// trusted with actions alone. Every few verdicts the notes are distilled by the kitty's own
// brain into a short list, and the list goes into its prompt. A long thread is kept in view by
// summarising its early part instead of dropping it.

// distillEvery is how many verdicts make the kitty consolidate what it learned.
const distillEvery = 3

// ErrNoMemory is returned when the kitties keep no memory in this deployment.
var ErrNoMemory = errors.New("this gateway keeps no memory of the person")

// SetMemory gives the kitties a memory. The level of demand it tracks decides how soon an
// action is trusted, and every yes or no to an action is learned from.
func (s *Service) SetMemory(m *memory.Store) {
	s.memory = m
	if m == nil {
		s.demand, s.learnFromApproval = nil, nil
		return
	}
	s.demand = m.Demand
	s.learnFromApproval = s.learnApproval
}

// memoryPrompt is what the kitty knows, for its system prompt, with the instructions to keep notes.
func (s *Service) memoryPrompt(k *kitty.Kitty, sess *Session) string {
	if s.memory == nil {
		return ""
	}
	project := ""
	if sess != nil {
		project = memory.Slug(sess.Title)
	}
	return "\n" + s.memory.Prompt(k.ID, s.userName(), project) +
		"When you notice something lasting about how this person likes things done, or learn a lesson about the work, keep it with " +
		"@memory remember {\"text\": \"...\", \"scope\": \"user\"} (user, work or project): short, one thing each, never secrets. " +
		"Drop a note that turned out wrong with @memory forget {\"id\": \"...\"}.\n"
}

func (s *Service) userName() string {
	if s.user == "" {
		return "the person"
	}
	return s.user
}

// runMemory runs a memory action: remember, forget or list.
func (s *Service) runMemory(id string, a action, k *kitty.Kitty) outcome {
	if s.memory == nil {
		return outcome{action: a, err: "there is no memory here"}
	}
	switch a.name {
	case "remember", "save", "note":
		text := argText(a.args, "text", "note", "name")
		scope := strings.ToLower(argText(a.args, "scope"))
		switch scope {
		case "", "person", "preference":
			scope = memory.ScopeUser
		case "project":
			title := ""
			if sess, err := s.Get(id); err == nil {
				title = sess.Title
			}
			slug := memory.Slug(title)
			if slug == "" {
				return outcome{action: a, err: "this thread has no project to keep it under; use user or work"}
			}
			scope = "project:" + slug
		}
		n, err := s.memory.Remember(k.ID, scope, text, "kitty", false)
		if err != nil {
			return outcome{action: a, err: err.Error()}
		}
		s.note(k, agenda.KindLearned, s.goalOf(id), id, "noted ("+n.Scope+"): "+n.Text)
		return outcome{action: a, text: fmt.Sprintf("noted (%s, id %s)", n.Scope, n.ID)}
	case "forget", "drop":
		nid := argText(a.args, "id", "name")
		if err := s.memory.Forget(k.ID, nid); err != nil {
			return outcome{action: a, err: err.Error()}
		}
		return outcome{action: a, text: "forgotten"}
	case "list", "ls":
		notes := s.memory.Notes(k.ID, "")
		if len(notes) == 0 {
			return outcome{action: a, text: "(no notes yet)"}
		}
		var b strings.Builder
		for _, n := range notes {
			fmt.Fprintf(&b, "- [%s] %s (id %s)\n", n.Scope, n.Text, n.ID)
		}
		return outcome{action: a, text: strings.TrimSpace(b.String())}
	}
	return outcome{action: a, err: "unknown memory verb " + a.name + " (remember, forget or list)"}
}

// MemoryView is what the page shows of a kitty's memory.
type MemoryView struct {
	Notes   []memory.Note    `json:"notes"`
	Profile memory.Profile   `json:"profile"`
	Level   string           `json:"level"`
	Trust   map[string]Trust `json:"trust,omitempty"`
	// Spent is today's tokens and actions against the kitty's daily limits.
	Spent Spent `json:"spent"`
}

// Trust is how far a kind of action of the kitty is on the way to being done unasked.
type Trust struct {
	Streak int `json:"streak"`
	// Needs is how many yeses in a row earn it for this person; 0 means never.
	Needs int `json:"needs"`
}

// MemoryOf returns a kitty's memory.
func (s *Service) MemoryOf(ref string) (*MemoryView, error) {
	if s.memory == nil {
		return nil, ErrNoMemory
	}
	k, err := s.fleet.Get(ref)
	if err != nil {
		return nil, err
	}
	p := s.memory.Profile(k.ID)
	view := &MemoryView{Notes: s.memory.Notes(k.ID, ""), Profile: p, Level: memory.LevelText(p.Demand), Spent: s.SpentBy(k)}
	if view.Notes == nil {
		view.Notes = []memory.Note{}
	}
	if s.approvals != nil {
		view.Trust = map[string]Trust{}
		for name, st := range s.approvals.Stats(k.ID) {
			view.Trust[name] = Trust{Streak: st.Streak, Needs: approvals.Threshold(p.Demand)}
		}
	}
	return view, nil
}

// Remember keeps a note the person wrote: it is pinned, so a distillation never drops it.
func (s *Service) Remember(ref, scope, text string) (*memory.Note, error) {
	if s.memory == nil {
		return nil, ErrNoMemory
	}
	k, err := s.fleet.Get(ref)
	if err != nil {
		return nil, err
	}
	n, err := s.memory.Remember(k.ID, scope, text, "person", true)
	if err == nil {
		s.note(k, agenda.KindLearned, "", "", "told ("+n.Scope+"): "+n.Text)
	}
	return n, err
}

// ForgetNote removes a note.
func (s *Service) ForgetNote(ref, id string) error {
	if s.memory == nil {
		return ErrNoMemory
	}
	k, err := s.fleet.Get(ref)
	if err != nil {
		return err
	}
	return s.memory.Forget(k.ID, id)
}

// SetProfile sets how demanding the person is, and whether the level keeps following the feedback.
func (s *Service) SetProfile(ref string, demand int, auto bool) (memory.Profile, error) {
	if s.memory == nil {
		return memory.Profile{}, ErrNoMemory
	}
	k, err := s.fleet.Get(ref)
	if err != nil {
		return memory.Profile{}, err
	}
	p, err := s.memory.SetProfile(k.ID, demand, auto)
	if err == nil {
		s.note(k, agenda.KindLearned, "", "", fmt.Sprintf("level of demand set to %d of 5", p.Demand))
	}
	return p, err
}

// ForgetKitty drops what is kept about a removed kitty.
func (s *Service) ForgetKitty(id string) error {
	if s.memory == nil {
		return nil
	}
	return s.memory.ForgetKitty(id)
}

// Feedback records what the person thinks of a turn: "up" or "down", with a word. It shapes the
// kitty's memory and its sense of how demanding the person is.
func (s *Service) Feedback(chatID string, index int, rating, note string) error {
	if s.memory == nil {
		return ErrNoMemory
	}
	if rating != "up" && rating != "down" && rating != "" {
		return errors.New("rating is up or down")
	}
	s.mu.Lock()
	sess, ok := s.sessions[chatID]
	if !ok {
		s.mu.Unlock()
		return fmt.Errorf("no such chat %q", chatID)
	}
	if index < 0 || index >= len(sess.Turns) {
		s.mu.Unlock()
		return fmt.Errorf("no such turn %d in the chat", index)
	}
	turn := &sess.Turns[index]
	if turn.Kitty == "" {
		s.mu.Unlock()
		return errors.New("feedback is for what a kitty said")
	}
	kittyID, text := turn.Kitty, turn.Text
	request := ""
	for i := index - 1; i >= 0; i-- {
		if sess.Turns[i].Kitty != kittyID {
			request = sess.Turns[i].Text
			break
		}
	}
	previous := turn.Feedback
	turn.Feedback = rating
	sess.UpdatedAt = s.now()
	_ = s.save(sess)
	s.emitLocked(Event{Type: "update", Session: chatID, Index: index, Turn: turn})
	s.mu.Unlock()
	if rating == "" || rating == previous && strings.TrimSpace(note) == "" {
		return nil
	}
	s.learn(kittyID, memory.Feedback{Rating: rating, Note: note, Excerpt: text, Request: request, Source: "turn"}, chatID)
	return nil
}

// learn turns a verdict into memory: the verdict itself, a note when the person said why, a move
// of the level, and a distillation when enough of them piled up.
func (s *Service) learn(kittyID string, fb memory.Feedback, chatID string) {
	k, err := s.fleet.Get(kittyID)
	if err != nil {
		return
	}
	profile, changed := s.memory.Record(kittyID, fb)
	if note := strings.TrimSpace(fb.Note); note != "" {
		prefix := "Liked: "
		if fb.Rating == "down" {
			prefix = "Correction: "
		}
		_, _ = s.memory.Remember(kittyID, memory.ScopeUser, prefix+note, "feedback", false)
	}
	if changed {
		s.note(k, agenda.KindLearned, "", chatID, fmt.Sprintf("the person looks more %s: level of demand now %d of 5", map[bool]string{true: "demanding", false: "relaxed"}[fb.Rating == "down"], profile.Demand))
	}
	if profile.Pending >= distillEvery {
		s.distillLater(k)
	}
}

// learnApproval learns from the person's yes or no to an action.
func (s *Service) learnApproval(ap approvals.Approval) {
	fb := memory.Feedback{Rating: "up", Excerpt: ap.Summary, Source: "approval"}
	if ap.Status == approvals.Rejected {
		fb.Rating, fb.Note = "down", ap.Reason
	}
	s.learn(ap.Kitty, fb, ap.Chat)
}

// distillLater consolidates a kitty's memory in the background, once at a time.
func (s *Service) distillLater(k *kitty.Kitty) {
	ctx := s.shutdownCtx
	release := func() {}
	if fleet, ok := s.fleet.(interface{ Admission() *maintenance.Gate }); ok {
		var err error
		ctx, release, err = fleet.Admission().Enter(ctx)
		if err != nil {
			return
		}
	}
	s.mu.Lock()
	if s.stopping || s.distilling[k.ID] {
		s.mu.Unlock()
		release()
		return
	}
	s.distilling[k.ID] = true
	s.wg.Add(1)
	s.mu.Unlock()
	go func() {
		defer s.wg.Done()
		defer release()
		_, _ = s.distill(ctx, k)
		s.mu.Lock()
		delete(s.distilling, k.ID)
		s.mu.Unlock()
	}()
}

// Distill consolidates a kitty's memory now: its own brain turns the notes and the latest
// verdicts into a short list.
func (s *Service) Distill(ctx context.Context, ref string) ([]memory.Note, error) {
	if s.memory == nil {
		return nil, ErrNoMemory
	}
	k, err := s.fleet.Get(ref)
	if err != nil {
		return nil, err
	}
	return s.distill(ctx, k)
}

func (s *Service) distill(ctx context.Context, k *kitty.Kitty) ([]memory.Note, error) {
	brain, err := s.fleet.Brain(k)
	if err != nil {
		return nil, err
	}
	var b strings.Builder
	b.WriteString("Current notes:\n")
	notes := s.memory.Notes(k.ID, "")
	for _, n := range notes {
		fmt.Fprintf(&b, "[%s] %s\n", n.Scope, n.Text)
	}
	if len(notes) == 0 {
		b.WriteString("(none)\n")
	}
	b.WriteString("\nThe person's latest feedback, oldest first:\n")
	recent := s.memory.Recent(k.ID, 25)
	for _, fb := range recent {
		fmt.Fprintf(&b, "- %s", fb.Rating)
		if fb.Request != "" {
			fmt.Fprintf(&b, " | asked: %s", fb.Request)
		}
		if fb.Excerpt != "" {
			fmt.Fprintf(&b, " | the kitty did: %s", fb.Excerpt)
		}
		if fb.Note != "" {
			fmt.Fprintf(&b, " | the person said: %s", fb.Note)
		}
		b.WriteString("\n")
	}
	reply, err := brain.Complete(ctx, []provider.Message{
		{Role: "system", Content: "You keep the memory of a kitty, an AI assistant, about the person it works for and about the work. " +
			"From its current notes and the person's latest feedback, write the consolidated list of notes. Rules: durable preferences " +
			"and lessons only; short imperative sentences (160 characters at most); merge duplicates; drop what the latest feedback " +
			"contradicts; keep corrections; never invent; at most 15 notes; a scope is user (how the person likes things done), " +
			"work (a lesson about the work) or project:<name>. Answer with ONLY a JSON array like [{\"scope\":\"user\",\"text\":\"Answer in Spanish\"}]."},
		{Role: "user", Content: b.String()},
	})
	if err != nil {
		return nil, err
	}
	list, err := parseNotes(reply.Content)
	if err != nil {
		return nil, err
	}
	s.memory.Distilled(k.ID, list)
	s.note(k, agenda.KindLearned, "", "", fmt.Sprintf("distilled %d notes from %d verdicts", len(list), len(recent)))
	return s.memory.Notes(k.ID, ""), nil
}

// parseNotes reads the JSON array a distillation answers with, wherever in the reply it sits.
func parseNotes(text string) ([]memory.Note, error) {
	i, j := strings.Index(text, "["), strings.LastIndex(text, "]")
	if i < 0 || j < i {
		return nil, errors.New("the brain did not answer with a list of notes")
	}
	var raw []struct {
		Scope string `json:"scope"`
		Text  string `json:"text"`
	}
	if err := json.Unmarshal([]byte(text[i:j+1]), &raw); err != nil {
		return nil, fmt.Errorf("the brain's list of notes is not valid: %v", err)
	}
	var out []memory.Note
	for _, r := range raw {
		scope := strings.ToLower(strings.TrimSpace(r.Scope))
		if scope == "" {
			scope = memory.ScopeUser
		}
		out = append(out, memory.Note{Scope: scope, Text: r.Text, Strength: 1})
		if len(out) == 20 {
			break
		}
	}
	return out, nil
}

// compact summarises the early part of a long thread, so a project keeps its context instead of
// losing it past what the kitties are shown. The summary stands for everything before the last
// CompactKeep turns; what the brain cannot summarise is simply dropped as before.
func (s *Service) compact(ctx context.Context, id string, brain provider.Client) {
	sess, err := s.Get(id)
	if err != nil || s.CompactAfter <= 0 || len(sess.Turns)-sess.SummaryUpTo <= s.CompactAfter {
		return
	}
	cut := len(sess.Turns) - s.CompactKeep
	if cut <= sess.SummaryUpTo {
		return
	}
	var b strings.Builder
	if sess.Summary != "" {
		b.WriteString("Summary so far:\n" + sess.Summary + "\n\n")
	}
	b.WriteString("New messages to fold in:\n")
	for _, t := range sess.Turns[sess.SummaryUpTo:cut] {
		label := t.From
		if label == "user" {
			label = s.userName()
		}
		fmt.Fprintf(&b, "[%s]: %s\n", label, clip(t.Text, 700))
	}
	reply, err := brain.Complete(ctx, []provider.Message{
		{Role: "system", Content: "You keep the running summary of a long conversation between a person and AI assistants (kitties), so that it can go on " +
			"without the early messages. Merge the summary so far and the new messages into one summary of at most 350 words: what was asked and " +
			"decided, what is done and what is pending, names, numbers, dates and the person's preferences. Plain text, no preamble."},
		{Role: "user", Content: b.String()},
	})
	text := strings.TrimSpace(reply.Content)
	if err != nil || text == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if cur, ok := s.sessions[id]; ok && cut <= len(cur.Turns) {
		cur.Summary, cur.SummaryUpTo = clip(text, 4000), cut
		_ = s.save(cur)
	}
}
