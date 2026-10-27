package boat

import (
	"context"
	"errors"
	"fmt"
)

// Initialize resumes interrupted checkpoint promotion during normal startup.
// Recovery preflight must use the strictly read-only CheckAccess instead.
func (m *Manager) Initialize(ctx context.Context) error {
	if err := m.lockLifecycle(ctx); err != nil {
		return err
	}
	defer func() { <-m.lifecycle }()
	if err := m.checkPolicy(ctx); err != nil {
		return err
	}
	for _, r := range m.records() {
		if r.Pending == nil || r.Pending.Kind != "checkpoint" {
			continue
		}
		if err := m.guardGeneration(ctx, r); err != nil {
			return err
		}
		if err := m.finishPendingCheckpoint(ctx, r); err != nil {
			return fmt.Errorf("resume checkpoint for %s: %w", r.Name, err)
		}
	}
	return m.checkIdentities(ctx)
}

func (m *Manager) finishPendingCheckpoint(ctx context.Context, r record) error {
	machine, err := m.get(ctx, r.RemoteID)
	if err != nil {
		return err
	}
	if err = m.checkOwner(r, machine); err != nil {
		return err
	}
	if machine.State != "archived" {
		return errors.New("pending checkpoint source is not archived")
	}
	point, err := m.saved(ctx, r.CheckpointName)
	if err != nil && !isStatus(err, 404) {
		return err
	}
	if err == nil {
		if point.Name != r.CheckpointName || point.SnapshotID != r.CheckpointID && point.SourceSandboxID != r.RemoteID {
			return errors.New("pending checkpoint was replaced by an unrelated source")
		}
		if point.Status == "ready" && point.SnapshotID != "" && point.SnapshotID != r.CheckpointID {
			r.CheckpointID = point.SnapshotID
			r.CheckpointAt = m.now()
			r.Pending = nil
			return m.put(r)
		}
		if point.Status == "ready" && r.CheckpointID != "" {
			if _, err = m.verifiedCheckpoint(ctx, r); err != nil {
				return err
			}
		}
	}
	if !machine.SnapshotAvailable || machine.LastSnapshotStatus == "failed" || machine.DataExpiredAt != "" {
		return errors.New("pending checkpoint source has no verified archived snapshot")
	}
	return m.saveCheckpoint(ctx, r)
}
