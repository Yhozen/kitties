// Package backup coordinates consistent captures and encrypted restic recovery copies.
package backup

import (
	"archive/tar"
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/madkoding/kitties/internal/maintenance"
	"github.com/madkoding/kitties/internal/statefs"
)

const Tag = "kitties-recovery"
const PendingTag = "kitties-pending"
const Host = "kitties-gateway"

type Status struct {
	Enabled     bool      `json:"enabled"`
	Running     bool      `json:"running"`
	Phase       string    `json:"phase"`
	LastSuccess time.Time `json:"last_success"`
	LastFailure time.Time `json:"last_failure"`
	LastError   string    `json:"last_error,omitempty"`
	NextAttempt time.Time `json:"next_attempt"`
	Overdue     bool      `json:"overdue"`
	SnapshotID  string    `json:"snapshot_id,omitempty"`
	Failures    int       `json:"failures,omitempty"`
}

type Runner func(context.Context, string, []string, ...string) ([]byte, error)
type StreamRunner func(context.Context, string, []string, io.Reader, ...string) ([]byte, error)
type Options struct {
	DataDir string
	// Capture fills an empty private directory and resumes normal work before returning.
	Capture      func(context.Context, string, bool) error
	WriteCapture func(context.Context, string, bool, *tar.Writer) error
	Stream       StreamRunner
	Env          []string
	Run          Runner
	Now          func() time.Time
}

type Manager struct {
	mu      sync.Mutex
	status  Status
	options Options
	ctx     context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup
	closed  bool
	idle    chan struct{}
}

