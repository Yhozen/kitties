package boat

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func fakeKey(t *testing.T, m *Manager) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(m.dir, "id_ed25519"), []byte("private fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(m.dir, "id_ed25519.pub"), []byte("ssh-ed25519 YWJj"), 0o600); err != nil {
		t.Fatal(err)
	}
}
func TestSSHArgumentsPinKeyAndDoNotForwardHostCredentials(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	id := createKitty(t, m)
	fakeKey(t, m)
	r, _ := m.lookup(id)
	cmd, err := m.sshCommand(context.Background(), r, false, "printf", "%s", "a'b\n$(touch /tmp/not-executed)")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(cmd.Args, " ")
	for _, want := range []string{"StrictHostKeyChecking=yes", "IdentityAgent=none", "ForwardAgent=no", "IdentitiesOnly=yes", "HostKeyAlias=" + id, "-F /dev/null", "sudo' '-n' '-H' '-u' 'kitty"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %s", want)
		}
	}
	for _, entry := range cmd.Env {
		if strings.Contains(entry, "API_KEY") || strings.Contains(entry, "SSH_AUTH_SOCK") {
			t.Fatal("forwarded gateway credentials")
		}
	}
	pinned, err := os.ReadFile(filepath.Join(m.dir, id+".known_hosts"))
	if err != nil || string(pinned) != id+" ssh-ed25519 YWJj\n" {
		t.Fatalf("host key not pinned: %q %v", pinned, err)
	}
	root, err := guestArgs(r, true, []string{"bash", "-s"})
	if err != nil || !reflect.DeepEqual(root, []string{"sudo", "-n", "-H", "--", "bash", "-s"}) {
		t.Fatal("bootstrap does not use explicit root path")
	}
	// Exercise the shell quoting itself rather than compare a shell-looking string.
	payload := []string{"printf", "%s", "a'b\n$(touch /tmp/not-executed)"}
	out, err := exec.Command("sh", "-c", shellJoin(payload)).Output()
	if err != nil || string(out) != payload[2] {
		t.Fatalf("argv changed: %q %v", out, err)
	}
}
func TestSSHSeparatesBinaryOutputFromDiagnosticsAndCarriesStdin(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	id := createKitty(t, m)
	fakeKey(t, m)
	m.runGuest = m.sshRun
	var args []string
	m.command = func(ctx context.Context, bin string, argv ...string) *exec.Cmd {
		if bin != "ssh" {
			t.Fatalf("unexpected command %s", bin)
		}
		args = argv
		return exec.CommandContext(ctx, "sh", "-c", `printf 'diagnostic' >&2; cat`)
	}
	data := string([]byte{137, 80, 78, 71, 0, 255, 10})
	out, err := m.ExecInput(context.Background(), id, data, "cat")
	if err != nil || out != data {
		t.Fatalf("corrupted binary/stdin: %q %v", out, err)
	}
	if strings.Contains(strings.Join(args, " "), data) {
		t.Fatal("stdin leaked into argv")
	}
}
func TestStreamCloseAndCancellationReapSSH(t *testing.T) {
	for _, cancelContext := range []bool{false, true} {
		t.Run(map[bool]string{false: "close", true: "context"}[cancelContext], func(t *testing.T) {
			f := fixture()
			m, _ := testManager(t, f)
			id := createKitty(t, m)
			fakeKey(t, m)
			var child *exec.Cmd
			var args []string
			m.command = func(ctx context.Context, bin string, argv ...string) *exec.Cmd {
				args = argv
				child = exec.CommandContext(ctx, "sh", "-c", `printf 'FRAME 3\nabc'; cat >/dev/null`)
				return child
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			stream, err := m.Stream(ctx, id, 8, 70)
			if err != nil {
				t.Fatal(err)
			}
			data := make([]byte, len("FRAME 3\nabc"))
			if _, err = io.ReadFull(stream, data); err != nil || !bytes.Equal(data, []byte("FRAME 3\nabc")) {
				t.Fatalf("bad frame %q %v", data, err)
			}
			if !strings.Contains(strings.Join(args, " "), "'kitty-stream' '--stdin'") {
				t.Fatal("capture has no disconnect guard")
			}
			if cancelContext {
				cancel()
			}
			done := make(chan struct{})
			go func() { stream.Close(); close(done) }()
			select {
			case <-done:
			case <-time.After(4 * time.Second):
				t.Fatal("SSH process was not reaped")
			}
			if child.ProcessState == nil || !child.ProcessState.Exited() && child.ProcessState.String() == "" {
				t.Fatal("SSH wait did not finish")
			}
		})
	}
}

func TestGuestDiagnosticsRemainBoundedThroughIOCopy(t *testing.T) {
	b := &boundedBuffer{limit: 64}
	input := strings.Repeat("diagnostic", 10000)
	n, err := io.Copy(b, strings.NewReader(input))
	if err != nil || n != int64(len(input)) || len(b.String()) != 64 {
		t.Fatalf("unbounded diagnostics: %d bytes retained, %d consumed, %v", len(b.String()), n, err)
	}
}
