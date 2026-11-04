// Package container runs each kitty's isolated environment: one container per kitty, built from
// the kitty-desktop image (a headless X display on Xvfb with a browser and the usual desktop
// tools), with its own workspace volume. A person looks at the display through a screenshot
// (Screenshot) instead of a VNC port, so nothing is published on the host.
//
// The orchestrator never writes a command line: it fills a Spec and this package builds the argv
// for docker or podman. No shell is involved.
package container

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/madkoding/kitties/internal/computer"
)

const (
	// Label marks every container this package starts, so a sweep finds them and nothing else.
	Label = "kitties.bot"
	// NameLabel carries the kitty's name.
	NameLabel = "kitties.name"

	// Workdir is where the kitty's workspace is mounted inside the container.
	Workdir = "/home/kitty/work"
	// Display is the Xvfb display the image starts.
	Display = ":99"
)

var (
	imageRef = regexp.MustCompile(`^[a-z0-9][a-zA-Z0-9._/:@-]{0,254}$`)
	idRe     = regexp.MustCompile(`^[a-f0-9]{64}$`)
	nameRe   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	envKey   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
)

// Seams: what the machine does, as variables so a test says what the machine has.
var (
	lookPath = exec.LookPath
	runCmd   = func(ctx context.Context, bin string, args ...string) ([]byte, error) {
		return exec.CommandContext(ctx, bin, args...).CombinedOutput()
	}
	// runCmdIn is runCmd with text on the command's standard input.
	runCmdIn = func(ctx context.Context, stdin string, bin string, args ...string) ([]byte, error) {
		cmd := exec.CommandContext(ctx, bin, args...)
		cmd.Stdin = strings.NewReader(stdin)
		return cmd.CombinedOutput()
	}
)

// Runtime is the container engine found on this machine.
type Runtime struct {
	Bin string // docker or podman
}

// ErrNoRuntime is returned when neither docker nor podman answers.
var ErrNoRuntime = errors.New("no container runtime: install Docker or Podman, or set containers.runtime")

// ErrNotInstalled is ErrNoRuntime when no docker or podman program was found anywhere.
var ErrNotInstalled = fmt.Errorf("%w: it is not installed", ErrNoRuntime)

// ErrNotRunning is ErrNoRuntime when docker or podman is installed but its engine does not
// answer: Docker Desktop is closed or still starting.
var ErrNotRunning = fmt.Errorf("%w: it is installed but not running", ErrNoRuntime)

// A Mac app opened from the Finder gets a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin), without
// the folders Docker Desktop, Homebrew, OrbStack, Rancher Desktop or Podman put their programs
// in: they are added, so docker is found and finds its own helpers (docker-credential-desktop).
// A Windows app started before Docker Desktop was installed has the same stale PATH.
var (
	goos      = runtime.GOOS
	homeDir   = os.UserHomeDir
	setPath   = func(v string) { _ = os.Setenv("PATH", v) }
	getPath   = func() string { return os.Getenv("PATH") }
	isDir     = func(p string) bool { st, err := os.Stat(p); return err == nil && st.IsDir() }
	pathOnce  sync.Once
	macPlaces = []string{"/usr/local/bin", "/opt/homebrew/bin", "~/.docker/bin", "/Applications/Docker.app/Contents/Resources/bin",
		"~/.orbstack/bin", "~/.rd/bin", "/opt/podman/bin", "/opt/local/bin"}
	// winPlaces are relative to a Windows environment variable ("%ProgramFiles%/…").
	winPlaces = []string{"%ProgramFiles%/Docker/Docker/resources/bin", "%ProgramFiles%/RedHat/Podman",
		"%ProgramFiles%/Podman", "%LOCALAPPDATA%/Programs/Rancher Desktop/resources/resources/win32/bin",
		"%ProgramFiles%/Rancher Desktop/resources/resources/win32/bin", "~/.rd/bin"}
	getEnv = os.Getenv
)

