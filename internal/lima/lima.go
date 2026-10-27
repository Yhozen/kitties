// Package lima runs each kitty's desktop in its own persistent Linux virtual machine.
package lima

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/madkoding/kitties/internal/computer"
	"github.com/madkoding/kitties/internal/container"
)

var instanceName = regexp.MustCompile(`^kitty-[a-z0-9][a-z0-9-]{0,56}$`)

// Manager keeps its instances in a dedicated LIMA_HOME, separate from personal Lima VMs.
type Manager struct {
	home    string
	command func(context.Context, string, ...string) *exec.Cmd
}

// New uses home as the dedicated Lima state directory.
func New(home string) *Manager { return &Manager{home: home, command: exec.CommandContext} }

func (m *Manager) Capabilities() computer.Capabilities {
	return computer.Capabilities{Kind: "lima", PersistentDisk: true, GuestWorkspace: true}
}

func limaBinary() (string, error) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		return "", errors.New("the Lima desktop backend supports macOS and Linux")
	}
	if bin, err := exec.LookPath("limactl"); err == nil {
		return bin, nil
	}
	for _, bin := range []string{"/opt/homebrew/bin/limactl", "/usr/local/bin/limactl"} {
		if info, err := os.Stat(bin); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0 {
			return bin, nil
		}
	}
	return "", errors.New("Lima is not installed: install Lima 2 or later and make limactl available")
}

