package container

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
)

// THE DISPLAY, LIVE.
//
// `kitty-stream` in the image (it runs kitty-grab, the XShm capture, when there is one) writes the display as JPEG pictures, each after a line
// "FRAME <bytes>", and only when it changed; "PING" lines keep a quiet stream alive. It runs
// under `docker exec -i` with --stdin: closing its input ends it, the one signal that reaches it
// when the reader goes (docker would go on reading its output for good).

// MaxFrame is the largest picture a stream may carry.
const MaxFrame = 8 << 20

// startStream runs a command with an input that the returned closer closes; a test replaces it.
var startStream = func(ctx context.Context, bin string, args ...string) (io.ReadCloser, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &stream{ReadCloser: out, in: in, cmd: cmd}, nil
}

type stream struct {
	io.ReadCloser
	in  io.Closer
	cmd *exec.Cmd
}

// Close ends the stream in the container (its input closes) and waits for docker to go.
func (s *stream) Close() error {
	_ = s.in.Close()
	_ = s.ReadCloser.Close()
	_ = s.cmd.Wait()
	return nil
}

// Stream follows the kitty's display: read its pictures with ReadFrame, and close it to stop.
func (m *Manager) Stream(ctx context.Context, name string, fps, quality int) (io.ReadCloser, error) {
	if !validReference(name) {
		return nil, fmt.Errorf("container name %q is not valid", name)
	}
	return startStream(ctx, m.rt.Bin, "exec", "-i", name, "kitty-stream", "--stdin", strconv.Itoa(fps), strconv.Itoa(quality))
}

// ReadFrame reads the next picture of a stream, past its PING lines.
func ReadFrame(r *bufio.Reader) ([]byte, error) {
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimSpace(line)
		if line == "PING" || line == "" {
			continue
		}
		size, ok := strings.CutPrefix(line, "FRAME ")
		if !ok {
			return nil, fmt.Errorf("not a frame: %.40q", line)
		}
		n, err := strconv.Atoi(size)
		if err != nil || n <= 0 || n > MaxFrame {
			return nil, errors.New("a frame of a size out of bounds")
		}
		frame := make([]byte, n)
		if _, err := io.ReadFull(r, frame); err != nil {
			return nil, err
		}
		return frame, nil
	}
}

// WriteFrame writes a picture the way kitty-stream does (the demo draws its own).
func WriteFrame(w io.Writer, frame []byte) error {
	if _, err := fmt.Fprintf(w, "FRAME %d\n", len(frame)); err != nil {
		return err
	}
	_, err := w.Write(frame)
	return err
}