// placesFor lists the folders container engines live in on this system.
func placesFor(goos string) []string {
	switch goos {
	case "darwin":
		return macPlaces
	case "windows":
		var out []string
		for _, p := range winPlaces {
			if strings.HasPrefix(p, "%") {
				end := strings.Index(p[1:], "%") + 1
				base := getEnv(p[1:end])
				if base == "" {
					continue
				}
				p = filepath.Join(base, filepath.FromSlash(p[end+1:]))
			}
			out = append(out, p)
		}
		return out
	}
	return nil
}

// widenPath adds the folders container engines live in that PATH lacks.
func widenPath() {
	places := placesFor(goos)
	if len(places) == 0 {
		return
	}
	home, _ := homeDir()
	path := getPath()
	have := map[string]bool{}
	for _, dir := range filepath.SplitList(path) {
		have[dir] = true
	}
	for _, dir := range places {
		if strings.HasPrefix(dir, "~/") {
			if home == "" {
				continue
			}
			dir = filepath.Join(home, dir[2:])
		}
		if !have[dir] && isDir(dir) {
			path += string(filepath.ListSeparator) + dir
			have[dir] = true
		}
	}
	setPath(strings.TrimPrefix(path, string(filepath.ListSeparator)))
}

// Detect finds the runtime. want is docker, podman or auto.
func Detect(ctx context.Context, want string) (Runtime, error) {
	pathOnce.Do(widenPath)
	candidates := []string{"docker", "podman"}
	if want != "" && want != "auto" {
		candidates = []string{want}
	}
	var reasons []string
	installed := false
	for _, bin := range candidates {
		path, err := lookPath(bin)
		if err != nil {
			reasons = append(reasons, bin+" is not installed")
			continue
		}
		installed = true
		if out, err := runCmd(ctx, path, "info", "--format", "{{.ID}}"); err != nil {
			reasons = append(reasons, fmt.Sprintf("%s does not answer: %s", bin, strings.TrimSpace(string(out))))
			continue
		}
		return Runtime{Bin: path}, nil
	}
	why := ErrNotInstalled
	if installed {
		why = ErrNotRunning
	}
	return Runtime{}, fmt.Errorf("%w (%s)", why, strings.Join(reasons, "; "))
}

// Spec is one container to run.
type Spec struct {
	Name      string
	KittyName string
	Image     string
	MemoryMB  int
	CPUs      float64
	Network   string
	// Workspace is the host folder mounted at Workdir.
	Workspace string
	Env       map[string]string
}

// Validate refuses a spec that would build a wrong or dangerous command line.
func (s Spec) Validate() error {
	if !nameRe.MatchString(s.Name) {
		return fmt.Errorf("container name %q: lowercase letters, digits and dashes", s.Name)
	}
	if !imageRef.MatchString(s.Image) {
		return fmt.Errorf("image %q is not a valid reference", s.Image)
	}
	if s.MemoryMB < 0 || s.CPUs < 0 {
		return errors.New("memory and cpus cannot be negative")
	}
	if s.Network != "" && !nameRe.MatchString(s.Network) {
		return fmt.Errorf("network %q is not a valid name", s.Network)
	}
	for k := range s.Env {
		if !envKey.MatchString(k) {
			return fmt.Errorf("environment variable %q is not a valid name", k)
		}
	}
	return nil
}

// Args builds the `run` argv for the spec.
func (s Spec) Args() []string {
	args := []string{"run", "-d", "--name", s.Name, "--label", Label + "=1", "--label", NameLabel + "=" + s.KittyName,
		"--restart", "unless-stopped", "--shm-size", "512m"}
	if s.MemoryMB > 0 {
		args = append(args, "--memory", strconv.Itoa(s.MemoryMB)+"m")
	}
	if s.CPUs > 0 {
		args = append(args, "--cpus", strconv.FormatFloat(s.CPUs, 'f', -1, 64))
	}
	if s.Network != "" {
		args = append(args, "--network", s.Network)
	}
	if s.Workspace != "" {
		args = append(args, "-v", s.Workspace+":"+Workdir)
	}
	keys := make([]string, 0, len(s.Env))
	for k := range s.Env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		args = append(args, "-e", k+"="+s.Env[k])
	}
	// The desktop keeps the host's time zone (the clock, and where the weather island looks
	// when it is not told a city), unless the spec sets its own.
	if _, own := s.Env["TZ"]; !own {
		if tz := HostTimezone(); tz != "" {
			args = append(args, "-e", "TZ="+tz)
		}
	}
	args = append(args, "-e", "KITTY_NAME="+s.KittyName, "-e", "DISPLAY="+Display)
	return append(args, s.Image)
}

