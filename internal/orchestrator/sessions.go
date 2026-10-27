package orchestrator

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/madkoding/kitties/internal/computer"
	"github.com/madkoding/kitties/internal/config"
	"github.com/madkoding/kitties/internal/keep"
	"github.com/madkoding/kitties/internal/kitty"
)

// WHAT A KITTY KEEPS WHEN ITS DESKTOP IS MADE ANEW.
//
// The browser's cookies, sessions and saved passwords, and the keys of its programs, are backed up
// away from the container (package keep, sealed). The backup is made when the desktop stops or
// is updated, after the browser is closed in an orderly way so it has written everything, and on
// request; it is given back to a container that is made anew, so an update of the desktop (or a
// lost workspace) does not log the kitty out of everything.

// Keeper keeps the backups of the kitties' sessions.
type Keeper interface {
	Save(kitty string, data []byte) error
	Load(kitty string) ([]byte, keep.Info, error)
	Info(kitty string) (keep.Info, bool)
	Forget(kitty string) error
}

// errBusy is what an automatic update says when the kitty is in use: it will be tried again.
var errBusy = errors.New("the kitty is in use")

// SetBusy tells the manager how to know that a kitty is in the middle of a task (the chats know),
// so an automatic update never interrupts one.
func (m *Manager) SetBusy(fn func(kittyID string) bool) { m.busyFn = fn }

func (m *Manager) busy(id string) bool { return m.busyFn != nil && m.busyFn(id) }

// staleForAutoUpdate tells whether a stopped container is of an older image than the newest one
// and the gateway keeps desktops up to date by itself.
func (m *Manager) staleForAutoUpdate(ctx context.Context, k *kitty.Kitty) bool {
	if !m.cfg.Containers.AutoUpdate || !m.capabilities().ImageUpdates {
		return false
	}
	stale, _ := m.ctr().ImageStale(ctx, computerID(k), m.cfg.Containers.Image)
	return stale
}

// WatchUpdates keeps the desktops on the newest image until ctx ends: shortly after the start and
// then every `every`, it looks for a newer image (a pull), and makes the desktop of each idle kitty
// anew. updated hears about each one; warn about each one that could not be updated.
func (m *Manager) WatchUpdates(ctx context.Context, first, every time.Duration, updated func(k *kitty.Kitty), warn func(format string, args ...any)) {
	wait := first
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		wait = every
		m.CheckUpdates(ctx, updated, warn)
	}
}

// CheckUpdates is one round of WatchUpdates. A kitty that is working, or whose desktop the person
// holds, is left for the next round; one whose desktop is stopped is made anew when it is started.
func (m *Manager) CheckUpdates(ctx context.Context, updated func(k *kitty.Kitty), warn func(format string, args ...any)) {
	c := m.ctr()
	if c == nil || !m.cfg.Containers.AutoUpdate || !m.capabilities().ImageUpdates {
		return
	}
	// A reference that is only built here has nothing to pull: what is on this machine is the news.
	_ = c.Pull(ctx, m.cfg.Containers.Image)
	// Outside the window the image is looked for, but no desktop is restarted.
	if w, err := config.ParseWindow(m.cfg.Updates.Window); err != nil || !w.Contains(m.now()) {
		return
	}
	for _, k := range m.List() {
		if !k.Desktop || k.Status != kitty.StatusRunning {
			continue
		}
		if stale, _ := c.ImageStale(ctx, computerID(k), m.cfg.Containers.Image); !stale {
			continue
		}
		switch err := m.renew(ctx, k, true); {
		case err == nil:
			updated(k)
		case errors.Is(err, errBusy):
		default:
			warn("update: %s: %v", k.Name, err)
		}
	}
}

// SetKeeper gives the manager the place the backups are kept.
func (m *Manager) SetKeeper(k Keeper) { m.keeper = k }

// sessionsTimeout bounds each step of a backup or a restore.
var sessionsTimeout = 60 * time.Second

// DesktopInfo is what is known about a kitty's desktop beyond its status.
type DesktopInfo struct {
	// Image is the image the desktop is made from, by its reference.
	Image        string                `json:"image"`
	Capabilities computer.Capabilities `json:"capabilities"`
	// UpdateAvailable is true when a newer image than the container's is on this machine.
	UpdateAvailable bool `json:"update_available"`
	// AutoUpdate is true when the gateway moves the desktop to a newer image by itself, when idle.
	AutoUpdate bool `json:"auto_update"`
	// Backup says when its sessions were last backed up, when they were.
	Backup *keep.Info `json:"backup,omitempty"`
}

func (m *Manager) desktopKitty(ref string) (*kitty.Kitty, error) {
	k, err := m.Get(ref)
	if err != nil {
		return nil, err
	}
	if !k.Desktop {
		return nil, fmt.Errorf("%s has no desktop", k.Name)
	}
	return k, nil
}

// DesktopInfo describes a kitty's desktop: its image, whether a newer one waits, its backup.
func (m *Manager) DesktopInfo(ctx context.Context, ref string) (DesktopInfo, error) {
	k, err := m.desktopKitty(ref)
	if err != nil {
		return DesktopInfo{}, err
	}
	info := DesktopInfo{Image: m.cfg.Containers.Image, AutoUpdate: m.cfg.Containers.AutoUpdate && m.capabilities().ImageUpdates, Capabilities: m.capabilities()}
	if exists, _, err := m.computerState(ctx, k); err == nil && exists && m.capabilities().ImageUpdates {
		info.UpdateAvailable, _ = m.ctr().ImageStale(ctx, computerID(k), info.Image)
	}
	if m.keeper != nil {
		if b, ok := m.keeper.Info(k.ID); ok {
			info.Backup = &b
		}
	}
	return info, nil
}

