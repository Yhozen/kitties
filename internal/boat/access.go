package boat

import (
	"context"
	"errors"
)

// CheckAccess verifies that account policy permits durable computers. It does not
// create a machine, change billing, or register an SSH key.
func (m *Manager) CheckAccess(ctx context.Context) error {
	if err := m.checkPolicy(ctx); err != nil {
		return err
	}
	for _, r := range m.records() {
		if r.Pending != nil {
			return errors.New("Boat has an unresolved operation; normal startup must reconcile it before recovery preflight")
		}
	}
	return m.checkIdentities(ctx)
}

func (m *Manager) checkPolicy(ctx context.Context) error {
	var policy struct {
		Enabled      bool `json:"enabled"`
		SnapshotsOff bool `json:"snapshotsOff"`
	}
	if err := m.json(ctx, "GET", "/account/data-retention", nil, nil, &policy); err != nil {
		return err
	}
	if policy.Enabled || policy.SnapshotsOff {
		return errors.New("Boat account policy disables durable snapshots; disable zero data retention and enable snapshots before using cloud computers")
	}
	var snapshots struct {
		Allowance struct {
			Included int `json:"included"`
		} `json:"allowance"`
	}
	if err := m.json(ctx, "GET", "/saved-snapshots", nil, nil, &snapshots); err != nil {
		return err
	}
	if snapshots.Allowance.Included < 1 {
		return errors.New("Boat cloud computers require a paid plan with permanent saved snapshots")
	}
	return nil
}

func (m *Manager) checkIdentities(ctx context.Context) error {
	for _, r := range m.records() {
		if err := m.guardGeneration(ctx, r); err != nil {
			return err
		}
		if err := m.checkRecordAccess(ctx, r); err != nil {
			return err
		}
	}
	return nil
}