func New(o Options) (*Manager, error) {
	if o.Env == nil {
		o.Env = os.Environ()
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Stream == nil {
		o.Stream = streamRestic
	}
	if o.Run == nil {
		o.Run = runRestic
	}
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{options: o, ctx: ctx, cancel: cancel}
	if raw, err := os.ReadFile(m.path()); err == nil {
		if err = json.Unmarshal(raw, &m.status); err != nil {
			cancel()
			return nil, fmt.Errorf("read backup status: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		cancel()
		return nil, err
	}
	m.status.Enabled = env(o.Env, "RESTIC_REPOSITORY") != "" && env(o.Env, "RESTIC_PASSWORD") != ""
	if m.status.Running {
		m.status.LastFailure = o.Now()
		m.status.LastError = "Backup was interrupted by a gateway restart"
	}
	m.status.Running = false
	m.status.Phase = "idle"
	if m.status.NextAttempt.IsZero() {
		m.status.NextAttempt = o.Now()
	}
	return m, nil
}
func env(values []string, key string) string {
	for i := len(values) - 1; i >= 0; i-- {
		if k, v, ok := strings.Cut(values[i], "="); ok && k == key {
			return v
		}
	}
	return ""
}
func (m *Manager) path() string { return filepath.Join(m.options.DataDir, "recovery-backups.json") }
func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.status
	s.Overdue = s.Enabled && (s.LastSuccess.IsZero() || m.options.Now().Sub(s.LastSuccess) > 26*time.Hour)
	return s
}
func (m *Manager) saveLocked() error {
	raw, err := json.MarshalIndent(m.status, "", "  ")
	if err != nil {
		return err
	}
	if err = statefs.MkdirAll(m.options.DataDir, 0o700); err != nil {
		return err
	}
	if err = statefs.WriteFile(m.path()+".tmp", raw, 0o600); err != nil {
		return err
	}
	return statefs.Rename(m.path()+".tmp", m.path())
}
func (m *Manager) Trigger() (Status, error) {
	if err := m.launch(false); err != nil {
		return m.Status(), err
	}
	return m.Status(), nil
}
func (m *Manager) launch(idleOnly bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.status.Enabled {
		return errors.New("set RESTIC_REPOSITORY and RESTIC_PASSWORD to enable encrypted backups")
	}
	if m.closed {
		return errors.New("gateway is shutting down")
	}
	if m.status.Running {
		return maintenance.ErrBusy
	}
	m.status.Running = true
	m.status.Phase = "waiting"
	if err := m.saveLocked(); err != nil {
		m.status.Running = false
		return err
	}
	m.idle = make(chan struct{})
	m.wg.Add(1)
	go func() { defer m.wg.Done(); m.perform(idleOnly) }()
	return nil
}
func (m *Manager) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		s := m.Status()
		if s.Enabled && !s.Running && !m.options.Now().Before(s.NextAttempt) {
			_ = m.launch(true)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
func (m *Manager) Close() { m.mu.Lock(); m.closed = true; m.cancel(); m.mu.Unlock(); m.wg.Wait() }

// WaitIdle waits through upload, snapshot promotion and retention. The caller must
// first close capture admission so another attempt cannot mutate the repository.
func (m *Manager) WaitIdle(ctx context.Context) error {
	for {
		m.mu.Lock()
		idle := m.idle
		m.mu.Unlock()
		if idle == nil {
			return ctx.Err()
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-idle:
		}
	}
}

func (m *Manager) phase(value string) {
	m.mu.Lock()
	m.status.Phase = value
	_ = m.saveLocked()
	m.mu.Unlock()
}
func (m *Manager) perform(idleOnly bool) {
	ctx, cancel := context.WithTimeout(m.ctx, 6*time.Hour)
	defer cancel()
	id, err := m.captureAndUpload(ctx, idleOnly)
	m.mu.Lock()
	defer m.mu.Unlock()
	m.status.Running = false
	m.status.Phase = "idle"
	now := m.options.Now()
	if errors.Is(err, maintenance.ErrBusy) {
		m.status.NextAttempt = now.Add(time.Minute)
	} else if err != nil {
		m.status.LastFailure = now
		m.status.LastError = m.redact(err.Error())
		m.status.Failures++
		delay := 5 * time.Minute * time.Duration(1<<min(m.status.Failures-1, 6))
		m.status.NextAttempt = now.Add(delay)
	} else {
		m.status.LastSuccess = now
		m.status.LastError = ""
		m.status.SnapshotID = id
		m.status.Failures = 0
		next := time.Date(now.Year(), now.Month(), now.Day(), 3, 0, 0, 0, time.UTC)
		if !next.After(now) {
			next = next.Add(24 * time.Hour)
		}
		m.status.NextAttempt = next
	}
	_ = m.saveLocked()
	close(m.idle)
	m.idle = nil
}
func (m *Manager) captureAndUpload(ctx context.Context, idleOnly bool) (string, error) {
	if m.options.Capture == nil && m.options.WriteCapture == nil {
		return "", errors.New("backup capture is unavailable")
	}
	stage, err := os.MkdirTemp("", "kitties-recovery-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(stage)
	if _, err = m.options.Run(ctx, stage, m.options.Env, "cat", "config"); err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) || exit.ExitCode() != 10 {
			return "", fmt.Errorf("open backup repository: %w", err)
		}
		if _, err = m.options.Run(ctx, stage, m.options.Env, "init"); err != nil {
			return "", fmt.Errorf("initialize backup repository: %w", err)
		}
	}
	m.phase("capturing")
	reader, writer := io.Pipe()
	captured := make(chan error, 1)
	go func() {
		archive := tar.NewWriter(writer)
		var captureErr error
		if m.options.WriteCapture != nil {
			captureErr = m.options.WriteCapture(ctx, stage, idleOnly, archive)
		} else {
			captureErr = m.options.Capture(ctx, stage, idleOnly)
		}
		if captureErr == nil {
			secrets := map[string]string{}
			for _, key := range []string{"BOAT_DEV_API_KEY", "OPENAI_API_KEY", "KITTIES_TOKEN", "KITTIES_VAULT_KEY"} {
				if value := env(m.options.Env, key); value != "" {
					secrets[key] = value
				}
			}
			raw, _ := json.MarshalIndent(secrets, "", "  ")
			captureErr = os.WriteFile(filepath.Join(stage, "bootstrap-secrets.json"), raw, 0o600)
		}
		if captureErr == nil {
			captureErr = AppendDirectory(ctx, archive, stage)
		}
		if captureErr == nil {
			captureErr = archive.Close()
		}
		_ = writer.CloseWithError(captureErr)
		captured <- captureErr
	}()
	output, runErr := m.options.Stream(ctx, stage, m.options.Env, reader, "backup", "--json", "--host", Host, "--tag", PendingTag, "--group-by", "host,tags", "--stdin", "--stdin-filename", "recovery.tar")
	_ = reader.CloseWithError(runErr)
	if err = errors.Join(runErr, <-captured); err != nil {
		return "", fmt.Errorf("capture recovery snapshot: %w", err)
	}
	var id string
	scanner := bufio.NewScanner(bytes.NewReader(output))
	scanner.Buffer(make([]byte, 4096), 1<<20)
	for scanner.Scan() {
		var line struct {
			MessageType string `json:"message_type"`
			SnapshotID  string `json:"snapshot_id"`
		}
		if json.Unmarshal(scanner.Bytes(), &line) == nil && line.MessageType == "summary" {
			id = line.SnapshotID
		}
	}
	if id == "" {
		return "", errors.New("restic did not acknowledge a recovery snapshot")
	}
	promotion, err := m.options.Run(ctx, stage, m.options.Env, "tag", "--json", "--add", Tag, "--remove", PendingTag, id)
	if err != nil {
		return "", fmt.Errorf("commit recovery snapshot: %w", err)
	}
	promoted := ""
	for _, line := range bytes.Split(promotion, []byte("\n")) {
		var change struct {
			Old string `json:"old_snapshot_id"`
			New string `json:"new_snapshot_id"`
		}
		if json.Unmarshal(line, &change) == nil && strings.HasPrefix(change.Old, id) {
			promoted = change.New
		}
	}
	if promoted == "" {
		return "", errors.New("restic did not acknowledge completed recovery promotion")
	}
	id = promoted
	m.phase("retention")
	if _, err = m.options.Run(ctx, stage, m.options.Env, "forget", "--host", Host, "--tag", Tag, "--group-by", "host,tags", "--keep-daily", "7", "--keep-weekly", "4", "--prune"); err != nil {
		return "", fmt.Errorf("apply backup retention: %w", err)
	}
	return id, nil
}
func (m *Manager) redact(message string) string {
	for _, entry := range m.options.Env {
		key, value, ok := strings.Cut(entry, "=")
		if ok && len(value) > 3 && (strings.Contains(key, "KEY") || strings.Contains(key, "TOKEN") || strings.Contains(key, "PASSWORD")) {
			message = strings.ReplaceAll(message, value, "[redacted]")
		}
	}
	if len(message) > 1000 {
		message = message[:1000]
	}
	return message
}
func runRestic(ctx context.Context, dir string, environment []string, args ...string) ([]byte, error) {
	return streamRestic(ctx, dir, environment, nil, args...)
}
func streamRestic(ctx context.Context, dir string, environment []string, input io.Reader, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "restic", args...)
	cmd.Dir = dir
	cmd.Env = environment
	cmd.Stdin = input
	var out, diagnostics bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &diagnostics
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("restic %s failed: %w: %s", args[0], err, strings.TrimSpace(diagnostics.String()))
	}
	return out.Bytes(), nil
}

