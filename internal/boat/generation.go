package boat

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"time"
)

// The label-filtered inventory cannot see Boat's unlabeled restored computers.
// Names are used only to detect conflicts, never to authorize access or adoption.
func (m *Manager) guardGeneration(ctx context.Context, r record) error {
	cursor := ""
	seen := map[string]bool{}
	replay := r.Pending != nil && r.Pending.Kind == "create" && r.Pending.Key != "" && len(r.Pending.Body) > 0 && m.now().Sub(r.Pending.StartedAt) < 24*time.Hour
	for {
		query := url.Values{"limit": {"100"}}
		if cursor != "" {
			query.Set("cursor", cursor)
		}
		var page struct {
			Sandboxes []sandbox `json:"sandboxes"`
			PageInfo  struct {
				HasMore    bool   `json:"hasMore"`
				NextCursor string `json:"nextCursor"`
			} `json:"pageInfo"`
		}
		if err := m.json(ctx, "GET", "/sandboxes?"+query.Encode(), nil, nil, &page); err != nil {
			return err
		}
		for _, s := range page.Sandboxes {
			if s.Access != "owner" {
				continue
			}
			labeled := s.Labels[ownerLabel] == m.ownerID && s.Labels[kittyLabel] == r.Name
			if labeled {
				generation, err := strconv.Atoi(s.Labels[generationLabel])
				if err != nil || generation > r.Generation {
					return fmt.Errorf("provider has a newer or invalid generation for %s; reconcile the restored gateway state", r.Name)
				}
			}
			if !labeled && (len(s.Labels) != 0 || s.Name != r.Name) {
				continue
			}
			known := s.ID == r.RemoteID
			for _, id := range r.PreviousIDs {
				known = known || id == s.ID
			}
			if !known && !replay {
				return fmt.Errorf("provider has an unrecorded computer named %s; reconcile the restored gateway state", r.Name)
			}
		}
		if !page.PageInfo.HasMore {
			return nil
		}
		cursor = page.PageInfo.NextCursor
		if cursor == "" || seen[cursor] {
			return errors.New("Boat generation inventory pagination did not advance")
		}
		seen[cursor] = true
	}
}
