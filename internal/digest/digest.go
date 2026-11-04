// Package digest writes the person a daily summary of what their kitties did: one short
// message at the hour they chose, through the channel they chose for notifications. A person
// who has kitties working all day should not have to open the interface to know it went well.
package digest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/madkoding/kitties/internal/maintenance"

	"github.com/madkoding/kitties/internal/agenda"
	"github.com/madkoding/kitties/internal/budget"
	"github.com/madkoding/kitties/internal/notify"
	"github.com/madkoding/kitties/internal/statefs"
)

// Window is how long after the chosen time a summary is still sent, so a gateway that was down
// at nine and back at half past still says it, but turning the digest on at night does not
// send yesterday's.
const Window = 90 * time.Minute

// Kitty is who a summary speaks of.
type Kitty struct{ ID, Name string }

// Source is what a summary is made from; each part is a function so the package knows no store.
type Source struct {
	Kitties func() []Kitty
	// Journal returns a kitty's entries, newest first.
	Journal func(kittyID string, n int) []agenda.Entry
	// Waiting is how many actions wait for a yes, and the line of each.
	Waiting func() []string
	// Today is what a kitty spent today.
	Today func(kittyID string) budget.Day
	// Config is the notification settings, read each time so the page's change applies.
	Config func() notify.Config
	// Deliver sends the summary.
	Deliver func(ctx context.Context, n notify.Notification) error
	// Day is the person's day (calendar, reminders, weather), when Config.Day asks for it;
	// empty when there is nothing to say.
	Day func(ctx context.Context) string
}

// Reporter builds and sends the summaries.
type Reporter struct {
	admission *maintenance.Gate
	src       Source
	path      string // remembers the day it last sent, so a restart does not repeat it
	now       func() time.Time

	mu      sync.Mutex
	last    string
	pending string
}

// New creates a reporter that keeps its memory of the last send at path.
func New(src Source, path string) *Reporter {
	r := &Reporter{src: src, path: path, now: time.Now}
	if raw, err := os.ReadFile(path); err == nil {
		var s struct {
			Last    string `json:"last"`
			Pending string `json:"pending"`
		}
		if json.Unmarshal(raw, &s) == nil {
			r.last, r.pending = s.Last, s.Pending
		}
	}
	return r
}

// counted are the journal kinds a summary counts, in the order it says them.
var counted = []struct{ kind, word string }{
	{agenda.KindDone, "done"},
	{agenda.KindBlocked, "blocked"},
	{agenda.KindEscalated, "asked for help"},
	{agenda.KindDelegated, "handed over"},
	{agenda.KindRetry, "retried"},
	{agenda.KindEvent, "events"},
	{agenda.KindLearned, "things learned"},
}

// Build writes the summary of the day before now.
// SetAdmission configures the backup barrier before background workers start.
func (r *Reporter) SetAdmission(g *maintenance.Gate) { r.admission = g }

func (r *Reporter) Build(now time.Time) notify.Notification {
	since := now.Add(-24 * time.Hour)
	kitties := r.src.Kitties()
	sort.Slice(kitties, func(i, j int) bool { return kitties[i].Name < kitties[j].Name })
	var lines []string
	for _, k := range kitties {
		counts := map[string]int{}
		approved := 0
		for _, e := range r.src.Journal(k.ID, 500) {
			if e.At.Before(since) {
				break
			}
			counts[e.Kind]++
			if e.Kind == agenda.KindApproval && (strings.HasPrefix(e.Text, "approved:") || strings.HasPrefix(e.Text, "went ahead")) {
				approved++
			}
		}
		var parts []string
		for _, c := range counted {
			if n := counts[c.kind]; n > 0 {
				parts = append(parts, fmt.Sprintf("%d %s", n, c.word))
			}
		}
		if approved > 0 {
			parts = append(parts, fmt.Sprintf("%d actions out", approved))
		}
		line := k.Name + ": "
		if len(parts) == 0 {
			line += "quiet"
		} else {
			line += strings.Join(parts, ", ")
		}
		if d := r.src.Today(k.ID); d.Tokens > 0 || d.Actions > 0 {
			line += fmt.Sprintf(" (%s tokens, %d actions today)", short(d.Tokens), d.Actions)
		}
		lines = append(lines, line)
	}
	if len(lines) == 0 {
		lines = append(lines, "No kitties yet.")
	}
	body := strings.Join(lines, "\n")
	if w := r.src.Waiting(); len(w) > 0 {
		body += fmt.Sprintf("\nWaiting for your yes (%d):", len(w))
		for i, l := range w {
			if i == 5 {
				body += fmt.Sprintf("\n- and %d more", len(w)-5)
				break
			}
			body += "\n- " + l
		}
	}
	return notify.Notification{Event: notify.Digest, Title: "Your kitties, last 24 hours", Body: body}
}

