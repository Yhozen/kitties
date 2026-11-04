// Package kitty is the model of one bot: its identity, its brain and its body.
package kitty

import (
	"errors"
	"time"

	"github.com/madkoding/kitties/internal/computer"
	"github.com/madkoding/kitties/internal/soul"
)

// The states a kitty goes through.
const (
	StatusCreated = "created" // known, container not started
	StatusRunning = "running"
	// StatusStarting is a desktop coming up: its image may be downloading for minutes.
	StatusStarting = "starting"
	StatusStopped  = "stopped"
	StatusStopping = "stopping"
	StatusSleeping = "sleeping"
	StatusError    = "error"
)

// Kitty is one bot.
type Kitty struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Provider is the profile the brain uses.
	Provider string    `json:"provider"`
	Soul     soul.Soul `json:"soul"`
	// Avatar is the pixel cat the interface draws for it.
	Avatar Avatar `json:"avatar"`
	// Connectors the kitty may use; empty means every configured one.
	Connectors []string `json:"connectors,omitempty"`
	// Desktop is true when the kitty has a container of its own.
	Desktop bool `json:"desktop"`
	// BodyLater is true when the kitty wanted a container but no engine answered when it was
	// made: it gets one as soon as Docker or Podman does.
	BodyLater bool `json:"body_later,omitempty"`
	// Theme is the look of its desktop, one of Themes; empty is the image's own (Numix, dark).
	Theme string `json:"theme,omitempty"`
	// Computer records the runtime identity independently of the AI provider.
	Computer     computer.Reference `json:"computer"`
	Availability string             `json:"availability,omitempty"`
	Operation    Operation          `json:"operation,omitempty"`
	// ResumeAfterBackup retains running intent across an interrupted maintenance capture.
	ResumeAfterBackup bool `json:"resume_after_backup,omitempty"`
	// Container is the stable logical name, retained for older API clients; empty without a desktop.
	Container string    `json:"container,omitempty"`
	Status    string    `json:"status"`
	Error     string    `json:"error,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	// Workspace is the host mount for containers, or the guest path for persistent computers.
	Workspace string `json:"workspace,omitempty"`
	// Limits bound what one task of this kitty may spend; a zero field takes the default.
	Limits Limits `json:"limits"`
	// Backup names the kitty a task is handed to when this one gives up; empty asks the person.
	Backup string `json:"backup,omitempty"`
	// Approvals is empty (or "auto"): the kitty acts as far as its accounts allow, held back
	// only by the limits the person set; "ask": an action that reaches other people waits for a
	// yes until the kitty has earned the right to do it alone.
	Approvals string `json:"approvals,omitempty"`
}

// Operation records lifecycle work before the runtime is changed.
type Operation struct {
	Attempts  int       `json:"attempts,omitempty"`
	RetryAt   time.Time `json:"retry_at,omitempty"`
	Kind      string    `json:"kind,omitempty"`
	StartedAt time.Time `json:"started_at,omitempty"`
}

// NoConnectors, as a kitty's only connection, means it may use none: an empty list means all
// of them (the configuration file's default), so "none" needs a name of its own.
const NoConnectors = "-"

// ValidApprovals reports whether s is a mode of approvals.
func ValidApprovals(s string) bool { return s == "" || s == "ask" || s == "auto" }

// Limits is what a kitty may spend on one task before it stops and says so.
type Limits struct {
	// MaxTokens is the input plus output tokens one task may use.
	MaxTokens int `json:"max_tokens,omitempty" yaml:"max_tokens"`
	// MaxSeconds is how long one task may run.
	MaxSeconds int `json:"max_seconds,omitempty" yaml:"max_seconds"`
	// MaxRounds is how many rounds of actions one task may take.
	MaxRounds int `json:"max_rounds,omitempty" yaml:"max_rounds"`
	// Retries is how many times a failed task is tried another way before giving up.
	Retries int `json:"retries,omitempty" yaml:"retries"`
	// DayTokens is the input plus output tokens the kitty may use in a day, over all its work;
	// when they are spent it stops until tomorrow. Zero means no daily limit.
	DayTokens int `json:"day_tokens,omitempty" yaml:"day_tokens"`
	// DayActions is how many actions that reach other people (posts, replies, mail, refunds) it
	// may take in a day; past it each one waits for the person even when the kitty acts alone.
	DayActions int `json:"day_actions,omitempty" yaml:"day_actions"`
}

// Validate refuses a negative limit.
func (l Limits) Validate() error {
	if l.MaxTokens < 0 || l.MaxSeconds < 0 || l.MaxRounds < 0 || l.Retries < 0 || l.DayTokens < 0 || l.DayActions < 0 {
		return errors.New("limits cannot be negative")
	}
	if l.Retries > 10 {
		return errors.New("limits.retries: at most 10")
	}
	return nil
}

// Or fills the zero fields of l from d.
func (l Limits) Or(d Limits) Limits {
	if l.MaxTokens == 0 {
		l.MaxTokens = d.MaxTokens
	}
	if l.MaxSeconds == 0 {
		l.MaxSeconds = d.MaxSeconds
	}
	if l.MaxRounds == 0 {
		l.MaxRounds = d.MaxRounds
	}
	if l.Retries == 0 {
		l.Retries = d.Retries
	}
	if l.DayTokens == 0 {
		l.DayTokens = d.DayTokens
	}
	if l.DayActions == 0 {
		l.DayActions = d.DayActions
	}
	return l
}

// ContainerName is the container a kitty called name runs in.
func ContainerName(name string) string { return "kitty-" + name }

// Themes are the looks a kitty's desktop can wear: Openbox-format themes the kitty-desktop image carries.
var Themes = []string{"Numix", "Greybird-dark"}

// ValidTheme reports whether a theme is one of Themes, or empty (the image's own).
func ValidTheme(name string) bool {
	if name == "" {
		return true
	}
	for _, t := range Themes {
		if t == name {
			return true
		}
	}
	return false
}
