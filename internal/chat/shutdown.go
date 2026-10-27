package chat

import (
	"context"
	"errors"
)

var ErrShuttingDown = errors.New("the gateway is shutting down")

func (s *Service) beginTurn(ctx context.Context) (context.Context, func(), error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopping {
		return nil, nil, ErrShuttingDown
	}
	s.turnWG.Add(1)
	ctx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(s.shutdownCtx, cancel)
	return ctx, func() { stop(); cancel(); s.turnWG.Done() }, nil
}

// Shutdown rejects new turns, cancels work, and waits until no chat task can
// write state. It must finish before releasing the gateway's data-directory lock.
func (s *Service) Shutdown() {
	s.mu.Lock()
	s.stopping = true
	if s.cancelShutdown != nil {
		s.cancelShutdown()
	}
	for _, task := range s.tasks {
		task.cancel()
	}
	s.mu.Unlock()
	s.turnWG.Wait()
	// A model response can have handed work to a desktop task while the initial
	// turns were draining. No further task can be added after turnWG reaches zero.
	s.mu.Lock()
	for _, task := range s.tasks {
		task.cancel()
	}
	s.mu.Unlock()
	s.wg.Wait()
}
