package orchestrator

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/madkoding/kitties/internal/computer"
	"github.com/madkoding/kitties/internal/kitty"
	"github.com/madkoding/kitties/internal/maintenance"
)

func (m *Manager) Admission() *maintenance.Gate { return &m.admission }

// AcquireActivity carries admission into background tasks spawned by a chat turn.
func (m *Manager) AcquireActivity(ctx context.Context, ref string) (context.Context, func(), error) {
	ctx, leave, err := m.admission.Enter(ctx)
	if err != nil {
		return ctx, nil, err
	}
	release, err := m.Acquire(ctx, ref)
	if err != nil {
		leave()
		return ctx, nil, err
	}
	return ctx, func() { release(); leave() }, nil
}

// BeginMaintenance closes admission, then drains tasks and desktop viewers without cancelling them.
func (m *Manager) BeginMaintenance(ctx context.Context, idleOnly bool) (context.Context, func(), error) {
	if idleOnly && m.AnyHeld() {
		return ctx, nil, maintenance.ErrBusy
	}
	var release func()
	var err error
	if idleOnly {
		ctx, release, err = m.admission.TryBegin(ctx)
	} else {
		ctx, release, err = m.admission.Begin(ctx)
	}
	if err != nil {
		return ctx, nil, err
	}
	timer := time.NewTicker(50 * time.Millisecond)
	defer timer.Stop()
	for m.AnyHeld() {
		select {
		case <-ctx.Done():
			release()
			return ctx, nil, ctx.Err()
		case <-timer.C:
		}
	}
	for _, k := range m.List() {
		if k.ResumeAfterBackup {
			release()
			return ctx, nil, fmt.Errorf("%s has unfinished backup recovery; retry after it resumes", k.Name)
		}
		if k.Operation.Kind != "" {
			release()
			return ctx, nil, fmt.Errorf("%s has unfinished %s; retry after recovery completes", k.Name, k.Operation.Kind)
		}
	}
	return ctx, release, nil
}

type homeExporter interface {
	ExportHome(context.Context, string, io.Writer) error
}

// CaptureHomes leaves each computer at its saved checkpoint until the caller captures gateway state.
// Resume restores the previous availability even when capture fails partway through.
func (m *Manager) CaptureHomes(ctx context.Context, dir string) ([]computer.Recovery, func() error, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, nil, err
	}
	return m.CaptureHomesTo(ctx, func(name string, stream func(io.Writer) error) error {
		file, err := os.OpenFile(filepath.Join(dir, name+".tar"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		return errors.Join(stream(file), file.Close())
	})
}

// CaptureHomesTo streams one saved home at a time while maintenance excludes new work.
func (m *Manager) CaptureHomesTo(ctx context.Context, sink func(string, func(io.Writer) error) error) (homes []computer.Recovery, resume func() error, err error) {
	if !m.admission.Owns(ctx) {
		return nil, nil, errors.New("desktop capture requires maintenance")
	}
	exporter, ok := m.ctr().(homeExporter)
	if !ok {
		for _, k := range m.List() {
			if k.Desktop {
				return nil, nil, errors.New("runtime does not support full home recovery exports")
			}
		}
		return nil, func() error { return nil }, nil
	}
	var previous []*kitty.Kitty
	resume = func() error {
		resumeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Minute)
		defer cancel()
		var failures []error
		for _, k := range previous {
			if k.Status == kitty.StatusRunning && k.Availability == computer.Enabled {
				if err := m.resumeBackup(resumeCtx, k.ID); err != nil {
					failures = append(failures, fmt.Errorf("resume %s: %w", k.Name, err))
				}
			}
		}
		return errors.Join(failures...)
	}
	for _, k := range m.List() {
		if !k.Desktop {
			continue
		}
		previous = append(previous, k)
		if k.Status == kitty.StatusRunning {
			if err = m.sleepForBackup(ctx, k.ID); err != nil {
				return
			}
		}
	}
	for _, k := range previous {
		current, getErr := m.Get(k.ID)
		if getErr != nil {
			err = getErr
			return
		}
		if current.Computer.CheckpointID == "" {
			err = fmt.Errorf("%s has no saved recovery checkpoint", k.Name)
			return
		}
		err = sink(k.ID, func(w io.Writer) error { return exporter.ExportHome(ctx, computerID(current), w) })
		if err != nil {
			return
		}
		homes = append(homes, computer.Recovery{Name: k.Name, Computer: current.Computer})
	}
	if inventory, ok := m.ctr().(recoveryInventory); ok {
		for _, recovery := range inventory.Recoveries() {
			if !recovery.Removed {
				continue
			}
			if recovery.Pending != "" {
				err = fmt.Errorf("retained computer %s has unfinished work", recovery.Name)
				return
			}
			if recovery.Computer.CheckpointID == "" {
				continue
			}
			if filepath.Base(recovery.Name) != recovery.Name || recovery.Name == "." || recovery.Name == ".." {
				err = errors.New("invalid retained computer name")
				return
			}
			err = sink("removed-"+recovery.Name, func(w io.Writer) error { return exporter.ExportHome(ctx, recovery.Name, w) })
			if err != nil {
				return
			}
			homes = append(homes, recovery)
		}
	}
	return
}

// setBackupResume is called while the computer gate excludes newer lifecycle intent.
func (m *Manager) setBackupResume(id string, resume bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	k, ok := m.kitties[id]
	if !ok {
		return ErrNotFound
	}
	if k.ResumeAfterBackup == resume {
		return nil
	}
	before := k.ResumeAfterBackup
	k.ResumeAfterBackup = resume
	if err := m.saveLocked(); err != nil {
		k.ResumeAfterBackup = before
		return err
	}
	return nil
}
func (m *Manager) sleepForBackup(ctx context.Context, id string) error {
	unlock, err := m.lockComputer(ctx, id)
	if err != nil {
		return err
	}
	defer unlock()
	k, err := m.Get(id)
	if err != nil {
		return err
	}
	if k.Status == kitty.StatusRunning && k.Availability == computer.Enabled {
		if err := m.setBackupResume(id, true); err != nil {
			return err
		}
	}
	return m.stopComputer(ctx, id, computer.Sleeping)
}
func (m *Manager) resumeBackup(ctx context.Context, id string) error {
	ctx, release, err := m.admission.Enter(ctx)
	if err != nil {
		return err
	}
	defer release()
	unlock, err := m.lockComputer(ctx, id)
	if err != nil {
		return err
	}
	defer unlock()
	return m.resumeBackupComputer(ctx, id)
}

// resumeBackupComputer retries a persisted stop before restoring running availability.
func (m *Manager) resumeBackupComputer(ctx context.Context, id string) error {
	k, err := m.Get(id)
	if err != nil || !k.ResumeAfterBackup {
		return err
	}
	if k.Operation.Kind == "stop" {
		if err := m.stopComputer(ctx, id, k.Availability); err != nil {
			return err
		}
	}
	return m.startComputer(ctx, id)
}
