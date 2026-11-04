package boat

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/madkoding/kitties/internal/container"
)

func withoutSeedTemplate(t *testing.T, m *Manager, f *boatFixture) {
	t.Helper()
	name := m.templateName()
	r, _ := m.lookup(name)
	delete(f.snapshots, r.CheckpointName)
	m.mu.Lock()
	delete(m.state.Computers, name)
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
}
func TestCleanTemplateIsScrubbedReusedAndReceiptBound(t *testing.T) {
	f := fixture()
	f.dropRestoreLabels = true
	m, _ := testManager(t, f)
	withoutSeedTemplate(t, m, f)
	scrubbed := false
	m.runGuest = func(_ context.Context, r record, stdin string, root bool, args ...string) ([]byte, error) {
		if r.Template && len(r.Env) != 0 {
			t.Fatal("template received a kitty environment")
		}
		if r.Template && root && len(args) > 2 && strings.Contains(args[2], "rm -rf /home/kitty/work/.browser") {
			scrubbed = true
		}
		return nil, nil
	}
	id, e := m.Up(context.Background(), container.Spec{Name: "kitty-personal", Env: map[string]string{"CUSTOM_KEY": "not-in-template"}})
	if e != nil {
		t.Fatal(e)
	}
	if !scrubbed || len(f.creates) != 2 || f.creates[0].From != "" || f.creates[1].From == "" || len(f.deleted) != 1 {
		t.Fatalf("unclean template lifecycle: scrubbed=%v creates=%d deletes=%d", scrubbed, len(f.creates), len(f.deleted))
	}
	template, _ := m.lookup(m.templateName())
	r, _ := m.lookup(id)
	if !template.Removed || template.Pending != nil || template.CheckpointID == "" || r.CheckpointID != "" || r.Receipt.SourceCheckpointID != template.CheckpointID {
		t.Fatal("template source was confused with personal recovery")
	}
	if _, e = m.Up(context.Background(), container.Spec{Name: "kitty-second"}); e != nil {
		t.Fatal(e)
	}
	if len(f.creates) != 3 || f.creates[1].From != f.creates[2].From {
		t.Fatal("template was rebuilt for second desktop")
	}
	if len(m.Recoveries()) != 0 {
		t.Fatal("internal template leaked into recovery listing")
	}
	if e = m.Start(context.Background(), template.Name); e == nil {
		t.Fatal("internal template exposed as desktop")
	}
	if e = m.PurgeCheckpoint(context.Background(), template.Name); e == nil {
		t.Fatal("internal template purge permitted")
	}
}
func TestInterruptedTemplateBootstrapAndCheckpointResumeWithoutDuplicate(t *testing.T) {
	for _, stage := range []string{"bootstrap", "checkpoint"} {
		t.Run(stage, func(t *testing.T) {
			f := fixture()
			m, _ := testManager(t, f)
			withoutSeedTemplate(t, m, f)
			failed := false
			m.runGuest = func(_ context.Context, r record, stdin string, root bool, args ...string) ([]byte, error) {
				if stage == "bootstrap" && r.Template && stdin != "" && !failed {
					failed = true
					return nil, errors.New("bootstrap interrupted")
				}
				return nil, nil
			}
			f.failedSnapshot = stage == "checkpoint"
			if _, e := m.Up(context.Background(), container.Spec{Name: "kitty-mimi"}); e == nil {
				t.Fatal("interruption was ignored")
			}
			r, _ := m.lookup(m.templateName())
			if r.Pending == nil || r.RemoteID == "" || len(f.creates) != 1 {
				t.Fatal("lost template creation identity")
			}
			f.failedSnapshot = false
			if _, e := m.Up(context.Background(), container.Spec{Name: "kitty-mimi"}); e != nil {
				t.Fatal(e)
			}
			if len(f.creates) != 2 || len(f.deleted) != 1 {
				t.Fatalf("duplicate template created: %d", len(f.creates))
			}
		})
	}
}
func TestTemplateVersionReplacementRetainsSourceOfPendingCreate(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	current, _ := m.lookup(m.templateName())
	old := current
	old.Name = "kitty-template-old"
	old.CheckpointName = checkpointName(m.ownerID, old.Name)
	old.CheckpointID = "old-template"
	if e := m.put(old); e != nil {
		t.Fatal(e)
	}
	f.snapshots[old.CheckpointName] = savedSnapshot{Name: old.CheckpointName, Status: "ready", SnapshotID: old.CheckpointID}
	pending := record{Name: "kitty-pending", Generation: 1, CheckpointName: checkpointName(m.ownerID, "kitty-pending"), Pending: &operation{Kind: "create", SourceCheckpointID: old.CheckpointID}}
	if e := m.put(pending); e != nil {
		t.Fatal(e)
	}
	if e := m.pruneTemplates(context.Background(), current); e != nil {
		t.Fatal(e)
	}
	if _, e := m.lookup(old.Name); e != nil {
		t.Fatal("deleted template needed by uncertain create")
	}
	pending.Pending = nil
	if e := m.put(pending); e != nil {
		t.Fatal(e)
	}
	if e := m.pruneTemplates(context.Background(), current); e != nil {
		t.Fatal(e)
	}
	if _, e := m.lookup(old.Name); e == nil {
		t.Fatal("obsolete template retained indefinitely")
	}
	before := m.templateName()
	m.size = "large"
	if before == m.templateName() {
		t.Fatal("template crossed incompatible machine type")
	}
}

func TestTemplateUnavailableOrScrubFailureCannotSeedDesktop(t *testing.T) {
	for _, mode := range []string{"identity conflict", "changed checkpoint", "missing checkpoint", "scrub failed"} {
		t.Run(mode, func(t *testing.T) {
			f := fixture()
			m, _ := testManager(t, f)
			r, _ := m.lookup(m.templateName())
			switch mode {
			case "identity conflict":
				r.Template = false
				_ = m.put(r)
			case "changed checkpoint":
				s := f.snapshots[r.CheckpointName]
				s.SnapshotID = "changed"
				f.snapshots[r.CheckpointName] = s
			case "missing checkpoint":
				delete(f.snapshots, r.CheckpointName)
			case "scrub failed":
				withoutSeedTemplate(t, m, f)
				m.runGuest = func(_ context.Context, r record, stdin string, root bool, args ...string) ([]byte, error) {
					if r.Template && root && len(args) > 2 && strings.Contains(args[2], "rm -rf") {
						return nil, errors.New("profile did not close")
					}
					return nil, nil
				}
			}
			if _, e := m.Up(context.Background(), container.Spec{Name: "kitty-mimi"}); e == nil {
				t.Fatal("unverified template seeded a desktop")
			}
			for _, request := range f.creates {
				if request.Name == "kitty-mimi" {
					t.Fatal("created desktop from invalid template")
				}
			}
		})
	}
}