// Backup backs up a running kitty's sessions now: what its browser has written to disk (it writes
// its cookies every half minute).
func (m *Manager) Backup(ctx context.Context, ref string) (keep.Info, error) {
	k, err := m.desktopKitty(ref)
	if err != nil {
		return keep.Info{}, err
	}
	if m.keeper == nil {
		return keep.Info{}, errors.New("this gateway keeps no backups")
	}
	if _, running, err := m.computerState(ctx, k); err != nil {
		return keep.Info{}, err
	} else if !running {
		return keep.Info{}, fmt.Errorf("%s is not running: start it to back it up", k.Name)
	}
	return m.backup(ctx, k)
}

func (m *Manager) backup(ctx context.Context, k *kitty.Kitty) (keep.Info, error) {
	ctx, cancel := context.WithTimeout(ctx, sessionsTimeout)
	defer cancel()
	out, err := m.ctr().Exec(ctx, computerID(k), "kitty-backup")
	if err != nil {
		return keep.Info{}, errors.New("this desktop's image cannot back up yet: update the desktop")
	}
	out = strings.TrimSpace(out)
	if out == "" {
		return keep.Info{}, errors.New("there is nothing to back up yet: its browser has not been used")
	}
	data, err := base64.StdEncoding.DecodeString(out)
	if err != nil {
		return keep.Info{}, errors.New("the backup the desktop made is not readable")
	}
	if err := m.keeper.Save(k.ID, data); err != nil {
		return keep.Info{}, err
	}
	info, _ := m.keeper.Info(k.ID)
	return info, nil
}

// saveSessions closes the browser in an orderly way, so it has written its cookies, sessions and
// passwords, and backs them up. It is the best that can be done before a stop or an update: what
// fails is not allowed to stop either.
func (m *Manager) saveSessions(ctx context.Context, k *kitty.Kitty) {
	if m.keeper == nil {
		return
	}
	quit, cancel := context.WithTimeout(ctx, sessionsTimeout)
	_, _ = m.ctr().Exec(quit, computerID(k), "kitty-page", "quit")
	cancel()
	_, _ = m.backup(ctx, k)
}

// restoreSessions gives a container made anew what its kitty's last backup held.
func (m *Manager) restoreSessions(ctx context.Context, k *kitty.Kitty) {
	if m.keeper == nil {
		return
	}
	data, _, err := m.keeper.Load(k.ID)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, sessionsTimeout)
	defer cancel()
	_, _ = m.ctr().ExecInput(ctx, computerID(k), string(data), "kitty-restore")
}

// UpdateInBackground moves a kitty's desktop to the newest image without making the caller wait
// (the image may be downloaded): the kitty is marked starting and comes up again, or fails with the
// reason on it. Its sessions are backed up first and given back to the new container; its
// workspace is untouched.
func (m *Manager) UpdateInBackground(ref string) (*kitty.Kitty, error) {
	if !m.capabilities().ImageUpdates {
		return nil, errors.New("this runtime keeps persistent disks; update packages inside the computer instead of replacing its image")
	}
	k, err := m.desktopKitty(ref)
	if err != nil {
		return nil, err
	}
	if m.Held(k.ID) {
		return nil, fmt.Errorf("the person has the desktop of %s: give it back first", k.Name)
	}
	if err := m.setStatus(k.ID, kitty.StatusStarting, ""); err != nil {
		return nil, err
	}
	starting, err := m.Get(k.ID)
	if err != nil {
		return nil, err
	}
	go func(id string) {
		ctx, cancel := context.WithTimeout(context.Background(), startTimeout)
		defer cancel()
		_ = m.update(ctx, id)
	}(k.ID)
	return starting, nil
}

func (m *Manager) update(ctx context.Context, id string) error {
	k, err := m.Get(id)
	if err != nil {
		return err
	}
	// A reference that is only built here has nothing to pull: what is on this machine is the news.
	_ = m.ctr().Pull(ctx, m.cfg.Containers.Image)
	return m.renew(ctx, k, false)
}

// renew makes a kitty's container anew from the newest image when it is of an older one. In auto
// mode it gives way, before touching anything, to a kitty that is working or that the person holds.
func (m *Manager) renew(ctx context.Context, k *kitty.Kitty, auto bool) error {
	if !m.capabilities().ImageUpdates {
		return errors.New("this runtime does not support image replacement")
	}
	exists, running, err := m.computerState(ctx, k)
	if err != nil {
		return m.fail(k.ID, err)
	}
	if exists {
		if stale, _ := m.ctr().ImageStale(ctx, computerID(k), m.cfg.Containers.Image); !stale {
			if auto {
				return nil
			}
			return m.setStatus(k.ID, kitty.StatusRunning, "")
		}
		if auto && (m.Held(k.ID) || m.busy(k.ID)) {
			return errBusy
		}
		if auto {
			if err := m.setStatus(k.ID, kitty.StatusStarting, ""); err != nil {
				return err
			}
		}
		if running {
			m.saveSessions(ctx, k)
		}
		if err := m.ctr().Remove(ctx, computerID(k)); err != nil {
			return m.fail(k.ID, err)
		}
	}
	return m.Start(ctx, k.ID)
}