// Detect checks that the external Lima CLI is installed and can run.
func Detect(ctx context.Context) error {
	bin, err := limaBinary()
	if err != nil {
		return err
	}
	if out, err := exec.CommandContext(ctx, bin, "--version").CombinedOutput(); err != nil {
		return fmt.Errorf("Lima does not answer: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (m *Manager) prepare() error {
	if !filepath.IsAbs(m.home) || filepath.Clean(m.home) == string(filepath.Separator) {
		return errors.New("Lima home must be an absolute, dedicated state directory")
	}
	return os.MkdirAll(filepath.Join(m.home, "_kitties"), 0o700)
}

func (m *Manager) cmd(ctx context.Context, args ...string) (*exec.Cmd, error) {
	if err := m.prepare(); err != nil {
		return nil, err
	}
	bin, err := limaBinary()
	if err != nil {
		return nil, err
	}
	cmd := m.command(ctx, bin, append([]string{"--tty=false"}, args...)...)
	// Never inherit an alternate Lima home or SSH command, forwarded credentials,
	// or settings that copy the gateway's environment into the guest.
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if key == "SSH" || key == "SSH_AUTH_SOCK" || strings.HasPrefix(key, "LIMA_") {
			continue
		}
		cmd.Env = append(cmd.Env, entry)
	}
	cmd.Env = append(cmd.Env, "LIMA_HOME="+m.home)
	cmd.WaitDelay = 2 * time.Second
	configureProcess(cmd)
	return cmd, nil
}

func (m *Manager) run(ctx context.Context, stdin string, args ...string) ([]byte, error) {
	return m.runCommand(ctx, stdin, false, args...)
}

func (m *Manager) runCommand(ctx context.Context, stdin string, textOutput bool, args ...string) ([]byte, error) {
	cmd, err := m.cmd(ctx, args...)
	if err != nil {
		return nil, err
	}
	cmd.Stdin = strings.NewReader(stdin)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if textOutput {
		cmd.Stderr = &stdout
	}
	err = cmd.Run()
	if err != nil {
		return stdout.Bytes(), fmt.Errorf("Lima %s: %w: %s", args[0], err, strings.TrimSpace(stderr.String()))
	}
	return stdout.Bytes(), nil
}

type ownership struct {
	Kitty string            `json:"kitty"`
	Env   map[string]string `json:"env,omitempty"`
}

func (m *Manager) marker(name string) (string, error) {
	if !instanceName.MatchString(name) {
		return "", fmt.Errorf("invalid Kitties VM name %q", name)
	}
	return filepath.Join(m.home, "_kitties", name+".json"), nil
}

func (m *Manager) owned(name string) (ownership, error) {
	var owner ownership
	path, err := m.marker(name)
	if err != nil {
		return owner, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return owner, fmt.Errorf("VM %q is not owned by this Kitties installation: %w", name, err)
	}
	if err := json.Unmarshal(data, &owner); err != nil {
		return owner, fmt.Errorf("read VM ownership: %w", err)
	}
	return owner, nil
}

func (m *Manager) lock(name string) (func(), error) {
	path, err := m.marker(name)
	if err != nil {
		return nil, err
	}
	if err := m.prepare(); err != nil {
		return nil, err
	}
	unlock, err := lockFile(path + ".lock")
	if err != nil {
		return nil, fmt.Errorf("VM %q has another lifecycle operation in progress: %w", name, err)
	}
	return unlock, nil
}

// Up creates and boots a new VM. Workspace is guest-local and is never a host mount.
func (m *Manager) Up(ctx context.Context, spec container.Spec) (string, error) {
	config, err := configuration(spec)
	if err != nil {
		return "", err
	}
	unlock, err := m.lock(spec.Name)
	if err != nil {
		return "", err
	}
	defer unlock()
	path, err := m.marker(spec.Name)
	if err != nil {
		return "", err
	}
	if _, err := os.Lstat(filepath.Join(m.home, spec.Name)); err == nil {
		return "", fmt.Errorf("VM %q already exists; start it instead", spec.Name)
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	// A gateway crash can leave ownership recorded before Lima creates the VM.
	// Reuse that reservation only when it still belongs to this kitty.
	if owner, err := m.owned(spec.Name); err == nil {
		if owner.Kitty != spec.KittyName {
			return "", fmt.Errorf("VM %q is reserved for a different kitty", spec.Name)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	data, err := json.Marshal(ownership{Kitty: spec.KittyName, Env: spec.Env})
	if err != nil {
		return "", err
	}
	tmp := path + ".tmp"
	defer os.Remove(tmp)
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, path); err != nil {
		return "", err
	}
	if _, err := m.run(ctx, config, "create", "--name", spec.Name, "--mount-none", "-"); err != nil {
		if _, statErr := os.Lstat(filepath.Join(m.home, spec.Name)); errors.Is(statErr, os.ErrNotExist) {
			_ = os.Remove(path)
		}
		return "", err
	}
	if err := m.start(ctx, spec.Name); err != nil {
		return "", err
	}
	return spec.Name, nil
}

// Start boots an owned VM and waits for the desktop service and display.
func (m *Manager) Start(ctx context.Context, name string) error {
	unlock, err := m.lock(name)
	if err != nil {
		return err
	}
	defer unlock()
	return m.start(ctx, name)
}

const desktopReadyCommand = "systemctl is-active --quiet kitties-desktop.service && xdpyinfo -display :99 >/dev/null && wmctrl -m >/dev/null"

func (m *Manager) start(ctx context.Context, name string) error {
	if _, err := m.owned(name); err != nil {
		return err
	}
	if _, err := m.run(ctx, "", "start", "--timeout=20m", name); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	for {
		out, err := m.Exec(ctx, name, "sh", "-c", desktopReadyCommand)
		if err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("desktop %q did not become ready: %w: %s", name, ctx.Err(), strings.TrimSpace(out))
		case <-time.After(time.Second):
		}
	}
}

// Stop preserves the VM's disk, including the workspace and browser state.
func (m *Manager) Stop(ctx context.Context, name string) error {
	unlock, err := m.lock(name)
	if err != nil {
		return err
	}
	defer unlock()
	if _, err := m.owned(name); err != nil {
		return err
	}
	_, err = m.run(ctx, "", "stop", name)
	return err
}

// Remove deletes an owned VM and its guest-local workspace.
func (m *Manager) Remove(ctx context.Context, name string) error {
	unlock, err := m.lock(name)
	if err != nil {
		return err
	}
	defer unlock()
	if _, err := m.owned(name); err != nil {
		return err
	}
	if _, err := m.run(ctx, "", "delete", "--force", name); err != nil {
		return err
	}
	path, _ := m.marker(name)
	return os.Remove(path)
}

// Pull is unavailable: these guests are persistent computers, not replaceable OCI images.
func (m *Manager) Pull(context.Context, string) error {
	return errors.New("Lima desktop image replacement is not supported")
}

// ImageStale never schedules automatic replacement of a persistent guest disk.
func (m *Manager) ImageStale(context.Context, string, string) (bool, error) { return false, nil }

func (m *Manager) shellArgs(name string, argv ...string) ([]string, error) {
	owner, err := m.owned(name)
	if err != nil {
		return nil, err
	}
	if len(argv) == 0 || argv[0] == "" {
		return nil, errors.New("nothing to run")
	}
	// Lima changes directory as its login user, before sudo. Enter the private
	// workspace only after switching to kitty; all user arguments stay positional.
	args := []string{"shell", "--workdir", "/", name, "sudo", "-n", "-H", "-u", "kitty", "sh", "-c", `cd /home/kitty/work && exec "$@"`, "--", "env", "--"}
	args = append(args, guestEnvironment(owner.Kitty, owner.Env)...)
	return append(args, argv...), nil
}

// Exec runs an argv in the guest; Lima quotes arguments for its guest SSH shell.
func (m *Manager) Exec(ctx context.Context, name string, argv ...string) (string, error) {
	return m.ExecInput(ctx, name, "", argv...)
}

// ExecInput sends input over stdin, never through a command argument.
func (m *Manager) ExecInput(ctx context.Context, name, stdin string, argv ...string) (string, error) {
	args, err := m.shellArgs(name, argv...)
	if err != nil {
		return "", err
	}
	out, err := m.runCommand(ctx, stdin, true, args...)
	return string(out), err
}

// Screenshot keeps command diagnostics off the binary PNG output.
func (m *Manager) Screenshot(ctx context.Context, name string) ([]byte, error) {
	args, err := m.shellArgs(name, "kitty-shot")
	if err != nil {
		return nil, err
	}
	return m.run(ctx, "", args...)
}

// List returns only VMs created by this installation; personal Lima instances are excluded.
func (m *Manager) List(ctx context.Context) ([]container.Info, error) {
	out, err := m.run(ctx, "", "list", "--json")
	if err != nil {
		return nil, err
	}
	var infos []container.Info
	decoder := json.NewDecoder(bytes.NewReader(out))
	for {
		var vm struct {
			Name   string `json:"name"`
			Status string `json:"status"`
		}
		if err := decoder.Decode(&vm); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			return nil, fmt.Errorf("decode Lima inventory: %w", err)
		}
		owner, err := m.owned(vm.Name)
		if err != nil {
			continue
		}
		infos = append(infos, container.Info{ID: vm.Name, Name: vm.Name, Kitty: owner.Kitty, Image: "lima:debian-13", Status: vm.Status, Running: vm.Status == "Running"})
	}
	return infos, nil
}
