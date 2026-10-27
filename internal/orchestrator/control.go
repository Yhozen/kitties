package orchestrator

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/madkoding/kitties/internal/desktop"
	"github.com/madkoding/kitties/internal/kitty"
)

// TAKING THE DESKTOP OVER.
//
// The person can take a kitty's display over: they watch it live and click and type in it, for
// what the kitty cannot do alone (a password, a captcha, a code sent to them). Meanwhile the
// kitty's own actions on the display wait, so the two never fight over the mouse. A hold left
// alone ends by itself, so a closed window never keeps the kitty waiting for good.

// holdIdle is how long a hold lasts without the person doing anything.
const holdIdle = 5 * time.Minute

// Hold gives the person the kitty's display (on) or gives it back to the kitty.
func (m *Manager) Hold(ref string, on bool) (bool, error) {
	k, err := m.Get(ref)
	if err != nil {
		return false, err
	}
	if on && !k.Desktop {
		return false, fmt.Errorf("%s has no desktop", k.Name)
	}
	m.holdMu.Lock()
	defer m.holdMu.Unlock()
	if m.holds == nil {
		m.holds, m.holdStarted = map[string]time.Time{}, map[string]time.Time{}
	}
	if on {
		if _, held := m.holds[k.ID]; !held {
			m.holdStarted[k.ID] = m.now()
		}
		m.holds[k.ID] = m.now()
	} else {
		delete(m.holds, k.ID)
	}
	return on, nil
}

// Held reports whether the person has the kitty's display, by id.
func (m *Manager) Held(id string) bool {
	m.holdMu.Lock()
	defer m.holdMu.Unlock()
	at, ok := m.holds[id]
	if ok && m.now().Sub(at) > holdIdle {
		delete(m.holds, id)
		return false
	}
	return ok
}

// AnyHeld reports whether the person holds the desktop of any kitty.
func (m *Manager) AnyHeld() bool {
	m.holdMu.Lock()
	ids := make([]string, 0, len(m.holds))
	for id := range m.holds {
		ids = append(ids, id)
	}
	m.holdMu.Unlock()
	for _, id := range ids {
		if m.Held(id) {
			return true
		}
	}
	return false
}

// HoldStarted is when the person last took the kitty's display (zero when never): a kitty that
// asked for help knows they came even when they gave it back between two of its looks.
func (m *Manager) HoldStarted(id string) time.Time {
	m.holdMu.Lock()
	defer m.holdMu.Unlock()
	return m.holdStarted[id]
}

// Input is what the person does on the display: a click, keys, text, the wheel or a drag. It
// takes the display over, or keeps it taken.
func (m *Manager) Input(ctx context.Context, ref string, a desktop.Action) error {
	argv, err := desktop.Person(a)
	if err != nil {
		return err
	}
	k, err := m.Get(ref)
	if err != nil {
		return err
	}
	if _, err := m.Hold(k.ID, true); err != nil {
		return err
	}
	// What the person types may be a password: it goes in on the input, not in the arguments.
	if a.Name == "type" {
		_, err = m.ExecInput(ctx, k.ID, fmt.Sprint(a.Args["text"]), desktop.TypeFromInput...)
		return err
	}
	_, err = m.Exec(ctx, k.ID, argv...)
	return err
}

// Stream follows the kitty's display live: pictures to read with container.ReadFrame, at most
// fps a second, until the stream is closed.
func (m *Manager) Stream(ctx context.Context, ref string, fps, quality int) (io.ReadCloser, error) {
	k, err := m.Get(ref)
	if err != nil {
		return nil, err
	}
	if !k.Desktop {
		return nil, fmt.Errorf("%s has no desktop", k.Name)
	}
	return m.ctr().Stream(ctx, computerID(k), fps, quality)
}

// MaxClipboard is the most text the clipboard of a display takes from the person at once.
const MaxClipboard = 100 << 10

// Clipboard is the text on the kitty's clipboard, for the person to take.
func (m *Manager) Clipboard(ctx context.Context, ref string) (string, error) {
	return m.Exec(ctx, ref, "kitty-clip", "get")
}

// SetClipboard puts the person's text on the kitty's clipboard.
func (m *Manager) SetClipboard(ctx context.Context, ref, text string) error {
	if len(text) > MaxClipboard {
		return fmt.Errorf("the text is too long for the clipboard (at most %d KB)", MaxClipboard>>10)
	}
	_, err := m.Exec(ctx, ref, "kitty-clip", "set", text)
	return err
}

// DefaultTheme is the image's own theme, which an empty kitty.Theme stands for: Numix, the
// dark one.
const DefaultTheme = "Numix"

// applyTheme dresses a running desktop in the kitty's theme; reset puts the image's own back
// when the kitty has none. An image without kitty-theme (an older one) keeps its look, and the
// next start tries again.
func (m *Manager) applyTheme(ctx context.Context, k *kitty.Kitty, reset bool) {
	name := k.Theme
	if name == "" && reset {
		name = DefaultTheme
	}
	if !k.Desktop || name == "" || m.ctr() == nil {
		return
	}
	_, _ = m.ctr().Exec(ctx, computerID(k), "kitty-theme", name)
}
