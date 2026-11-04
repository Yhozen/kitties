package boat

import (
	"context"
	"errors"
	"fmt"
	"strconv"
)

// Saved names are scoped to the authenticated account. Matching the immutable
// artifact and its recorded source proves recovery access even after VM deletion.
func (m *Manager) verifiedCheckpoint(ctx context.Context, r record) (savedSnapshot, error) {
	if r.CheckpointID == "" {
		return savedSnapshot{}, errors.New("computer has no verified permanent checkpoint")
	}
	point, err := m.saved(ctx, r.CheckpointName)
	if err != nil {
		return savedSnapshot{}, err
	}
	if point.Name != r.CheckpointName || point.Status != "ready" || point.SnapshotID != r.CheckpointID {
		return savedSnapshot{}, errors.New("saved checkpoint is unavailable or does not match the recorded recovery identity")
	}
	sourceKnown := r.RemoteID != "" && point.SourceSandboxID == r.RemoteID
	for _, id := range r.PreviousIDs {
		sourceKnown = sourceKnown || id != "" && point.SourceSandboxID == id
	}
	if !sourceKnown {
		return savedSnapshot{}, errors.New("saved checkpoint source is not a recorded computer")
	}
	return point, nil
}

func (m *Manager) checkRecordAccess(ctx context.Context, r record) error {
	verified := false
	if r.CheckpointID != "" {
		if _, err := m.verifiedCheckpoint(ctx, r); err != nil {
			return fmt.Errorf("verify recovery for %s: %w", r.Name, err)
		}
		verified = true
	}
	ids := append([]string{r.RemoteID}, r.PreviousIDs...)
	seen := map[string]bool{}
	for _, id := range ids {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		machine, err := m.get(ctx, id)
		if isStatus(err, 404) {
			if id != r.RemoteID || verified || r.Removed && r.Pending == nil {
				continue
			}
			return fmt.Errorf("recorded computer %s is inaccessible and has no verified recovery checkpoint", r.Name)
		}
		if err != nil {
			return fmt.Errorf("verify computer %s: %w", r.Name, err)
		}
		if id == r.RemoteID {
			if err = m.checkOwner(r, machine); err != nil {
				return err
			}
			if machine.DataExpiredAt != "" && !verified {
				return fmt.Errorf("expired computer %s has no verified recovery checkpoint", r.Name)
			}
			continue
		}
		if machine.Access != "owner" {
			return errors.New("previous computer is not owned by the authenticated Boat account")
		}
		if len(machine.Labels) != 0 {
			generation, err := strconv.Atoi(machine.Labels[generationLabel])
			if err != nil || generation < 1 || generation >= r.Generation || machine.Labels[ownerLabel] != m.ownerID || machine.Labels[kittyLabel] != r.Name {
				return errors.New("previous computer ownership does not match the recorded identity")
			}
		}
	}
	return nil
}

func (m *Manager) reconcileDeleted(ctx context.Context, r record) (bool, error) {
	if r.Pending == nil || r.Pending.Kind != "delete" {
		return false, errors.New("computer has no durable deletion intent")
	}
	machine, err := m.get(ctx, r.RemoteID)
	if err == nil {
		return false, m.checkOwner(r, machine)
	}
	if !isStatus(err, 404) {
		return false, err
	}
	point, err := m.verifiedCheckpoint(ctx, r)
	if err != nil {
		return false, fmt.Errorf("cannot reconcile missing deleted computer: %w", err)
	}
	if point.SourceSandboxID != r.RemoteID {
		return false, errors.New("deleted computer does not match the retained checkpoint source")
	}
	return true, nil
}
