package lima

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/madkoding/kitties/internal/container"
)

// TestLiveVMDesktopTransport checks the real SSH/desktop boundary on an already
// provisioned VM. Close other desktop viewers before running it. It neither
// creates nor stops a VM and leaves its workspace untouched.
func TestLiveVMDesktopTransport(t *testing.T) {
	home := os.Getenv("KITTIES_LIMA_LIVE_HOME")
	if home == "" {
		t.Skip("set KITTIES_LIMA_LIVE_HOME to test an existing Kitties Lima VM")
	}
	name := os.Getenv("KITTIES_LIMA_LIVE_NAME")
	if name == "" {
		name = "kitty-mimi"
	}
	m := New(home)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if _, err := m.owned(name); err != nil {
		t.Fatal(err)
	}
	if captures := liveCaptureProcesses(t, ctx, m, name); captures != "" {
		t.Fatalf("close other desktop viewers before this test; capture processes: %s", captures)
	}

	t.Run("literal arguments and stdin arrive as kitty", func(t *testing.T) {
		arguments := []string{"two words", "single'quote", `double"quote`, "$(printf injected)", "`printf injected`", "semi; pipe| amp&", "new\nline", "", "猫"}
		input := "private test input\nsecond line\x00tail"
		argv := append([]string{"python3", "-c", `import json, os, pwd, sys
print(json.dumps({"args": sys.argv[1:], "input": sys.stdin.read(), "home": os.environ["HOME"], "cwd": os.getcwd(), "user": pwd.getpwuid(os.getuid()).pw_name}))`}, arguments...)
		out, err := m.ExecInput(ctx, name, input, argv...)
		if err != nil {
			t.Fatalf("guest execution: %v; output: %s", err, out)
		}
		var result struct {
			Args                   []string
			Input, Home, Cwd, User string
		}
		if err := json.Unmarshal([]byte(out), &result); err != nil {
			t.Fatalf("guest output is not JSON: %v: %q", err, out)
		}
		if !slices.Equal(result.Args, arguments) || result.Input != input {
			t.Fatalf("argument/stdin boundary changed content: %+v", result)
		}
		if result.Home != "/home/kitty" || result.Cwd != container.Workdir || result.User != "kitty" {
			t.Fatalf("guest identity or private workspace is wrong: %+v", result)
		}
		out, err = m.Exec(ctx, name, "python3", "-c", `import sys; print("stdout marker"); sys.stderr.write("stderr marker\n")`)
		if err != nil || !strings.Contains(out, "stdout marker") || !strings.Contains(out, "stderr marker") {
			t.Fatalf("text diagnostics lost: output %q, error %v", out, err)
		}
	})

	t.Run("screenshot is a complete PNG", func(t *testing.T) {
		data, err := m.Screenshot(ctx, name)
		if err != nil {
			t.Fatal(err)
		}
		picture, err := png.Decode(bytes.NewReader(data))
		if err != nil {
			t.Fatalf("decode screenshot: %v", err)
		}
		if bounds := picture.Bounds(); bounds.Dx() != 1280 || bounds.Dy() != 800 {
			t.Fatalf("unexpected desktop dimensions: %v", bounds)
		}
	})

	t.Run("closing a JPEG stream stops capture", func(t *testing.T) {
		stream, err := m.Stream(ctx, name, 8, 70)
		if err != nil {
			t.Fatal(err)
		}
		defer stream.Close()
		frame, err := container.ReadFrame(bufio.NewReader(stream))
		if err != nil {
			t.Fatal(err)
		}
		picture, err := jpeg.Decode(bytes.NewReader(frame))
		if err != nil {
			t.Fatalf("decode streamed JPEG: %v", err)
		}
		if bounds := picture.Bounds(); bounds.Dx() != 1280 || bounds.Dy() != 800 {
			t.Fatalf("unexpected stream dimensions: %v", bounds)
		}
		if err := stream.Close(); err != nil {
			t.Fatal(err)
		}
		waitForNoLiveCapture(t, ctx, m, name)
	})

	t.Run("context cancellation closes transport and capture", func(t *testing.T) {
		streamCtx, stop := context.WithCancel(ctx)
		defer stop()
		stream, err := m.Stream(streamCtx, name, 8, 70)
		if err != nil {
			t.Fatal(err)
		}
		defer stream.Close()
		reader := bufio.NewReader(stream)
		if _, err := container.ReadFrame(reader); err != nil {
			t.Fatal(err)
		}
		stop()
		done := make(chan error, 1)
		go func() {
			_, err := io.Copy(io.Discard, reader)
			done <- err
		}()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("cancelled stream kept its transport open")
		}
		if err := stream.Close(); err != nil {
			t.Fatal(err)
		}
		waitForNoLiveCapture(t, ctx, m, name)
	})
}

func liveCaptureProcesses(t *testing.T, ctx context.Context, m *Manager, name string) string {
	t.Helper()
	out, err := m.Exec(ctx, name, "sh", "-c", `ps -u kitty -o pid=,stat=,comm= | awk '$3 == "kitty-grab" && $2 !~ /^Z/ {print $1}'`)
	if err != nil {
		t.Fatalf("inspect guest capture processes: %v; output: %s", err, out)
	}
	return strings.TrimSpace(out)
}

func waitForNoLiveCapture(t *testing.T, ctx context.Context, m *Manager, name string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		captures := liveCaptureProcesses(t, ctx, m, name)
		if captures == "" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("capture processes remain after closing transport: %s", captures)
		}
		time.Sleep(100 * time.Millisecond)
	}
}
