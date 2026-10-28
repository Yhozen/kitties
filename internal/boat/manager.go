package boat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/madkoding/kitties/internal/computer"
	"github.com/madkoding/kitties/internal/container"
	"github.com/madkoding/kitties/internal/guest"
	"github.com/madkoding/kitties/internal/statefs"
)

type Options struct {
	StateDir   string
	APIKey     string
	BaseURL    string
	Size       string
	TTL        time.Duration
	MaxRunning int
}

type Manager struct {
	sshPublished                        bool
	dir, apiKey, baseURL, size, ownerID string
	ttl                                 time.Duration
	maxRunning                          int
	client                              *http.Client
	poll                                time.Duration
	now                                 func() time.Time
	mu                                  sync.Mutex
	lifecycle                           chan struct{}
	sshMu                               sync.Mutex
	state                               diskState
	unlock                              func()
	closeOnce                           sync.Once
	command                             func(context.Context, string, ...string) *exec.Cmd
	runGuest                            func(context.Context, record, string, bool, ...string) ([]byte, error)
}

func New(o Options) (*Manager, error) {
	if !filepath.IsAbs(o.StateDir) || filepath.Clean(o.StateDir) == string(filepath.Separator) {
		return nil, errors.New("Boat state directory must be absolute and dedicated")
	}
	if strings.TrimSpace(o.APIKey) == "" {
		return nil, errors.New("Boat API key is required")
	}
	if o.BaseURL == "" {
		o.BaseURL = apiBase
	}
	u, err := url.Parse(o.BaseURL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("invalid Boat API base URL")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1")) {
		return nil, errors.New("Boat API requires HTTPS")
	}
	if o.Size == "" {
		o.Size = "small"
	}
	if o.Size != "small" && o.Size != "default" && o.Size != "large" && o.Size != "xlarge" {
		return nil, errors.New("unknown Boat machine size")
	}
	if o.TTL == 0 {
		o.TTL = time.Hour
	}
	if o.TTL < time.Minute || o.TTL > 30*24*time.Hour {
		return nil, errors.New("Boat TTL must be between one minute and 30 days")
	}
	if o.MaxRunning == 0 {
		o.MaxRunning = 5
	}
	if o.MaxRunning < 1 || o.MaxRunning > 5 {
		return nil, errors.New("Boat supports one to five running kitties")
	}
	if err = statefs.MkdirAll(o.StateDir, 0o700); err != nil {
		return nil, err
	}
	if err = os.Chmod(o.StateDir, 0o700); err != nil {
		return nil, err
	}
	unlock, err := lockFile(filepath.Join(o.StateDir, "state.lock"))
	if err != nil {
		return nil, fmt.Errorf("Boat state is already in use: %w", err)
	}
	m := &Manager{dir: o.StateDir, apiKey: o.APIKey, baseURL: strings.TrimRight(o.BaseURL, "/"), size: o.Size, ttl: o.TTL, maxRunning: o.MaxRunning, client: &http.Client{Timeout: 60 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, poll: 2 * time.Second, now: time.Now, unlock: unlock, command: exec.CommandContext}
	m.lifecycle = make(chan struct{}, 1)
	m.runGuest = m.sshRun
	if err = m.load(); err != nil {
		unlock()
		return nil, err
	}
	return m, nil
}
func (m *Manager) Close() error { m.closeOnce.Do(m.unlock); return nil }
func (m *Manager) Capabilities() computer.Capabilities {
	return computer.Capabilities{Kind: "boat", PersistentDisk: true, GuestWorkspace: true, ImageUpdates: false}
}
func (m *Manager) Resolve(_ context.Context, ref string) (computer.Reference, error) {
	r, err := m.lookup(ref)
	if err != nil {
		return computer.Reference{}, err
	}
	return computer.Reference{Runtime: "boat", ID: r.RemoteID, OwnerID: m.ownerID, Generation: r.Generation, CheckpointID: r.CheckpointID}, nil
}
func (m *Manager) Pull(context.Context, string) error {
	return errors.New("Boat computers are persistent; image replacement is unsupported")
}
func (m *Manager) ImageStale(context.Context, string, string) (bool, error) { return false, nil }

func (m *Manager) Up(ctx context.Context, spec container.Spec) (string, error) {
	if err := m.lockLifecycle(ctx); err != nil {
		return "", err
	}
	defer func() { <-m.lifecycle }()
	if !namePattern.MatchString(spec.Name) || strings.HasPrefix(spec.Name, "kitty-template-") {
		return "", errors.New("invalid Kitties computer name")
	}
	if spec.Network != "" {
		return "", errors.New("Boat does not support a local container network")
	}
	for key, value := range spec.Env {
		if !regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`).MatchString(key) || strings.ContainsRune(value, 0) {
			return "", errors.New("invalid guest environment")
		}
	}
	r, err := m.lookup(spec.Name)
	if err != nil {
		r = record{Name: spec.Name, KittyName: spec.KittyName, Generation: 1, CheckpointName: checkpointName(m.ownerID, spec.Name), Env: spec.Env}
		if err = m.put(r); err != nil {
			return "", err
		}
	}
	if r.Removed {
		return "", errors.New("this name retains a recovery checkpoint; restore explicitly or choose a new name")
	}
	if err = m.start(ctx, r); err != nil {
		return "", err
	}
	r, err = m.lookup(spec.Name)
	return r.RemoteID, err
}
func (m *Manager) Start(ctx context.Context, ref string) error {
	if err := m.lockLifecycle(ctx); err != nil {
		return err
	}
	defer func() { <-m.lifecycle }()
	r, err := m.lookup(ref)
	if err != nil {
		return err
	}
	if r.Template {
		return errors.New("clean templates cannot be started as desktops")
	}
	return m.start(ctx, r)
}
func (m *Manager) start(ctx context.Context, r record) error {
	if err := m.guardGeneration(ctx, r); err != nil {
		return err
	}
	if r.Pending != nil {
		switch r.Pending.Kind {
		case "create":
			return m.create(ctx, r)
		case "stop", "checkpoint":
			if err := m.stop(ctx, r); err != nil {
				return err
			}
			r, _ = m.lookup(r.Name)
		case "delete":
			return errors.New("computer deletion is pending; finish removal before restoring")
		}
	}
	if r.RemoteID == "" {
		if r.Removed || r.Generation > 1 {
			return errors.New("computer identity is missing; refusing to create a blank desktop")
		}
		if r.Template {
			return m.beginCreate(ctx, r, "", "")
		}
		template, err := m.template(ctx)
		if err != nil {
			return err
		}
		return m.beginCreate(ctx, r, template.Name, template.SnapshotID)
	}
	s, err := m.get(ctx, r.RemoteID)
	if isStatus(err, 404) || err == nil && s.DataExpiredAt != "" {
		return m.restore(ctx, r)
	}
	if err != nil {
		return err
	}
	if err = m.checkOwner(r, s); err != nil {
		return err
	}
	if s.State == "archiving" {
		return errors.New("computer is still archiving; retry after its checkpoint completes")
	}
	if s.State == "archived" {
		if err = m.capacity(ctx); err != nil {
			return err
		}
		r.Pending = &operation{Kind: "resume", StartedAt: m.now()}
		if err = m.put(r); err != nil {
			return err
		}
		err = m.json(ctx, "POST", "/sandboxes/"+url.PathEscape(r.RemoteID)+"/resume", map[string]any{"ttlSeconds": int(m.ttl.Seconds()), "noEnv": true}, nil, nil)
		if isCode(err, "snapshot_data_expired") {
			return m.restore(ctx, r)
		}
		if err != nil {
			return err
		}
	}
	return m.finishStart(ctx, r)
}
func (m *Manager) capacity(ctx context.Context) error {
	all, err := m.inventory(ctx)
	if err != nil {
		return err
	}
	active := 0
	for _, s := range all {
		if s.active() {
			active++
		}
	}
	if active >= m.maxRunning {
		return fmt.Errorf("Boat running computer limit reached (%d)", m.maxRunning)
	}
	return nil
}
func (m *Manager) beginCreate(ctx context.Context, r record, from, sourceID string) error {
	if err := m.capacity(ctx); err != nil {
		return err
	}
	body, err := json.Marshal(createRequest{Name: r.Name, Type: m.size, TTLSeconds: int(m.ttl.Seconds()), Visibility: "private", NoEnv: true, Snapshots: true, From: from, Labels: map[string]string{ownerLabel: m.ownerID, kittyLabel: r.Name, generationLabel: strconv.Itoa(r.Generation)}})
	if err != nil {
		return err
	}
	r.Pending = &operation{Kind: "create", Key: randomID(), Body: body, StartedAt: m.now(), SourceCheckpointID: sourceID}
	if err = m.put(r); err != nil {
		return err
	}
	return m.create(ctx, r)
}
func (m *Manager) create(ctx context.Context, r record) error {
	p := r.Pending
	if p == nil || p.Kind != "create" || p.Key == "" || len(p.Body) == 0 {
		return errors.New("missing durable Boat create request")
	}
	// Inventory recovers a lost response without consuming another create request.
	all, err := m.inventory(ctx)
	if err != nil {
		return err
	}
	var found []sandbox
	for _, s := range all {
		if s.Labels[kittyLabel] == r.Name && s.Labels[generationLabel] == strconv.Itoa(r.Generation) {
			found = append(found, s)
		}
	}
	if len(found) > 1 {
		return errors.New("multiple Boat computers match this generation; refusing to choose")
	}
	var s sandbox
	if len(found) == 1 {
		s = found[0]
	} else {
		if m.now().Sub(p.StartedAt) >= 24*time.Hour {
			return errors.New("Boat create outcome is unknown and its idempotency key expired; reconcile the provider before retrying")
		}
		if err = m.capacity(ctx); err != nil {
			return err
		}
		var reply struct {
			Sandbox sandbox `json:"sandbox"`
		}
		if err = m.json(ctx, "POST", "/sandboxes", p.Body, map[string]string{"Idempotency-Key": p.Key}, &reply); err != nil {
			return err
		}
		s = reply.Sandbox
	}
	if s.ID == "" {
		return errors.New("Boat create returned no computer ID")
	}
	if r.RemoteID != "" && r.RemoteID != s.ID {
		r.PreviousIDs = append(r.PreviousIDs, r.RemoteID)
	}
	var body createRequest
	if err = json.Unmarshal(p.Body, &body); err != nil {
		return err
	}
	sourceCheckpoint := ""
	if body.From != "" {
		sourceCheckpoint = p.SourceCheckpointID
		if sourceCheckpoint == "" {
			sourceCheckpoint = r.CheckpointID
		}
	}
	r.Receipt = &creationReceipt{ID: s.ID, Generation: r.Generation, SourceCheckpointID: sourceCheckpoint, Key: p.Key, Body: p.Body, At: m.now()}
	r.RemoteID = s.ID
	r.Removed = false
	r.Pending = &operation{Kind: "bootstrap", StartedAt: m.now()}
	if err = m.put(r); err != nil {
		return err
	}
	return m.finishStart(ctx, r)
}
func (m *Manager) restore(ctx context.Context, r record) error {
	snapshot, err := m.saved(ctx, r.CheckpointName)
	if err != nil {
		return fmt.Errorf("durable recovery checkpoint unavailable: %w", err)
	}
	if snapshot.Status != "ready" || snapshot.SnapshotID == "" {
		return fmt.Errorf("durable recovery checkpoint is %s; refusing a blank desktop", snapshot.Status)
	}
	if r.CheckpointID != "" && snapshot.SnapshotID != r.CheckpointID {
		return errors.New("saved checkpoint changed outside this deployment; refusing unverified recovery")
	}
	r.Generation++
	r.CheckpointID = snapshot.SnapshotID
	return m.beginCreate(ctx, r, r.CheckpointName, r.CheckpointID)
}
func (m *Manager) finishStart(ctx context.Context, r record) error {
	if _, err := m.waitReady(ctx, r); err != nil {
		return err
	}
	command := []string{"bash", "-s"}
	if r.Pending != nil && (r.Pending.Kind == "bootstrap" || r.Pending.Kind == "resume") {
		command = append([]string{"env", "KITTY_DESKTOP_RESTART=1"}, command...)
	}
	if _, err := m.runGuest(ctx, r, guest.BoatScript, true, command...); err != nil {
		return fmt.Errorf("bootstrap Boat desktop: %w", err)
	}
	if _, err := m.runGuest(ctx, r, "", false, "kitty-ready"); err != nil {
		return fmt.Errorf("Boat desktop is not ready: %w", err)
	}
	r.Pending = nil
	r.Removed = false
	return m.put(r)
}

func (m *Manager) Stop(ctx context.Context, ref string) error {
	if err := m.lockLifecycle(ctx); err != nil {
		return err
	}
	defer func() { <-m.lifecycle }()
	r, err := m.lookup(ref)
	if err != nil {
		return err
	}
	if err = m.guardGeneration(ctx, r); err != nil {
		return err
	}
	return m.stop(ctx, r)
}
func (m *Manager) stop(ctx context.Context, r record) error {
	if r.RemoteID == "" {
		return errors.New("computer creation is unresolved; cannot report a durable stop")
	}
	if r.Pending != nil && r.Pending.Kind == "checkpoint" {
		return m.saveCheckpoint(ctx, r)
	}
	s, err := m.get(ctx, r.RemoteID)
	if err != nil {
		return err
	}
	if err = m.checkOwner(r, s); err != nil {
		return err
	}
	if s.State != "archived" && s.State != "archiving" {
		if !s.running() {
			return fmt.Errorf("computer is %s; wait for it before stopping", s.State)
		}
		if _, err = m.runGuest(ctx, r, "", false, "kitty-quiesce"); err != nil {
			return fmt.Errorf("cannot checkpoint desktop: %w", err)
		}
		if r.Template {
			if _, err = m.runGuest(ctx, r, "", true, "sh", "-c", "systemctl stop kitties-desktop.service && rm -rf /home/kitty/work/.browser && sync"); err != nil {
				return fmt.Errorf("clean template browser state: %w", err)
			}
		}
		r.Pending = &operation{Kind: "stop", StartedAt: m.now()}
		if err = m.put(r); err != nil {
			return err
		}
		if err = m.json(ctx, "POST", "/sandboxes/"+url.PathEscape(r.RemoteID)+"/stop", map[string]bool{"force": false}, nil, nil); err != nil {
			return err
		}
	}
	for {
		s, err = m.get(ctx, r.RemoteID)
		if err != nil {
			return err
		}
		if err = m.checkOwner(r, s); err != nil {
			return err
		}
		if s.Stop != nil && s.Stop.Status == "failing" {
			return fmt.Errorf("Boat checkpoint stop failed: %s", s.Stop.Error)
		}
		if s.State == "archived" {
			break
		}
		if s.State == "error" || s.State == "cancelled" {
			return fmt.Errorf("Boat stop failed: %s", s.State)
		}
		if err = m.delay(ctx); err != nil {
			return err
		}
	}
	if !s.SnapshotAvailable || s.LastSnapshotStatus == "failed" {
		return errors.New("Boat stopped without a verified snapshot; durable stop is incomplete")
	}
	r.Pending = &operation{Kind: "checkpoint", StartedAt: m.now()}
	if err = m.put(r); err != nil {
		return err
	}
	return m.saveCheckpoint(ctx, r)
}
func (m *Manager) saveCheckpoint(ctx context.Context, r record) error {
	var reply struct {
		Snapshot savedSnapshot `json:"snapshot"`
	}
	if err := m.json(ctx, "POST", "/saved-snapshots", map[string]string{"sandboxId": r.RemoteID, "name": r.CheckpointName}, nil, &reply); err != nil && !isCode(err, "save_in_progress") {
		return err
	}
	for {
		snap, err := m.saved(ctx, r.CheckpointName)
		if err != nil {
			return err
		}
		if snap.Status == "failed" {
			return fmt.Errorf("permanent Boat checkpoint failed: %s", snap.Error)
		}
		if snap.Status == "ready" {
			if snap.SnapshotID == "" || snap.SourceSandboxID != r.RemoteID {
				return errors.New("saved checkpoint identity does not match this computer")
			}
			r.CheckpointID = snap.SnapshotID
			r.CheckpointAt = m.now()
			r.Pending = nil
			return m.put(r)
		}
		if err = m.delay(ctx); err != nil {
			return err
		}
	}
}

func (m *Manager) Remove(ctx context.Context, ref string) error {
	if err := m.lockLifecycle(ctx); err != nil {
		return err
	}
	defer func() { <-m.lifecycle }()
	r, err := m.lookup(ref)
	if err != nil {
		return err
	}
	if err = m.guardGeneration(ctx, r); err != nil {
		return err
	}
	if r.Template {
		return errors.New("clean templates are managed by the runtime")
	}
	if r.Removed {
		return nil
	}
	if r.Pending == nil || r.Pending.Kind != "delete" {
		if err = m.stop(ctx, r); err != nil {
			return err
		}
		r, _ = m.lookup(r.Name)
		r.Pending = &operation{Kind: "delete", StartedAt: m.now()}
		if err = m.put(r); err != nil {
			return err
		}
	}
	return m.deleteComputer(ctx, r)
}

func (m *Manager) deleteComputer(ctx context.Context, r record) error {
	var err error
	if r.Removed {
		return nil
	}
	if r.Pending == nil || r.Pending.Kind != "delete" {
		r.Pending = &operation{Kind: "delete", StartedAt: m.now()}
		if err = m.put(r); err != nil {
			return err
		}
	}
	if r.Pending.ID == "" {
		var reply struct {
			Operation struct {
				ID string `json:"id"`
			} `json:"operation"`
		}
		err = m.json(ctx, "DELETE", "/sandboxes/"+url.PathEscape(r.RemoteID), nil, map[string]string{"X-Ascii-Confirm-Delete": r.RemoteID}, &reply)
		if isStatus(err, 404) {
			removed, verifyErr := m.reconcileDeleted(ctx, r)
			if verifyErr != nil {
				return verifyErr
			}
			if removed {
				r.Removed = true
				r.Pending = nil
				return m.put(r)
			}
		}
		if err != nil {
			return err
		}
		if reply.Operation.ID == "" {
			return errors.New("Boat deletion returned no operation ID")
		}
		r.Pending = &operation{Kind: "delete", ID: reply.Operation.ID, StartedAt: r.Pending.StartedAt}
		if err = m.put(r); err != nil {
			return err
		}
	}
	for {
		var reply struct {
			Operation struct {
				Status string `json:"status"`
			} `json:"operation"`
		}
		if err = m.json(ctx, "GET", "/deletion-operations/"+url.PathEscape(r.Pending.ID), nil, nil, &reply); err != nil {
			return err
		}
		if reply.Operation.Status == "completed" {
			r.Removed = true
			r.Pending = nil
			return m.put(r)
		}
		if err = m.delay(ctx); err != nil {
			return err
		}
	}
}

// PurgeCheckpoint deletes only the independently retained recovery point.
func (m *Manager) PurgeCheckpoint(ctx context.Context, ref string) error {
	if err := m.lockLifecycle(ctx); err != nil {
		return err
	}
	defer func() { <-m.lifecycle }()
	r, err := m.lookup(ref)
	if err != nil {
		return err
	}
	if r.Template || !r.Removed || r.Pending != nil {
		return errors.New("remove the live computer and finish pending operations before purging its recovery checkpoint")
	}
	if err = m.guardGeneration(ctx, r); err != nil {
		return err
	}
	point, err := m.saved(ctx, r.CheckpointName)
	if err != nil && !isStatus(err, 404) {
		return err
	}
	if err == nil && point.SnapshotID != r.CheckpointID {
		return errors.New("recovery checkpoint changed outside this deployment; refusing to purge newer work")
	}
	err = m.json(ctx, "DELETE", "/saved-snapshots/"+url.PathEscape(r.CheckpointName), nil, nil, nil)
	if err != nil && !isStatus(err, 404) {
		return err
	}
	r.CheckpointID = ""
	r.CheckpointAt = time.Time{}
	return m.put(r)
}

// Renew extends the provider's orphan-stop deadline; callers renew only active leases.
func (m *Manager) Renew(ctx context.Context, ref string) error {
	r, err := m.lookup(ref)
	if err != nil {
		return err
	}
	if r.RemoteID == "" || r.Removed {
		return errors.New("computer is unavailable")
	}
	s, err := m.get(ctx, r.RemoteID)
	if err != nil {
		return err
	}
	if err = m.checkOwner(r, s); err != nil {
		return err
	}
	if !s.running() {
		return errors.New("computer is not running")
	}
	return m.json(ctx, "PATCH", "/sandboxes/"+url.PathEscape(r.RemoteID), map[string]int{"ttlSeconds": int(m.ttl.Seconds())}, nil, nil)
}

func (m *Manager) List(ctx context.Context) ([]container.Info, error) {
	all, err := m.inventory(ctx)
	if err != nil {
		return nil, err
	}
	byID := map[string]sandbox{}
	for _, s := range all {
		byID[s.ID] = s
	}
	var result []container.Info
	for _, r := range m.records() {
		if r.Removed || r.Template {
			continue
		}
		s, ok := byID[r.RemoteID]
		if !ok {
			continue
		}
		if err = m.checkOwner(r, s); err != nil {
			return nil, err
		}
		result = append(result, container.Info{ID: s.ID, Name: r.Name, Kitty: r.KittyName, Image: "boat/" + m.size, Status: s.State, Running: s.running()})
	}
	return result, nil
}

// ExportHome reads the permanent checkpoint, never a live, changing home directory.
func (m *Manager) ExportHome(ctx context.Context, ref string, w io.Writer) error {
	if err := m.lockLifecycle(ctx); err != nil {
		return err
	}
	defer func() { <-m.lifecycle }()
	r, err := m.lookup(ref)
	if err != nil {
		return err
	}
	if r.CheckpointID == "" {
		return errors.New("computer has no permanent checkpoint to export")
	}
	snapshot, err := m.saved(ctx, r.CheckpointName)
	if err != nil {
		return err
	}
	if snapshot.Status != "ready" || snapshot.SnapshotID != r.CheckpointID {
		return errors.New("recovery checkpoint is not ready or has changed")
	}
	resp, err := m.request(ctx, "GET", "/snapshots/"+url.PathEscape(r.CheckpointID)+"/files?path="+url.QueryEscape("__system__/home/kitty"), nil, nil)
	if isCode(err, "content_unavailable") || isCode(err, "snapshot_not_indexed") || isCode(err, "legacy_snapshot") {
		return m.bundleExportHome(ctx, r, w)
	}
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if skipped := resp.Header.Get("X-Snapshot-Skipped-Base-Image-Files"); skipped != "" && skipped != "0" {
		resp.Body.Close()
		return m.bundleExportHome(ctx, r, w)
	}
	if kind := resp.Header.Get("X-Snapshot-Entry-Kind"); kind != "dir" {
		return errors.New("Boat home export did not return a directory archive")
	}
	_, err = io.Copy(w, resp.Body)
	return err
}

func (m *Manager) lockLifecycle(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case m.lifecycle <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
