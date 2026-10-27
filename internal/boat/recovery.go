package boat

import (
	"sort"

	"github.com/madkoding/kitties/internal/computer"
)

// Recoveries includes retained checkpoints after Remove deletes the live computer.
func (m *Manager) Recoveries() []computer.Recovery {
	result := make([]computer.Recovery, 0)
	for _, r := range m.records() {
		if r.Template {
			continue
		}
		if r.CheckpointID == "" && (r.Pending == nil || r.Pending.Kind != "checkpoint") {
			continue
		}
		point := computer.Recovery{Name: r.Name, Computer: computer.Reference{Runtime: "boat", ID: r.RemoteID, OwnerID: m.ownerID, Generation: r.Generation, CheckpointID: r.CheckpointID}, CheckpointName: r.CheckpointName, CheckpointAt: r.CheckpointAt, Removed: r.Removed}
		if r.Pending != nil {
			point.Pending = r.Pending.Kind
		}
		result = append(result, point)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result
}
