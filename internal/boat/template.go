package boat

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"

	"github.com/madkoding/kitties/internal/guest"
)

func (m *Manager) templateName() string {
	sum := sha256.Sum256([]byte("kitties-template-v1\x00linux-amd64\x00" + m.size + "\x00" + guest.BoatScript))
	return "kitty-template-" + hex.EncodeToString(sum[:16])
}

// template is called under the lifecycle gate. Its normal pending-operation
// journal makes interrupted bootstrap, checkpointing and deletion resumable.
func (m *Manager) template(ctx context.Context) (savedSnapshot, error) {
	name := m.templateName()
	r, err := m.lookup(name)
	if err != nil {
		r = record{Name: name, KittyName: "clean-template", Template: true, Generation: 1, CheckpointName: checkpointName(m.ownerID, name)}
		if err = m.put(r); err != nil {
			return savedSnapshot{}, err
		}
	}
	if !r.Template || len(r.Env) != 0 {
		return savedSnapshot{}, errors.New("clean template identity conflicts with a desktop")
	}
	if r.CheckpointID == "" {
		if r.Pending != nil && (r.Pending.Kind == "stop" || r.Pending.Kind == "checkpoint") {
			if err = m.stop(ctx, r); err != nil {
				return savedSnapshot{}, err
			}
		} else {
			if err = m.start(ctx, r); err != nil {
				return savedSnapshot{}, fmt.Errorf("prepare clean desktop template: %w", err)
			}
			r, _ = m.lookup(name)
			if err = m.stop(ctx, r); err != nil {
				return savedSnapshot{}, err
			}
		}
		r, _ = m.lookup(name)
	}
	snapshot, err := m.saved(ctx, r.CheckpointName)
	if err != nil {
		return savedSnapshot{}, err
	}
	if snapshot.Status != "ready" || snapshot.SnapshotID != r.CheckpointID {
		return savedSnapshot{}, errors.New("clean desktop template checkpoint is unavailable or changed")
	}
	if !r.Removed {
		if err = m.deleteComputer(ctx, r); err != nil {
			return savedSnapshot{}, err
		}
	}
	if err = m.pruneTemplates(ctx, r); err != nil {
		return savedSnapshot{}, err
	}
	return snapshot, nil
}

func (m *Manager) pruneTemplates(ctx context.Context, current record) error {
	records := m.records()
	for _, old := range records {
		if !old.Template || old.Name == current.Name || !old.Removed || old.Pending != nil {
			continue
		}
		inUse := false
		for _, r := range records {
			if r.Pending != nil && r.Pending.SourceCheckpointID == old.CheckpointID {
				inUse = true
				break
			}
		}
		if inUse {
			continue
		}
		if err := m.json(ctx, "DELETE", "/saved-snapshots/"+url.PathEscape(old.CheckpointName), nil, nil, nil); err != nil && !isStatus(err, 404) {
			return err
		}
		m.mu.Lock()
		delete(m.state.Computers, old.Name)
		err := m.saveLocked()
		m.mu.Unlock()
		if err != nil {
			return err
		}
	}
	return nil
}