// zoneName matches an IANA time zone name such as America/Santiago or UTC.
var zoneName = regexp.MustCompile(`^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+){0,2}$`)

// HostTimezone is the IANA name of the host's time zone: $TZ, /etc/timezone, or where
// /etc/localtime points (Linux and macOS); empty when it cannot be told.
func HostTimezone() string {
	ok := func(z string) string {
		z = strings.TrimPrefix(strings.TrimSpace(z), ":")
		if zoneName.MatchString(z) {
			return z
		}
		return ""
	}
	if z := ok(os.Getenv("TZ")); z != "" {
		return z
	}
	if b, err := os.ReadFile("/etc/timezone"); err == nil {
		if z := ok(string(b)); z != "" {
			return z
		}
	}
	if link, err := os.Readlink("/etc/localtime"); err == nil {
		if _, after, found := strings.Cut(link, "zoneinfo/"); found {
			return ok(after)
		}
	}
	return ""
}

// Manager starts and stops containers with one runtime.
type Manager struct {
	rt Runtime
}

// New creates a manager for rt.
func New(rt Runtime) *Manager { return &Manager{rt: rt} }

// Runtime names the binary in use.
func (m *Manager) Runtime() string { return m.rt.Bin }

func (m *Manager) Capabilities() computer.Capabilities {
	return computer.Capabilities{Kind: strings.TrimSuffix(filepath.Base(m.rt.Bin), ".exe"), ImageUpdates: true}
}

func validReference(ref string) bool { return nameRe.MatchString(ref) || idRe.MatchString(ref) }

// Up starts the container and returns its id.
func (m *Manager) Up(ctx context.Context, s Spec) (string, error) {
	if err := s.Validate(); err != nil {
		return "", err
	}
	out, err := runCmd(ctx, m.rt.Bin, s.Args()...)
	if err != nil {
		return "", fmt.Errorf("start %s: %s", s.Name, tail(string(out), 6))
	}
	return strings.TrimSpace(string(out)), nil
}

// Stop stops the container, keeping it for a later Start.
func (m *Manager) Stop(ctx context.Context, name string) error {
	return m.simple(ctx, "stop", "-t", "10", name)
}

// Start starts a stopped container again.
func (m *Manager) Start(ctx context.Context, name string) error {
	return m.simple(ctx, "start", name)
}

// Remove removes the container, running or not.
func (m *Manager) Remove(ctx context.Context, name string) error {
	return m.simple(ctx, "rm", "-f", name)
}

func (m *Manager) simple(ctx context.Context, args ...string) error {
	if !validReference(args[len(args)-1]) {
		return fmt.Errorf("container name %q is not valid", args[len(args)-1])
	}
	out, err := runCmd(ctx, m.rt.Bin, args...)
	if err != nil {
		return fmt.Errorf("%s %s: %s", args[0], args[len(args)-1], tail(string(out), 6))
	}
	return nil
}

// Exec runs a command inside the container and returns what it printed.
func (m *Manager) Exec(ctx context.Context, name string, argv ...string) (string, error) {
	if !validReference(name) {
		return "", fmt.Errorf("container name %q is not valid", name)
	}
	if len(argv) == 0 {
		return "", errors.New("nothing to run")
	}
	args := append([]string{"exec", "-w", Workdir, name}, argv...)
	out, err := runCmd(ctx, m.rt.Bin, args...)
	if err != nil {
		return string(out), fmt.Errorf("exec in %s: %w", name, err)
	}
	return string(out), nil
}

// Pull downloads an image again: the desktop's image is a moving tag (latest).
func (m *Manager) Pull(ctx context.Context, image string) error {
	if !imageRef.MatchString(image) {
		return fmt.Errorf("image %q is not a valid reference", image)
	}
	if out, err := runCmd(ctx, m.rt.Bin, "pull", "-q", image); err != nil {
		return fmt.Errorf("pull %s: %s", image, tail(string(out), 4))
	}
	return nil
}

