package orchestrator

import (
	"context"
	"fmt"
	"sync"

	"github.com/madkoding/kitties/internal/computer"
	"github.com/madkoding/kitties/internal/container"
	"github.com/madkoding/kitties/internal/kitty"
)

func (m *Manager) capabilities() computer.Capabilities {
	if c, ok := m.ctr().(computer.Capable); ok {
		return c.Capabilities()
	}
	kind := m.cfg.Containers.Runtime
	if kind == "" {
		kind = "auto"
	}
	// Older runtimes do not expose capabilities. These configuration values also
	// cover a temporarily unavailable engine while existing state is loaded.
	persistent := kind == "lima" || kind == "boat"
	return computer.Capabilities{Kind: kind, PersistentDisk: persistent, GuestWorkspace: persistent, ImageUpdates: !persistent}
}

func (m *Manager) runtimeMatches(kind string) bool {
	active := m.capabilities().Kind
	if active == "auto" {
		return kind == "auto" || kind == "docker" || kind == "podman"
	}
	return kind == active || kind == "auto" && (active == "docker" || active == "podman")
}

func (m *Manager) checkRuntime(k *kitty.Kitty) error {
	if !k.Desktop {
		return nil
	}
	if !m.runtimeMatches(k.Computer.Runtime) {
		return fmt.Errorf("%s belongs to runtime %q, but %q is configured; restore its original runtime or use a separate data directory (changing the runtime does not migrate computers)", k.Name, k.Computer.Runtime, m.capabilities().Kind)
	}
	if m.ctr() == nil {
		return fmt.Errorf("the runtime for %s is unavailable", k.Name)
	}
	return nil
}

func computerID(k *kitty.Kitty) string {
	if k.Computer.ID != "" {
		return k.Computer.ID
	}
	return k.Container
}

func (m *Manager) migrateComputer(k *kitty.Kitty) error {
	if k.Availability == "" {
		k.Availability = computer.Enabled
		if k.Status == kitty.StatusStopped {
			k.Availability = computer.Disabled
		}
	}
	if !k.Desktop {
		return nil
	}
	if k.Computer.Runtime == "" {
		switch {
		case k.Workspace == container.Workdir:
			k.Computer.Runtime = "lima"
		case m.capabilities().GuestWorkspace:
			return fmt.Errorf("%s has a legacy container workspace; changing containers.runtime to %q cannot migrate it; use a separate data directory", k.Name, m.capabilities().Kind)
		default:
			k.Computer.Runtime = m.capabilities().Kind
		}
	}
	if !m.runtimeMatches(k.Computer.Runtime) {
		return fmt.Errorf("%s belongs to runtime %q, but %q is configured; restore its original runtime or use a separate data directory", k.Name, k.Computer.Runtime, m.capabilities().Kind)
	}
	return nil
}

func (m *Manager) lockComputer(id string) func() {
	m.opMu.Lock()
	if m.operations == nil {
		m.operations = map[string]*sync.Mutex{}
	}
	lock := m.operations[id]
	if lock == nil {
		lock = &sync.Mutex{}
		m.operations[id] = lock
	}
	m.opMu.Unlock()
	lock.Lock()
	return lock.Unlock
}

func (m *Manager) beginOperation(id, kind, availability string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	k, ok := m.kitties[id]
	if !ok {
		return ErrNotFound
	}
	before := *k
	k.Availability = availability
	if k.Operation.Kind != kind {
		k.Operation = kitty.Operation{Kind: kind, StartedAt: m.now()}
	}
	if kind == "start" {
		k.Status = kitty.StatusStarting
	}
	if err := m.saveLocked(); err != nil {
		*k = before
		return err
	}
	return nil
}

func (m *Manager) finishOperation(id, status string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	k, ok := m.kitties[id]
	if !ok {
		return ErrNotFound
	}
	before := *k
	k.Operation = kitty.Operation{}
	k.Status, k.Error = status, ""
	if err := m.saveLocked(); err != nil {
		*k = before
		return err
	}
	return nil
}

func (m *Manager) rememberComputer(id string, ref computer.Reference) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	k, ok := m.kitties[id]
	if !ok {
		return ErrNotFound
	}
	if ref.Runtime == "" {
		ref.Runtime = k.Computer.Runtime
	}
	if ref.ID == "" {
		return fmt.Errorf("runtime returned an empty computer identity for %s", k.Name)
	}
	if !m.runtimeMatches(ref.Runtime) {
		return fmt.Errorf("runtime returned an incompatible identity for %s", k.Name)
	}
	if k.Computer.OwnerID != "" && ref.OwnerID != k.Computer.OwnerID {
		return fmt.Errorf("runtime ownership changed for %s", k.Name)
	}
	if ref.Generation < k.Computer.Generation {
		return fmt.Errorf("runtime returned an older computer generation for %s", k.Name)
	}
	before := k.Computer
	k.Computer = ref
	if err := m.saveLocked(); err != nil {
		k.Computer = before
		return err
	}
	return nil
}

func (m *Manager) refreshComputer(ctx context.Context, k *kitty.Kitty) error {
	r, ok := m.ctr().(computer.Resolver)
	if !ok {
		return nil
	}
	ref, err := r.Resolve(ctx, k.Container)
	if err != nil {
		return err
	}
	if ref == k.Computer {
		return nil
	}
	return m.rememberComputer(k.ID, ref)
}

func (m *Manager) computerState(ctx context.Context, k *kitty.Kitty) (exists, running bool, err error) {
	if err := m.checkRuntime(k); err != nil {
		return false, false, err
	}
	infos, err := m.ctr().List(ctx)
	if err != nil {
		return false, false, err
	}
	for _, i := range infos {
		if k.Computer.ID != "" && i.ID == k.Computer.ID || k.Computer.ID == "" && i.Name == k.Container {
			return true, i.Running, nil
		}
	}
	return false, false, nil
}
