package lima

import (
	"context"
	"io"
	"os/exec"
	"sync"
	"time"
)

// Stream carries the same framed JPEG protocol as the container desktop.
func (m *Manager) Stream(ctx context.Context, name string, fps, quality int) (io.ReadCloser, error) {
	argv, err := streamArguments(fps, quality)
	if err != nil {
		return nil, err
	}
	args, err := m.shellArgs(name, argv...)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	cmd, err := m.cmd(ctx, args...)
	if err != nil {
		cancel()
		return nil, err
	}
	in, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		_ = in.Close()
		return nil, err
	}
	// Diagnostics must not corrupt the binary frame stream.
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		cancel()
		_ = in.Close()
		_ = out.Close()
		return nil, err
	}
	return &displayStream{ReadCloser: out, input: in, command: cmd, cancel: cancel}, nil
}

type displayStream struct {
	io.ReadCloser
	input   io.Closer
	command *exec.Cmd
	cancel  context.CancelFunc
	once    sync.Once
}

func (s *displayStream) Close() error {
	s.once.Do(func() {
		_ = s.input.Close()
		_ = s.ReadCloser.Close()
		done := make(chan struct{})
		go func() { _ = s.command.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(time.Second):
			s.cancel()
			<-done
		}
		s.cancel()
	})
	return nil
}
