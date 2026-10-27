package boat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func sshBoundary(t *testing.T, access sshAccess, register func(http.ResponseWriter, *http.Request) bool) (*Manager, record) {
	t.Helper()
	r := record{Name: "kitty-mimi", KittyName: "mimi", RemoteID: "bx_owned", Generation: 1}
	var m *Manager
	m = apiBoundary(t, func(w http.ResponseWriter, request *http.Request) {
		if strings.HasSuffix(request.URL.Path, "/sshkey") {
			if register != nil && register(w, request) {
				return
			}
			_ = json.NewEncoder(w).Encode(access)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"sandbox": sandbox{ID: r.RemoteID, Access: "owner", State: "ready", Hydrated: true, Labels: map[string]string{ownerLabel: m.ownerID, kittyLabel: r.Name, generationLabel: "1"}}})
	})
	if err := m.put(r); err != nil {
		t.Fatal(err)
	}
	fakeKey(t, m)
	return m, r
}
func validAccess() sshAccess {
	return sshAccess{SSHUser: "user", MachineIP: "127.0.0.1", HostKey: "ssh-ed25519 YWJj"}
}

func TestUntrustedSSHMetadataCannotLaunchACommand(t *testing.T) {
	for _, variant := range []string{"user", "missing-key", "invalid-key", "host", "endpoint", "port", "port-range"} {
		t.Run(variant, func(t *testing.T) {
			access := validAccess()
			switch variant {
			case "user":
				access.SSHUser = "root"
			case "missing-key":
				access.HostKey = ""
			case "invalid-key":
				access.HostKey = "ssh-ed25519 !bad!"
			case "host":
				access.MachineIP = "-oProxyCommand=touch"
			case "endpoint":
				access.Endpoint = "host:22:extra"
			case "port":
				access.Endpoint = "host:wrong"
			case "port-range":
				access.Endpoint = "host:65536"
			}
			m, r := sshBoundary(t, access, nil)
			called := false
			m.command = func(ctx context.Context, name string, args ...string) *exec.Cmd {
				called = true
				return exec.CommandContext(ctx, "false")
			}
			if _, err := m.sshCommand(context.Background(), r, false, "true"); err == nil || called {
				t.Fatalf("invalid SSH metadata crossed process boundary: %v", err)
			}
			if _, err := os.Stat(filepath.Join(m.dir, r.RemoteID+".known_hosts")); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("invalid key was persisted: %v", err)
			}
		})
	}
}

func TestSSHRegistrationRetriesRestoringButNeverIgnoresAuthenticationFailure(t *testing.T) {
	var attempts atomic.Int32
	m, r := sshBoundary(t, validAccess(), func(w http.ResponseWriter, req *http.Request) bool {
		if attempts.Add(1) < 3 {
			w.WriteHeader(409)
			_ = json.NewEncoder(w).Encode(map[string]string{"code": "sandbox_restoring"})
			return true
		}
		return false
	})
	if _, err := m.sshCommand(context.Background(), r, false, "true"); err != nil || attempts.Load() != 3 {
		t.Fatalf("SSH readiness failed: %d %v", attempts.Load(), err)
	}
	m2, r2 := sshBoundary(t, validAccess(), func(w http.ResponseWriter, req *http.Request) bool { w.WriteHeader(401); return true })
	if _, err := m2.sshCommand(context.Background(), r2, false, "true"); !isStatus(err, 401) {
		t.Fatalf("SSH registration authorization ignored: %v", err)
	}
}

func TestSSHKeyCanBeRecoveredWithoutChangingPrivateIdentity(t *testing.T) {
	if _, err := exec.LookPath("ssh-keygen"); err != nil {
		t.Skip("ssh-keygen unavailable")
	}
	m := apiBoundary(t, func(http.ResponseWriter, *http.Request) { t.Error("key generation should not contact provider") })
	public, err := m.ensureKey()
	if err != nil {
		t.Fatal(err)
	}
	private, err := os.ReadFile(filepath.Join(m.dir, "id_ed25519"))
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(filepath.Join(m.dir, "id_ed25519.pub")); err != nil {
		t.Fatal(err)
	}
	recovered, err := m.ensureKey()
	if err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(filepath.Join(m.dir, "id_ed25519"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(private, after) || strings.Join(strings.Fields(string(public))[:2], " ") != strings.Join(strings.Fields(string(recovered))[:2], " ") {
		t.Fatal("public key repair rotated private identity")
	}
}

func TestGuestFailurePreservesStdoutAndBoundedDiagnostic(t *testing.T) {
	m, r := sshBoundary(t, validAccess(), nil)
	m.runGuest = m.sshRun
	m.command = func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
		return exec.CommandContext(ctx, "sh", "-c", `printf 'partial result'; printf 'guest failed' >&2; exit 7`)
	}
	output, err := m.Exec(context.Background(), r.Name, "anything")
	if output != "partial result" || err == nil || !strings.Contains(err.Error(), "guest failed") {
		t.Fatalf("command failure lost output: %q %v", output, err)
	}
	if _, err = m.Exec(context.Background(), "kitty-unknown", "true"); err == nil {
		t.Fatal("unknown computer executed")
	}
	if _, err = m.Screenshot(context.Background(), "kitty-unknown"); err == nil {
		t.Fatal("unknown computer screenshot succeeded")
	}
}

func TestGuestArgumentsAndUnavailableIdentityFailBeforeSSH(t *testing.T) {
	m, r := sshBoundary(t, validAccess(), nil)
	for _, args := range [][]string{nil, {"bad\x00argument"}} {
		if _, err := m.sshCommand(context.Background(), r, false, args...); err == nil {
			t.Fatal("invalid guest argv accepted")
		}
	}
	r.Removed = true
	if _, err := m.sshCommand(context.Background(), r, false, "true"); err == nil {
		t.Fatal("removed computer connected")
	}
	r.Removed = false
	r.RemoteID = "-unsafe"
	if _, err := m.sshCommand(context.Background(), r, false, "true"); err == nil {
		t.Fatal("unsafe remote ID connected")
	}
}

func TestViewerFailureAndUncooperativeProcessAreReaped(t *testing.T) {
	m, r := sshBoundary(t, validAccess(), nil)
	for _, input := range []struct {
		ref          string
		fps, quality int
	}{{r.Name, 0, 70}, {"unknown", 8, 70}} {
		if stream, err := m.Stream(context.Background(), input.ref, input.fps, input.quality); err == nil || stream != nil {
			t.Fatal("invalid viewer was acknowledged")
		}
	}
	m.command = func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
		return exec.CommandContext(ctx, filepath.Join(m.dir, "missing-ssh"))
	}
	if _, err := m.Stream(context.Background(), r.Name, 8, 70); err == nil {
		t.Fatal("missing SSH launched viewer")
	}
	var child *exec.Cmd
	m.command = func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
		child = exec.CommandContext(ctx, "sh", "-c", `printf 'ready'; exec sleep 60`)
		return child
	}
	stream, err := m.Stream(context.Background(), r.Name, 8, 70)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = io.ReadFull(stream, make([]byte, 5)); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { _ = stream.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("hung SSH child survived viewer close")
	}
	if child.ProcessState == nil {
		t.Fatal("SSH child was not reaped")
	}
	if err = child.Cancel(); !errors.Is(err, os.ErrProcessDone) {
		t.Fatalf("cancel after exit: %v", err)
	}
}
