package orchestrator

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/madkoding/kitties/internal/computer"
	"github.com/madkoding/kitties/internal/desktop"
	"github.com/madkoding/kitties/internal/kitty"
)

var ErrControlExpired = errors.New("take control again before sending input")

// ControlState identifies one grant of the human controls.
type ControlState struct {
	Held bool   `json:"held"`
	ID   string `json:"control_id,omitempty"`
}

type controlGrant struct {
	ControlState
	Computer computer.Reference
	revoked  bool
	inFlight int
}

// interactiveWork admits a fresh request and joins shutdown before any dispatch.
func (m *Manager) interactiveWork(ctx context.Context) (context.Context, func(), error) {
	ctx, leave, err := m.admission.Enter(ctx)
	if err != nil {
		return ctx, nil, err
	}
	m.backgroundMu.Lock()
	defer m.backgroundMu.Unlock()
	if m.closing {
		leave()
		return ctx, nil, errors.New("gateway is shutting down")
	}
	if m.background == nil {
		m.background, m.cancelBackground = context.WithCancel(context.Background())
	}
	ctx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(m.background, cancel)
	m.backgroundWG.Add(1)
	return ctx, func() { stop(); cancel(); leave(); m.backgroundWG.Done() }, nil
}

func (m *Manager) invalidateControl(id string, revoke bool) {
	m.holdMu.Lock()
	defer m.holdMu.Unlock()
	delete(m.prepared, id)
	if grant := m.controls[id]; grant != nil && revoke {
		grant.revoked = true
		if grant.inFlight == 0 {
			delete(m.holds, id)
		}
	}
}

func (m *Manager) invalidateAllControls() {
	m.holdMu.Lock()
	defer m.holdMu.Unlock()
	m.invalidateControlsLocked()
}

func (m *Manager) invalidateControlsLocked() {
	m.controlEpoch++
	clear(m.prepared)
	for id, grant := range m.controls {
		grant.revoked = true
		if grant.inFlight == 0 {
			delete(m.holds, id)
		}
	}
}

// Control grants a fresh receipt or releases only the named grant.
func (m *Manager) Control(ctx context.Context, ref string, on bool, controlID string) (ControlState, error) {
	k, err := m.Get(ref)
	if err != nil {
		return ControlState{}, err
	}
	if !on {
		if controlID == "" {
			return ControlState{}, ErrControlExpired
		}
		m.holdMu.Lock()
		defer m.holdMu.Unlock()
		if grant := m.controls[k.ID]; grant != nil && grant.ID == controlID {
			grant.revoked = true
			if grant.inFlight == 0 {
				delete(m.holds, k.ID)
			}
		}
		return ControlState{}, nil
	}
	if !k.Desktop {
		return ControlState{}, fmt.Errorf("%s has no desktop", k.Name)
	}
	m.holdMu.Lock()
	epoch, frozen := m.controlEpoch, m.controlFrozen
	m.holdMu.Unlock()
	if frozen {
		return ControlState{}, ErrControlExpired
	}
	ctx, done, err := m.interactiveWork(ctx)
	if err != nil {
		return ControlState{}, err
	}
	defer done()
	unlock, err := m.lockComputer(ctx, k.ID)
	if err != nil {
		return ControlState{}, err
	}
	defer unlock()
	k, err = m.Get(k.ID)
	if err != nil {
		return ControlState{}, err
	}
	if k.Availability == computer.Disabled {
		return ControlState{}, ErrDisabled
	}
	if k.Operation.Kind != "" && k.Operation.Kind != "start" {
		return ControlState{}, ErrDraining
	}
	m.holdMu.Lock()
	prepared, ok := m.prepared[k.ID]
	m.holdMu.Unlock()
	if !ok || prepared != k.Computer || k.Status != kitty.StatusRunning || k.Operation.Kind != "" {
		if err := m.startComputer(ctx, k.ID); err != nil {
			return ControlState{}, err
		}
		k, err = m.Get(k.ID)
		if err != nil {
			return ControlState{}, err
		}
	}
	if err := ctx.Err(); err != nil {
		return ControlState{}, err
	}
	m.backgroundMu.Lock()
	defer m.backgroundMu.Unlock()
	if m.closing {
		return ControlState{}, errors.New("gateway is shutting down")
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return ControlState{}, err
	}
	m.holdMu.Lock()
	defer m.holdMu.Unlock()
	if epoch != m.controlEpoch || m.controlFrozen {
		return ControlState{}, ErrControlExpired
	}
	if m.controls == nil {
		m.controls = map[string]*controlGrant{}
	}
	if m.holds == nil {
		m.holds = map[string]time.Time{}
		m.holdStarted = map[string]time.Time{}
	}
	grant := &controlGrant{ControlState: ControlState{Held: true, ID: hex.EncodeToString(nonce[:])}, Computer: k.Computer}
	m.controls[k.ID] = grant
	m.holds[k.ID], m.holdStarted[k.ID] = m.now(), m.now()
	return grant.ControlState, nil
}

// Input dispatches one action for the exact control grant. A failure never retries it.
func (m *Manager) Input(ctx context.Context, ref, controlID string, a desktop.Action) (err error) {
	argv, err := desktop.Person(a)
	if err != nil {
		return err
	}
	k, err := m.Get(ref)
	if err != nil {
		return err
	}
	if controlID == "" {
		return ErrControlExpired
	}
	ctx, done, err := m.interactiveWork(ctx)
	if err != nil {
		return err
	}
	defer done()
	unlock, err := m.lockComputer(ctx, k.ID)
	if err != nil {
		return err
	}
	defer unlock()
	k, err = m.Get(k.ID)
	if err != nil {
		return err
	}
	if k.Availability == computer.Disabled {
		return ErrDisabled
	}
	if k.Operation.Kind != "" {
		return ErrDraining
	}
	m.holdMu.Lock()
	grant := m.controls[k.ID]
	prepared, ready := m.prepared[k.ID]
	if grant == nil || grant.ID != controlID || grant.revoked || m.now().Sub(m.holds[k.ID]) > holdIdle || grant.Computer != k.Computer || !ready || prepared != k.Computer || k.Status != kitty.StatusRunning {
		m.holdMu.Unlock()
		return ErrControlExpired
	}
	grant.inFlight++
	m.holds[k.ID] = m.now()
	m.holdMu.Unlock()
	m.activityMu.Lock()
	if m.activity == nil {
		m.activity = map[string]int{}
	}
	m.activity[k.ID]++
	m.activityMu.Unlock()
	m.touch(k.ID)
	defer func() {
		m.holdMu.Lock()
		grant.inFlight--
		if err != nil {
			grant.revoked = true
			delete(m.prepared, k.ID)
		}
		if grant.revoked && m.controls[k.ID] == grant {
			delete(m.holds, k.ID)
		}
		m.holdMu.Unlock()
		m.activityMu.Lock()
		m.activity[k.ID]--
		m.lastActivity[k.ID] = m.now()
		m.activityMu.Unlock()
	}()
	input := ""
	if a.Name == "type" {
		input = fmt.Sprint(a.Args["text"])
		argv = desktop.TypeFromInput
	}
	if runtime, ok := m.ctr().(computer.PreparedInput); ok {
		_, err = runtime.ExecPreparedInput(ctx, k.Computer, input, argv...)
	} else if m.capabilities().Kind == "boat" {
		err = errors.New("runtime cannot validate prepared input")
	} else if a.Name == "type" {
		_, err = m.ctr().ExecInput(ctx, computerID(k), input, argv...)
	} else {
		_, err = m.ctr().Exec(ctx, computerID(k), argv...)
	}
	return err
}