// Restore writes a recovery snapshot into a new empty directory. It never overwrites a running gateway.
func Restore(ctx context.Context, snapshot, destination string) error {
	_, err := restore(ctx, snapshot, destination, false)
	return err
}
func RestoreGateway(ctx context.Context, snapshot, destination string) (string, error) {
	return restore(ctx, snapshot, destination, true)
}
func restore(ctx context.Context, snapshot, destination string, metadataOnly bool) (string, error) {
	if snapshot == "" {
		snapshot = "latest"
	}
	if snapshot != "latest" {
		for _, r := range snapshot {
			if !strings.ContainsRune("0123456789abcdef", r) {
				return "", errors.New("snapshot must be latest or a hexadecimal restic ID")
			}
		}
	}
	if !filepath.IsAbs(destination) {
		return "", errors.New("restore needs an absolute empty destination")
	}
	if entries, err := os.ReadDir(destination); err == nil && len(entries) > 0 {
		return "", errors.New("restore destination is not empty")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if err := os.MkdirAll(destination, 0o700); err != nil {
		return "", err
	}
	listing, err := runRestic(ctx, destination, os.Environ(), "snapshots", "--json", "--host", Host, "--tag", Tag)
	if err != nil {
		return "", err
	}
	var snapshots []struct {
		ID   string    `json:"id"`
		Time time.Time `json:"time"`
		Tags []string  `json:"tags"`
		Host string    `json:"hostname"`
	}
	if err = json.Unmarshal(listing, &snapshots); err != nil {
		return "", err
	}
	selected := ""
	var newest time.Time
	for _, candidate := range snapshots {
		valid := false
		for _, tag := range candidate.Tags {
			valid = valid || tag == Tag
		}
		if !valid || candidate.Host != Host {
			continue
		}
		if snapshot == "latest" {
			if candidate.Time.After(newest) {
				selected = candidate.ID
				newest = candidate.Time
			}
		} else if strings.HasPrefix(candidate.ID, snapshot) {
			if selected != "" {
				return "", errors.New("ambiguous recovery snapshot")
			}
			selected = candidate.ID
		}
	}
	if selected == "" {
		return "", errors.New("no completed recovery snapshot matches")
	}
	cmd := exec.CommandContext(ctx, "restic", "dump", selected, "recovery.tar")
	output, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	if err = cmd.Start(); err != nil {
		return "", err
	}
	var extractErr error
	if metadataOnly {
		extractErr = extractArchive(ctx, output, destination, func(name string) bool { return !strings.HasPrefix(name, "computers/") && name != "computers" })
	} else {
		extractErr = ExtractArchive(ctx, output, destination)
	}
	if extractErr != nil {
		_ = cmd.Process.Kill()
	}
	return selected, errors.Join(extractErr, cmd.Wait())
}
