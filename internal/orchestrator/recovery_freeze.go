package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/madkoding/kitties/internal/statefs"
)

const RecoveryFreezeFile = "recovery-freeze.json"

var recoveryOperationID = regexp.MustCompile(`^[a-zA-Z0-9_-]{16,64}$`)
var ErrRecoveryConflict = errors.New("recovery operation conflicts with the saved gateway hold")

type recoveryFreeze struct {
	Active   string          `json:"active,omitempty"`
	Released map[string]bool `json:"released,omitempty"`
}

func (m *Manager) loadRecoveryFreeze() error {
	raw, err := os.ReadFile(filepath.Join(m.cfg.DataDirOr(), RecoveryFreezeFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if err = json.Unmarshal(raw, &m.recoveryFreeze); err != nil {
		return err
	}
	if m.recoveryFreeze.Active != "" && !recoveryOperationID.MatchString(m.recoveryFreeze.Active) {
		return errors.New("invalid saved recovery hold")
	}
	for id := range m.recoveryFreeze.Released {
		if !recoveryOperationID.MatchString(id) {
			return errors.New("invalid saved recovery cancellation")
		}
	}
	if m.recoveryFreeze.Active != "" {
		if m.recoveryFreeze.Released[m.recoveryFreeze.Active] {
			return errors.New("cancelled recovery still holds the gateway")
		}
		return m.admission.Freeze(context.Background())
	}
	return nil
}

func (m *Manager) saveRecoveryFreeze(next recoveryFreeze) error {
	raw, _ := json.Marshal(next)
	var err error
	path := filepath.Join(m.cfg.DataDirOr(), RecoveryFreezeFile)
	if err = statefs.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if err = statefs.WriteFile(path+".tmp", raw, 0o600); err != nil {
		return err
	}
	if err = statefs.Rename(path+".tmp", path); err != nil {
		return err
	}
	m.recoveryFreeze = next
	return nil
}

// PrepareRecovery records the named hold before draining; only an explicit release opens it.
func (m *Manager) PrepareRecovery(ctx context.Context, id string) error {
	if !recoveryOperationID.MatchString(id) {
		return errors.New("invalid recovery operation ID")
	}
	m.recoveryMu.Lock()
	defer m.recoveryMu.Unlock()
	if m.recoveryFreeze.Released[id] || m.recoveryFreeze.Active != "" && m.recoveryFreeze.Active != id {
		return ErrRecoveryConflict
	}
	if m.recoveryFreeze.Active == "" {
		next := m.recoveryFreeze
		next.Active = id
		if err := m.saveRecoveryFreeze(next); err != nil {
			return err
		}
	}
	if err := m.admission.Freeze(ctx); err != nil {
		return err
	}
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for m.AnyHeld() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
	for _, k := range m.List() {
		if k.ResumeAfterBackup || k.Operation.Kind != "" {
			return fmt.Errorf("%s has unfinished lifecycle work; retry recovery after it completes", k.Name)
		}
	}
	return ctx.Err()
}

// ReleaseRecovery remembers cancellation even when a delayed prepare has not arrived yet.
func (m *Manager) ReleaseRecovery(id string) error {
	if !recoveryOperationID.MatchString(id) {
		return errors.New("invalid recovery operation ID")
	}
	m.recoveryMu.Lock()
	defer m.recoveryMu.Unlock()
	if m.recoveryFreeze.Active != "" && m.recoveryFreeze.Active != id {
		return ErrRecoveryConflict
	}
	if m.recoveryFreeze.Released[id] {
		return nil
	}
	next := recoveryFreeze{Released: make(map[string]bool, len(m.recoveryFreeze.Released)+1)}
	for prior := range m.recoveryFreeze.Released {
		next.Released[prior] = true
	}
	next.Released[id] = true
	if err := m.saveRecoveryFreeze(next); err != nil {
		return err
	}
	m.admission.Thaw()
	return nil
}