// compose is the summary to send: the kitties' last day, after the person's own day when the
// settings ask for it.
func (r *Reporter) compose(ctx context.Context, now time.Time) notify.Notification {
	n := r.Build(now)
	if !r.src.Config().Day || r.src.Day == nil {
		return n
	}
	if day := r.src.Day(ctx); day != "" {
		n.Title = "Your day, and your kitties"
		n.Body = day + "\n\nYour kitties, last 24 hours:\n" + n.Body
	}
	return n
}

// short writes a count as 1.2k or 3.4M.
func short(n int) string {
	switch {
	case n >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(n)/1e6)
	case n >= 1000:
		return fmt.Sprintf("%.1fk", float64(n)/1e3)
	}
	return fmt.Sprint(n)
}

// SendNow sends a summary at once, whatever the hour.
func (r *Reporter) SendNow(ctx context.Context) error {
	if r.admission != nil {
		admitted, release, err := r.admission.Enter(ctx)
		if err != nil {
			return err
		}
		defer release()
		ctx = admitted
	}
	if r.src.Config().Connector == "" {
		return errors.New("choose a notification channel first")
	}
	return r.src.Deliver(ctx, r.compose(ctx, r.now()))
}

// Tick sends today's summary when its time has come and it was not sent yet. It reports whether
// it sent one (a failed send is tried again on the next tick, within the window).
func (r *Reporter) Tick(ctx context.Context) (bool, error) {
	if r.admission != nil {
		admitted, release, err := r.admission.Enter(ctx)
		if err != nil {
			if errors.Is(err, maintenance.ErrBusy) {
				return false, nil
			}
			return false, err
		}
		defer release()
		ctx = admitted
	}
	cfg := r.src.Config()
	h, m, ok := cfg.DigestAt()
	if !ok || cfg.Connector == "" {
		return false, nil
	}
	now := r.now()
	due := time.Date(now.Year(), now.Month(), now.Day(), h, m, 0, 0, now.Location())
	day := now.Format("2006-01-02")
	r.mu.Lock()
	defer r.mu.Unlock()
	if now.Before(due) || now.Sub(due) > Window || r.last == day || r.pending == day {
		return false, nil
	}
	// A restart cannot know whether an interrupted delivery reached its recipient.
	if err := r.save(r.last, day); err != nil {
		return false, err
	}
	r.pending = day
	if err := r.src.Deliver(ctx, r.compose(ctx, now)); err != nil {
		clearErr := r.save(r.last, "")
		if clearErr == nil {
			r.pending = ""
		}
		return false, errors.Join(err, clearErr)
	}
	if err := r.save(day, ""); err != nil {
		return true, err
	}
	r.last, r.pending = day, ""
	return true, nil
}

func (r *Reporter) save(last, pending string) error {
	raw, err := json.Marshal(struct {
		Last    string `json:"last"`
		Pending string `json:"pending,omitempty"`
	}{Last: last, Pending: pending})
	if err != nil {
		return err
	}
	if err := statefs.MkdirAll(filepath.Dir(r.path), 0o755); err != nil {
		return err
	}
	if err := statefs.WriteFile(r.path+".tmp", raw, 0o600); err != nil {
		return err
	}
	return statefs.Rename(r.path+".tmp", r.path)
}

// Run ticks every half minute until ctx ends; a failure goes to logf.
func (r *Reporter) Run(ctx context.Context, logf func(string, ...any)) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		if _, err := r.Tick(ctx); err != nil && logf != nil {
			logf("digest: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
