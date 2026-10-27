// Package computer describes durable runtime identity independently of a kitty's AI provider.
package computer

import "context"

type Reference struct {
	Runtime      string `json:"runtime,omitempty"`
	ID           string `json:"id,omitempty"`
	OwnerID      string `json:"owner_id,omitempty"`
	Generation   int    `json:"generation,omitempty"`
	CheckpointID string `json:"checkpoint_id,omitempty"`
}

type Capabilities struct {
	Kind           string `json:"kind"`
	PersistentDisk bool   `json:"persistent_disk"`
	GuestWorkspace bool   `json:"guest_workspace"`
	ImageUpdates   bool   `json:"image_updates"`
}

type Capable interface {
	Capabilities() Capabilities
}

// Resolver returns the current identity for a stable logical name. A restored
// computer can have a new remote ID while retaining the kitty and its checkpoint.
type Resolver interface {
	Resolve(context.Context, string) (Reference, error)
}

const (
	Enabled  = "enabled"
	Sleeping = "sleeping"
	Disabled = "disabled"
)
