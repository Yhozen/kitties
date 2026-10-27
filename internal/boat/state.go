package boat

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"time"

	"github.com/madkoding/kitties/internal/statefs"
)

var namePattern = regexp.MustCompile(`^kitty-[a-z0-9][a-z0-9-]{0,56}$`)

type operation struct {
	SourceCheckpointID string          `json:"source_checkpoint_id,omitempty"`
	Kind               string          `json:"kind"`
	Key                string          `json:"key,omitempty"`
	Body               json.RawMessage `json:"body,omitempty"`
	StartedAt          time.Time       `json:"started_at"`
	ID                 string          `json:"id,omitempty"`
}
type creationReceipt struct {
	ID                 string          `json:"id"`
	Generation         int             `json:"generation"`
	SourceCheckpointID string          `json:"source_checkpoint_id,omitempty"`
	Key                string          `json:"key,omitempty"`
	Body               json.RawMessage `json:"body,omitempty"`
	At                 time.Time       `json:"at"`
}

type record struct {
	Template       bool              `json:"template,omitempty"`
	Receipt        *creationReceipt  `json:"creation_receipt,omitempty"`
	Name           string            `json:"name"`
	KittyName      string            `json:"kitty_name"`
	RemoteID       string            `json:"remote_id,omitempty"`
	PreviousIDs    []string          `json:"previous_ids,omitempty"`
	Generation     int               `json:"generation"`
	CheckpointName string            `json:"checkpoint_name"`
	CheckpointID   string            `json:"checkpoint_id,omitempty"`
	CheckpointAt   time.Time         `json:"checkpoint_at,omitempty"`
	Env            map[string]string `json:"env,omitempty"`
	Pending        *operation        `json:"pending,omitempty"`
	Removed        bool              `json:"removed,omitempty"`
}
type diskState struct {
	Version   int               `json:"version"`
	OwnerID   string            `json:"owner_id"`
	Computers map[string]record `json:"computers"`
}

func randomID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func checkpointName(owner, name string) string {
	sum := sha256.Sum256([]byte(name))
	return "kt-" + owner[:12] + "-" + hex.EncodeToString(sum[:10])
}
func (m *Manager) load() error {
	data, err := os.ReadFile(filepath.Join(m.dir, "state.json"))
	if errors.Is(err, os.ErrNotExist) {
		m.state = diskState{Version: 1, OwnerID: randomID(), Computers: map[string]record{}}
		m.ownerID = m.state.OwnerID
		return m.saveLocked()
	}
	if err != nil {
		return err
	}
	if err = json.Unmarshal(data, &m.state); err != nil {
		return fmt.Errorf("read Boat state: %w", err)
	}
	if m.state.Version != 1 || len(m.state.OwnerID) != 32 || m.state.Computers == nil {
		return errors.New("invalid Boat state; restore its backup before starting computers")
	}
	for name, r := range m.state.Computers {
		if !namePattern.MatchString(name) || r.Name != name || r.Generation < 1 || r.CheckpointName != checkpointName(m.state.OwnerID, name) {
			return errors.New("invalid Boat computer identity in state")
		}
	}
	m.ownerID = m.state.OwnerID
	return nil
}
func (m *Manager) saveLocked() error {
	data, err := json.MarshalIndent(m.state, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(m.dir, "state.json"), data, 0o600)
}
func atomicWrite(path string, data []byte, mode os.FileMode) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".kitties-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(mode); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = statefs.Rename(name, path); err != nil {
		return err
	}
	d, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
func (m *Manager) lookup(ref string) (record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.state.Computers[ref]; ok {
		return r, nil
	}
	for _, r := range m.state.Computers {
		if r.RemoteID != "" && r.RemoteID == ref {
			return r, nil
		}
		for _, id := range r.PreviousIDs {
			if id == ref {
				return r, nil
			}
		}
	}
	return record{}, fmt.Errorf("computer %q is not owned by this Kitties installation", ref)
}
func (m *Manager) put(r record) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	old, existed := m.state.Computers[r.Name]
	m.state.Computers[r.Name] = r
	if err := m.saveLocked(); err != nil {
		if existed {
			m.state.Computers[r.Name] = old
		} else {
			delete(m.state.Computers, r.Name)
		}
		return err
	}
	return nil
}
func (m *Manager) records() []record {
	m.mu.Lock()
	defer m.mu.Unlock()
	rs := make([]record, 0, len(m.state.Computers))
	for _, r := range m.state.Computers {
		rs = append(rs, r)
	}
	return rs
}
func (m *Manager) checkOwner(r record, s sandbox) error {
	if s.ID != r.RemoteID || s.Access != "owner" {
		return errors.New("Boat computer ownership does not match the saved identity")
	}
	if s.Labels[ownerLabel] == m.ownerID && s.Labels[kittyLabel] == r.Name && s.Labels[generationLabel] == strconv.Itoa(r.Generation) {
		return nil
	}
	// Boat drops labels on saved-snapshot restores. Only the exact ID returned by
	// our authenticated create can use the durable receipt fallback.
	if len(s.Labels) == 0 && r.Receipt != nil && r.Receipt.ID == r.RemoteID && r.Receipt.Generation == r.Generation && r.Receipt.SourceCheckpointID != "" {
		return nil
	}
	return errors.New("Boat computer ownership does not match the saved identity")
}