// ImageStale tells whether a container was made from an image that is no longer the one the
// reference names on this machine (one that was pulled since, or built again). An image that is
// not here at all is not stale: there is nothing newer to move to.
func (m *Manager) ImageStale(ctx context.Context, name, image string) (bool, error) {
	if !validReference(name) {
		return false, fmt.Errorf("container name %q is not valid", name)
	}
	if !imageRef.MatchString(image) {
		return false, fmt.Errorf("image %q is not a valid reference", image)
	}
	made, err := runCmd(ctx, m.rt.Bin, "inspect", "-f", "{{.Image}}", name)
	if err != nil {
		return false, fmt.Errorf("inspect %s: %s", name, tail(string(made), 4))
	}
	current, err := runCmd(ctx, m.rt.Bin, "image", "inspect", "-f", "{{.Id}}", image)
	if err != nil {
		return false, nil
	}
	return strings.TrimSpace(string(made)) != strings.TrimSpace(string(current)), nil
}

// ExecInput is Exec with text on the command's standard input: what must not show in the
// command line, where any process of the container (or of the host) can read it.
func (m *Manager) ExecInput(ctx context.Context, name, stdin string, argv ...string) (string, error) {
	if !validReference(name) {
		return "", fmt.Errorf("container name %q is not valid", name)
	}
	if len(argv) == 0 {
		return "", errors.New("nothing to run")
	}
	args := append([]string{"exec", "-i", "-w", Workdir, name}, argv...)
	out, err := runCmdIn(ctx, stdin, m.rt.Bin, args...)
	if err != nil {
		// The input is not in the error: it may be a secret.
		return string(out), fmt.Errorf("exec in %s: %w", name, err)
	}
	return string(out), nil
}

// Screenshot captures the kitty's display as PNG bytes, with the image's own `kitty-shot` tool.
func (m *Manager) Screenshot(ctx context.Context, name string) ([]byte, error) {
	if !validReference(name) {
		return nil, fmt.Errorf("container name %q is not valid", name)
	}
	out, err := runCmd(ctx, m.rt.Bin, "exec", name, "kitty-shot")
	if err != nil {
		return nil, fmt.Errorf("screenshot of %s: %s", name, tail(string(out), 6))
	}
	return out, nil
}

// Info is one container of ours.
type Info struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Kitty   string `json:"kitty"`
	Image   string `json:"image"`
	Status  string `json:"status"`
	Running bool   `json:"running"`
}

// List returns every container carrying Label, running or not.
func (m *Manager) List(ctx context.Context) ([]Info, error) {
	out, err := runCmd(ctx, m.rt.Bin, "ps", "-a", "--no-trunc", "--filter", "label="+Label, "--format",
		"{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Label \""+NameLabel+"\"}}")
	if err != nil {
		return nil, fmt.Errorf("list the containers: %s", tail(string(out), 6))
	}
	var infos []Info
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.Split(line, "|")
		if len(parts) < 4 {
			continue
		}
		info := Info{ID: parts[0], Name: parts[1], Image: parts[2], Status: parts[3],
			Running: strings.HasPrefix(parts[3], "Up")}
		if len(parts) > 4 {
			info.Kitty = parts[4]
		}
		infos = append(infos, info)
	}
	return infos, nil
}

// Status reports whether the container exists and runs.
func (m *Manager) Status(ctx context.Context, name string) (exists, running bool, err error) {
	infos, err := m.List(ctx)
	if err != nil {
		return false, false, err
	}
	for _, i := range infos {
		if i.Name == name || i.ID == name {
			return true, i.Running, nil
		}
	}
	return false, false, nil
}

// WaitReady polls until the container reports running, or the timeout passes.
func (m *Manager) WaitReady(ctx context.Context, name string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		exists, running, err := m.Status(ctx, name)
		if err != nil {
			return err
		}
		if exists && running {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%s did not come up in %s", name, timeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(pollEvery):
		}
	}
}

var pollEvery = 500 * time.Millisecond

func tail(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}
