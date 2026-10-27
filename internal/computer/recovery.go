package computer

import "time"

// Recovery remains addressable by Name after its kitty or live computer is removed.
type Recovery struct {
	Name           string    `json:"name"`
	Computer       Reference `json:"computer"`
	CheckpointName string    `json:"checkpoint_name"`
	CheckpointAt   time.Time `json:"checkpoint_at,omitempty"`
	Removed        bool      `json:"removed"`
	Pending        string    `json:"pending,omitempty"`
}
