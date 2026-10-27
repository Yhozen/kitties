// Package maintenance drains admitted work without cancelling it before a consistent capture.
package maintenance

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
)

var ErrBusy = errors.New("gateway is preparing a recovery backup; try again shortly")

type lease struct {
	active     atomic.Bool
	privileged bool
}

type Gate struct {
	mu      sync.Mutex
	count   int
	blocked bool
	frozen  bool
	changed chan struct{}
}

func (g *Gate) signal() {
	if g.changed != nil {
		close(g.changed)
	}
	g.changed = make(chan struct{})
}
func (g *Gate) Enter(ctx context.Context) (context.Context, func(), error) {
	if err := ctx.Err(); err != nil {
		return ctx, nil, err
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	parent, _ := ctx.Value(g).(*lease)
	if (g.blocked || g.frozen) && (parent == nil || !parent.active.Load()) {
		return ctx, nil, ErrBusy
	}
	if parent != nil && parent.privileged && parent.active.Load() {
		return ctx, func() {}, nil
	}
	g.count++
	g.signal()
	permit := &lease{}
	permit.active.Store(true)
	var once sync.Once
	return context.WithValue(ctx, g, permit), func() {
		once.Do(func() {
			g.mu.Lock()
			defer g.mu.Unlock()
			permit.active.Store(false)
			g.count--
			g.signal()
		})
	}, nil
}
func (g *Gate) Active() bool { g.mu.Lock(); defer g.mu.Unlock(); return g.blocked || g.frozen }
func (g *Gate) Busy() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.count > 0 || g.blocked || g.frozen
}
func (g *Gate) Begin(ctx context.Context) (context.Context, func(), error) {
	return g.begin(ctx, false)
}
func (g *Gate) TryBegin(ctx context.Context) (context.Context, func(), error) {
	return g.begin(ctx, true)
}
func (g *Gate) begin(ctx context.Context, onlyIdle bool) (context.Context, func(), error) {
	if err := ctx.Err(); err != nil {
		return ctx, nil, err
	}
	g.mu.Lock()
	if g.blocked || g.frozen || onlyIdle && g.count > 0 {
		g.mu.Unlock()
		return ctx, nil, ErrBusy
	}
	g.blocked = true
	g.signal()
	for g.count > 0 {
		changed := g.changed
		g.mu.Unlock()
		select {
		case <-ctx.Done():
			g.mu.Lock()
			g.blocked = false
			g.signal()
			g.mu.Unlock()
			return ctx, nil, ctx.Err()
		case <-changed:
		}
		g.mu.Lock()
	}
	g.mu.Unlock()
	permit := &lease{privileged: true}
	permit.active.Store(true)
	var once sync.Once
	return context.WithValue(ctx, g, permit), func() {
		once.Do(func() {
			g.mu.Lock()
			defer g.mu.Unlock()
			permit.active.Store(false)
			g.blocked = false
			g.signal()
		})
	}, nil
}

func (g *Gate) Owns(ctx context.Context) bool {
	permit, _ := ctx.Value(g).(*lease)
	return permit != nil && permit.privileged && permit.active.Load()
}

// Freeze closes new admission until Thaw, even if draining is interrupted.
// Existing admitted work and a temporary maintenance owner may finish normally.
func (g *Gate) Freeze(ctx context.Context) error {
	g.mu.Lock()
	g.frozen = true
	g.signal()
	for g.count > 0 || g.blocked {
		changed := g.changed
		g.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-changed:
		}
		g.mu.Lock()
	}
	g.mu.Unlock()
	return ctx.Err()
}

func (g *Gate) Thaw() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.frozen = false
	g.signal()
}
