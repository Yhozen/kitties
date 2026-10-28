package boat

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/madkoding/kitties/internal/statefs"
)

var remoteIDPattern = regexp.MustCompile(`^bx_[A-Za-z0-9_-]+$`)
var sshHostPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9.-]*$`)

type sshAccess struct {
	MachineIP string `json:"machineIp"`
	SSHUser   string `json:"sshUser"`
	Endpoint  string `json:"sshEndpoint"`
	HostKey   string `json:"hostKey"`
}

func (m *Manager) ensureKey() ([]byte, error) {
	m.sshMu.Lock()
	defer m.sshMu.Unlock()
	path := filepath.Join(m.dir, "id_ed25519")
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		m.sshPublished = false
		cmd := m.command(context.Background(), "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "kitties-boat", "-f", path)
		if err = cmd.Run(); err != nil {
			return nil, fmt.Errorf("create gateway SSH key: %w", err)
		}
	} else if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return nil, err
	}
	public, err := os.ReadFile(path + ".pub")
	if errors.Is(err, os.ErrNotExist) {
		m.sshPublished = false
		public, err = m.command(context.Background(), "ssh-keygen", "-y", "-f", path).Output()
		if err == nil {
			err = atomicWrite(path+".pub", public, 0o600)
		}
	}
	if err != nil {
		return nil, err
	}
	if !m.sshPublished {
		if err := statefs.Publish(path, path+".pub"); err != nil {
			return nil, err
		}
		m.sshPublished = true
	}
	return public, nil
}

func quote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }
func shellJoin(argv []string) string {
	quoted := make([]string, len(argv))
	for i, arg := range argv {
		quoted[i] = quote(arg)
	}
	return strings.Join(quoted, " ")
}
func guestArgs(r record, root bool, argv []string) ([]string, error) {
	if len(argv) == 0 {
		return nil, errors.New("a guest command is required")
	}
	for _, arg := range argv {
		if strings.ContainsRune(arg, 0) {
			return nil, errors.New("guest argument contains a NUL byte")
		}
	}
	if root {
		return append([]string{"sudo", "-n", "-H", "--"}, argv...), nil
	}
	args := []string{"sudo", "-n", "-H", "-u", "kitty", "--", "env", "HOME=/home/kitty", "USER=kitty", "DISPLAY=:99"}
	keys := make([]string, 0, len(r.Env))
	for key := range r.Env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		args = append(args, key+"="+r.Env[key])
	}
	args = append(args, "sh", "-c", `cd /home/kitty/work && exec "$@"`, "sh")
	return append(args, argv...), nil
}

func (m *Manager) sshCommand(ctx context.Context, r record, root bool, argv ...string) (*exec.Cmd, error) {
	if r.Removed || !remoteIDPattern.MatchString(r.RemoteID) {
		return nil, errors.New("computer has no usable remote identity")
	}
	s, err := m.get(ctx, r.RemoteID)
	if err != nil {
		return nil, err
	}
	return m.sshCommandForSandbox(ctx, r, s, root, true, argv...)
}

func (m *Manager) sshCommandForSandbox(ctx context.Context, r record, s sandbox, root, waitForAccess bool, argv ...string) (*exec.Cmd, error) {
	if err := m.checkOwner(r, s); err != nil {
		return nil, err
	}
	if !s.running() {
		return nil, errors.New("Boat computer is not running")
	}
	public, err := m.ensureKey()
	if err != nil {
		return nil, err
	}
	var access sshAccess
	for {
		err = m.json(ctx, "POST", "/sandboxes/"+url.PathEscape(r.RemoteID)+"/sshkey", map[string]string{"key": strings.TrimSpace(string(public))}, nil, &access)
		if !waitForAccess || (!isCode(err, "sandbox_restoring") && !isCode(err, "sandbox_securing")) {
			break
		}
		if err = m.delay(ctx); err != nil {
			return nil, err
		}
	}
	if err != nil {
		return nil, err
	}
	if access.SSHUser != "user" {
		return nil, errors.New("Boat returned an unexpected SSH user")
	}
	keyFields := strings.Fields(access.HostKey)
	if len(keyFields) < 2 || len(keyFields) > 3 || !strings.HasPrefix(keyFields[0], "ssh-") {
		return nil, errors.New("Boat did not return a valid SSH host key")
	}
	if _, err = base64.StdEncoding.DecodeString(keyFields[1]); err != nil {
		return nil, errors.New("Boat SSH host key is not base64")
	}
	host, port := access.MachineIP, "22"
	if access.Endpoint != "" {
		host, port, err = net.SplitHostPort(access.Endpoint)
		if err != nil {
			return nil, errors.New("Boat returned an invalid SSH endpoint")
		}
	}
	if net.ParseIP(host) == nil && !sshHostPattern.MatchString(host) {
		return nil, errors.New("Boat returned an invalid SSH host")
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return nil, errors.New("Boat returned an invalid SSH port")
	}
	hosts := filepath.Join(m.dir, r.RemoteID+".known_hosts")
	if err = atomicWrite(hosts, []byte(r.RemoteID+" "+keyFields[0]+" "+keyFields[1]+"\n"), 0o600); err != nil {
		return nil, err
	}
	command, err := guestArgs(r, root, argv)
	if err != nil {
		return nil, err
	}
	args := []string{"-F", "/dev/null", "-T", "-p", port, "-i", filepath.Join(m.dir, "id_ed25519"),
		"-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "ForwardAgent=no",
		"-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + hosts, "-o", "GlobalKnownHostsFile=/dev/null",
		"-o", "HostKeyAlias=" + r.RemoteID, "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2",
		"-o", "ControlMaster=no", "-o", "LogLevel=ERROR", "user@" + host, shellJoin(command)}
	cmd := m.command(ctx, "ssh", args...)
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + m.dir, "LANG=C.UTF-8"}
	cmd.WaitDelay = 2 * time.Second
	configureProcess(cmd)
	return cmd, nil
}

func (m *Manager) sshRun(ctx context.Context, r record, stdin string, root bool, argv ...string) ([]byte, error) {
	cmd, err := m.sshCommand(ctx, r, root, argv...)
	if err != nil {
		return nil, err
	}
	cmd.Stdin = strings.NewReader(stdin)
	var stdout bytes.Buffer
	stderr := &boundedBuffer{limit: 32 << 10}
	cmd.Stdout = &stdout
	cmd.Stderr = stderr
	if err = cmd.Run(); err != nil {
		return stdout.Bytes(), fmt.Errorf("Boat guest command: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return stdout.Bytes(), nil
}

type boundedBuffer struct {
	buffer bytes.Buffer
	limit  int
}

func (b *boundedBuffer) String() string { return b.buffer.String() }

func (b *boundedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if b.buffer.Len() < b.limit {
		keep := min(len(p), b.limit-b.buffer.Len())
		_, _ = b.buffer.Write(p[:keep])
	}
	return n, nil
}

func (m *Manager) Exec(ctx context.Context, ref string, argv ...string) (string, error) {
	return m.ExecInput(ctx, ref, "", argv...)
}
func (m *Manager) ExecInput(ctx context.Context, ref, stdin string, argv ...string) (string, error) {
	r, err := m.lookup(ref)
	if err != nil {
		return "", err
	}
	out, err := m.runGuest(ctx, r, stdin, false, argv...)
	return string(out), err
}
func (m *Manager) Screenshot(ctx context.Context, ref string) ([]byte, error) {
	r, err := m.lookup(ref)
	if err != nil {
		return nil, err
	}
	return m.runGuest(ctx, r, "", false, "kitty-shot")
}

func (m *Manager) Stream(ctx context.Context, ref string, fps, quality int) (io.ReadCloser, error) {
	if fps < 1 || fps > 30 || quality < 1 || quality > 100 {
		return nil, errors.New("desktop stream needs fps 1–30 and quality 1–100")
	}
	r, err := m.lookup(ref)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	cmd, err := m.sshCommand(ctx, r, false, "kitty-stream", "--stdin", strconv.Itoa(fps), strconv.Itoa(quality))
	if err != nil {
		cancel()
		return nil, err
	}
	input, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		input.Close()
		return nil, err
	}
	cmd.Stderr = io.Discard
	if err = cmd.Start(); err != nil {
		cancel()
		input.Close()
		output.Close()
		return nil, err
	}
	stream := &displayStream{ReadCloser: output, input: input, cancel: cancel, done: make(chan struct{})}
	go func() { _ = cmd.Wait(); close(stream.done) }()
	return stream, nil
}

type displayStream struct {
	io.ReadCloser
	input  io.Closer
	cancel context.CancelFunc
	done   chan struct{}
	once   sync.Once
}

func (s *displayStream) Close() error {
	s.once.Do(func() {
		_ = s.input.Close()
		_ = s.ReadCloser.Close()
		select {
		case <-s.done:
		case <-time.After(time.Second):
			s.cancel()
			<-s.done
		}
		s.cancel()
	})
	return nil
}
