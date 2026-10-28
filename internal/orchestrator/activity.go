package orchestrator

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/madkoding/kitties/internal/computer"
	"github.com/madkoding/kitties/internal/kitty"
)

var ErrDisabled = errors.New("computer is stopped; start it before assigning work")
var ErrDraining = errors.New("computer is stopping; wait for the current operation")
var ErrLifecycleBusy = errors.New("computer already has a lifecycle operation in progress")
var ErrRecoveryBusy = errors.New("remove the computer before purging its retained recovery checkpoint")

func (m *Manager) touch(id string) {
	m.activityMu.Lock()
	defer m.activityMu.Unlock()
	if m.lastActivity == nil {
		m.lastActivity = map[string]time.Time{}
	}
	m.lastActivity[id] = m.now()
}

// Acquire wakes an enabled computer and holds it awake until the caller releases it.
func (m *Manager) Acquire(ctx context.Context, ref string) (func(), error) {
	ctx, admitted, admissionErr := m.admission.Enter(ctx)
	if admissionErr != nil {
		return nil, admissionErr
	}
	retained := false
	defer func() {
		if !retained {
			admitted()
		}
	}()
	k, err := m.Get(ref)
	if err != nil {
		return nil, err
	}
	unlock, err := m.lockComputer(ctx, k.ID)
	if err != nil {
		return nil, err
	}
	defer unlock()
	k, err = m.Get(k.ID)
	if err != nil {
		return nil, err
	}
	if k.Availability == computer.Disabled {
		return nil, ErrDisabled
	}
	if k.Operation.Kind == "stop" || k.Operation.Kind == "remove" {
		return nil, ErrDraining
	}
	m.backgroundMu.Lock()
	closing := m.closing
	m.backgroundMu.Unlock()
	if closing {
		return nil, errors.New("gateway is shutting down")
	}
	if k.Status != kitty.StatusRunning || m.capabilities().Kind == "boat" {
		if err := m.startComputer(ctx, k.ID); err != nil {
			return nil, err
		}
	}
	m.activityMu.Lock()
	if m.activity == nil {
		m.activity = map[string]int{}
	}
	m.activity[k.ID]++
	m.activityMu.Unlock()
	m.touch(k.ID)
	var once sync.Once
	retained = true
	return func() {
		once.Do(func() {
			m.activityMu.Lock()
			m.activity[k.ID]--
			m.lastActivity[k.ID] = m.now()
			m.activityMu.Unlock()
			admitted()
		})
	}, nil
}

func (m *Manager) active(id string) bool {
	m.activityMu.Lock()
	active := m.activity[id] > 0
	m.activityMu.Unlock()
	return active || m.Held(id)
}

func (m *Manager) drain(ctx context.Context, id string) error {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for m.active(id) {
		select {
		case <-ctx.Done():
			return fmt.Errorf("waiting for tasks or viewers to close: %w", ctx.Err())
		case <-ticker.C:
		}
	}
	return nil
}

func (m *Manager) Sleep(ctx context.Context, ref string) error {
	return m.stop(ctx, ref, computer.Sleeping)
}

// LifecycleInBackground records intent before acknowledging a potentially slow operation.
func (m *Manager) LifecycleInBackground(ref, action string) (*kitty.Kitty, error) {
	if action != "start" && action != "stop" && action != "sleep" {
		return nil, errors.New("unknown lifecycle action")
	}
	k, err := m.Get(ref)
	if err != nil {
		return nil, err
	}
	unlock, ok := m.tryLockComputer(k.ID)
	if !ok {
		return nil, ErrLifecycleBusy
	}
	defer unlock()
	return m.queueLifecycle(k.ID, action)
}

// queueLifecycle reserves intent while the caller holds the computer gate.
func (m *Manager) queueLifecycle(id, action string) (*kitty.Kitty, error) {
	admittedCtx, release, admissionErr := m.admission.Enter(context.Background())
	if admissionErr != nil {
		return nil, admissionErr
	}
	retained := false
	defer func() {
		if !retained {
			release()
		}
	}()
	m.backgroundMu.Lock()
	defer m.backgroundMu.Unlock()
	k, err := m.Get(id)
	if err != nil {
		return nil, err
	}
	if m.closing {
		return nil, errors.New("gateway is shutting down")
	}
	if k.Operation.Kind != "" && !k.ResumeAfterBackup {
		return nil, fmt.Errorf("%w: %s is %s", ErrLifecycleBusy, k.Name, k.Operation.Kind)
	}
	kind, availability := action, computer.Enabled
	if action == "stop" {
		availability = computer.Disabled
	}
	if action == "sleep" {
		kind, availability = "stop", computer.Sleeping
	}
	if err := m.beginOperationIntent(k.ID, kind, availability, action != "start"); err != nil {
		return nil, err
	}
	if !k.Desktop && action == "start" {
		if err := m.finishOperation(k.ID, kitty.StatusRunning); err != nil {
			return nil, err
		}
		return m.Get(k.ID)
	}
	if m.background == nil {
		m.background, m.cancelBackground = context.WithCancel(context.Background())
	}
	accepted, err := m.Get(k.ID)
	if err != nil {
		return nil, err
	}
	m.backgroundWG.Add(1)
	retained = true
	go func() {
		defer release()
		defer m.backgroundWG.Done()
		ctx, cancel := context.WithTimeout(admittedCtx, startTimeout)
		stopCancel := context.AfterFunc(m.background, cancel)
		defer stopCancel()
		defer cancel()
		switch action {
		case "start":
			_ = m.Start(ctx, k.ID)
		case "stop":
			_ = m.Stop(ctx, k.ID)
		case "sleep":
			_ = m.Sleep(ctx, k.ID)
		}
	}()
	return accepted, nil
}

// Close drains asynchronous lifecycle writes before the gateway releases its state lock.
func (m *Manager) Close() {
	m.backgroundMu.Lock()
	m.closing = true
	if m.cancelBackground != nil {
		m.cancelBackground()
	}
	m.backgroundMu.Unlock()
	m.invalidateAllControls()
	m.backgroundWG.Wait()
}

type ttlRuntime interface {
	Renew(context.Context, string) error
}
type recoveryRuntime interface {
	PurgeCheckpoint(context.Context, string) error
}

func (m *Manager) watchActivity(ctx context.Context, warn func(string, ...any)) {
	if m.capabilities().Kind != "boat" {
		return
	}
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		m.CheckActivity(ctx, warn)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// CheckActivity renews active machines and requests durable sleep for idle ones.
func (m *Manager) CheckActivity(ctx context.Context, warn func(string, ...any)) {
	if ctx.Err() != nil {
		return
	}
	if m.capabilities().Kind != "boat" {
		return
	}
	idle := time.Duration(m.cfg.Boat.IdleMinutes) * time.Minute
	if idle <= 0 {
		idle = 15 * time.Minute
	}
	renewEvery := time.Duration(m.cfg.Boat.RenewMinutes) * time.Minute
	if renewEvery <= 0 {
		renewEvery = 5 * time.Minute
	}
	for _, k := range m.List() {
		if !k.Desktop {
			continue
		}
		m.activityMu.Lock()
		if m.lastActivity == nil {
			m.lastActivity = map[string]time.Time{}
		}
		if m.lastRenew == nil {
			m.lastRenew = map[string]time.Time{}
		}
		if _, ok := m.lastActivity[k.ID]; !ok {
			m.lastActivity[k.ID] = m.now()
		}
		renewed := m.lastRenew[k.ID]
		m.activityMu.Unlock()
		if m.active(k.ID) {
			m.touch(k.ID)
			if r, ok := m.ctr().(ttlRuntime); ok && m.now().Sub(renewed) >= renewEvery {
				callCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
				err := r.Renew(callCtx, computerID(k))
				cancel()
				if err != nil {
					warn("TTL renewal for %s: %v", k.Name, err)
					continue
				}
				m.activityMu.Lock()
				m.lastRenew[k.ID] = m.now()
				m.activityMu.Unlock()
			}
			continue
		}
		if err := m.sleepIfIdle(k.ID, idle); err != nil {
			warn("idle sleep for %s: %v", k.Name, err)
		}
	}
}

func (m *Manager) sleepIfIdle(id string, idle time.Duration) error {
	if m.admission.Active() {
		return nil
	}
	unlock, ok := m.tryLockComputer(id)
	if !ok {
		return nil
	}
	defer unlock()
	k, err := m.Get(id)
	if err != nil {
		return err
	}
	if !k.Desktop || k.Status != kitty.StatusRunning || k.Operation.Kind != "" || k.Availability != computer.Enabled || k.ResumeAfterBackup {
		return nil
	}
	m.holdMu.Lock()
	at, held := m.holds[id]
	now := m.now()
	if held && now.Sub(at) > holdIdle {
		delete(m.holds, id)
		held = false
	}
	m.activityMu.Lock()
	last := m.lastActivity[id]
	eligible := !held && m.activity[id] == 0 && !last.IsZero() && now.Sub(last) >= idle
	m.activityMu.Unlock()
	m.holdMu.Unlock()
	if !eligible {
		return nil
	}
	_, err = m.queueLifecycle(id, "sleep")
	return err
}

type recoveryInventory interface{ Recoveries() []computer.Recovery }

func (m *Manager) Recoveries() ([]computer.Recovery, error) {
	r, ok := m.ctr().(recoveryInventory)
	if !ok {
		return []computer.Recovery{}, nil
	}
	return r.Recoveries(), nil
}

func (m *Manager) PurgeRetained(ctx context.Context, ref string) error {
	items, err := m.Recoveries()
	if err != nil {
		return err
	}
	for _, item := range items {
		if item.Name != ref {
			continue
		}
		if !item.Removed || item.Pending != "" {
			return ErrRecoveryBusy
		}
		if r, ok := m.ctr().(recoveryRuntime); ok {
			return r.PurgeCheckpoint(ctx, ref)
		}
	}
	return fmt.Errorf("%w: recovery %s", ErrNotFound, ref)
}

type activityStream struct {
	io.ReadCloser
	release func()
	once    sync.Once
}

func (s *activityStream) Close() error {
	err := s.ReadCloser.Close()
	s.once.Do(s.release)
	return err
}
func (s *activityStream) Read(p []byte) (int, error) {
	n, err := s.ReadCloser.Read(p)
	if err != nil {
		_ = s.Close()
	}
	return n, err
}
