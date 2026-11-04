package main

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/madkoding/kitties/internal/backup"
	"github.com/madkoding/kitties/internal/computer"
	"github.com/madkoding/kitties/internal/config"
	"github.com/madkoding/kitties/internal/container"
	"github.com/madkoding/kitties/internal/kitty"
	"github.com/madkoding/kitties/internal/orchestrator"
	"github.com/madkoding/kitties/internal/statefs"
)

type captureComputer struct {
	*fakeContainers
	dir       string
	refs      map[string]computer.Reference
	running   map[string]bool
	exportErr error
	onExport  func(string)
}

func (f *captureComputer) Capabilities() computer.Capabilities {
	return computer.Capabilities{Kind: "boat", PersistentDisk: true, GuestWorkspace: true}
}
func (f *captureComputer) save() error {
	raw, err := json.Marshal(f.running)
	if err != nil {
		return err
	}
	return statefs.WriteFile(filepath.Join(f.dir, "runtime.json"), raw, 0o600)
}
func (f *captureComputer) Up(_ context.Context, s container.Spec) (string, error) {
	id := "bx-" + s.Name
	f.refs[s.Name] = computer.Reference{Runtime: "boat", ID: id, OwnerID: "fixture-owner", Generation: 1}
	f.running[id] = true
	return id, f.save()
}
func (f *captureComputer) Start(_ context.Context, id string) error {
	f.running[id] = true
	return f.save()
}
func (f *captureComputer) Stop(_ context.Context, id string) error {
	f.running[id] = false
	for name, ref := range f.refs {
		if ref.ID == id {
			ref.CheckpointID = "checkpoint-" + id
			f.refs[name] = ref
		}
	}
	return f.save()
}
func (f *captureComputer) Resolve(_ context.Context, name string) (computer.Reference, error) {
	return f.refs[name], nil
}
func (f *captureComputer) List(context.Context) ([]container.Info, error) {
	var out []container.Info
	for name, ref := range f.refs {
		out = append(out, container.Info{Name: name, ID: ref.ID, Running: f.running[ref.ID]})
	}
	return out, nil
}
func (f *captureComputer) ExportHome(_ context.Context, id string, out io.Writer) error {
	if f.onExport != nil {
		f.onExport(id)
	}
	writer := tar.NewWriter(out)
	body := []byte("home from " + id)
	if err := writer.WriteHeader(&tar.Header{Name: ".config/settings", Size: int64(len(body)), Mode: 0o600}); err != nil {
		return err
	}
	if _, err := writer.Write(body); err != nil {
		return err
	}
	if f.exportErr != nil {
		return f.exportErr
	}
	return writer.Close()
}
func captureApp(t *testing.T, dir string) (*app, *captureComputer, string) {
	t.Helper()
	mustCloudState(t, statefs.MkdirAll(dir, 0o700))
	cfg := config.Defaults()
	cfg.DataDir = dir
	cfg.Containers.Runtime = "boat"
	cfg.Providers = map[string]config.Provider{"fixture": {Kind: "ollama", Model: "fixture"}}
	cfg.DefaultProvider = "fixture"
	f := &captureComputer{fakeContainers: &fakeContainers{names: map[string]bool{}}, dir: dir, refs: map[string]computer.Reference{}, running: map[string]bool{}}
	fleet, err := orchestrator.New(cfg, orchestrator.WithContainers(f, nil))
	mustCloudState(t, err)
	configuration := filepath.Join(t.TempDir(), "original.yaml")
	mustCloudState(t, os.WriteFile(configuration, []byte("providers:\n  file-only:\n    kind: ollama\n    model: saved\n"), 0o600))
	a := &app{cfg: cfg, fleet: fleet, configPath: configuration}
	t.Cleanup(func() { _ = a.close() })
	k, err := fleet.Create(context.Background(), orchestrator.Spec{Name: "mimi"})
	mustCloudState(t, err)
	mustCloudState(t, fleet.Start(context.Background(), k.ID))
	return a, f, k.ID
}

func TestRecoveryCaptureFormsOneConsistentArchiveFromCommittedState(t *testing.T) {
	_, endpoint := newGatewayStateService(t)
	dir := filepath.Join(t.TempDir(), "gateway")
	remote, err := statefs.Open(context.Background(), dir, endpoint)
	mustCloudState(t, err)
	defer remote.Close()
	a, f, id := captureApp(t, dir)
	f.onExport = func(ref string) {
		for _, running := range f.running {
			if running {
				t.Error("home export started before the fleet was checkpointed")
			}
		}
		if !a.fleet.Admission().Active() {
			t.Error("home streamed without maintenance ownership")
		}
		if _, err := a.fleet.Acquire(context.Background(), id); err == nil {
			t.Error("new work entered the recovery capture")
		}
	}
	stage := t.TempDir()
	var output bytes.Buffer
	writer := tar.NewWriter(&output)
	mustCloudState(t, a.captureRecovery(context.Background(), stage, true, writer))
	current, err := a.fleet.Get(id)
	mustCloudState(t, err)
	if current.Availability != computer.Enabled || current.Status != kitty.StatusRunning || a.fleet.Admission().Active() {
		t.Fatal("successful capture did not restore availability")
	}
	// The state copy remains at the same checkpoint as the streamed home after the live source resumes.
	mustCloudState(t, backup.AppendDirectory(context.Background(), writer, stage))
	mustCloudState(t, writer.Close())
	restored := t.TempDir()
	mustCloudState(t, backup.ExtractArchive(context.Background(), bytes.NewReader(output.Bytes()), restored))
	raw, err := os.ReadFile(filepath.Join(restored, "gateway", "kitties.json"))
	mustCloudState(t, err)
	var saved []*kitty.Kitty
	mustCloudState(t, json.Unmarshal(raw, &saved))
	if len(saved) != 1 || saved[0].Status != kitty.StatusSleeping || saved[0].Computer.CheckpointID != current.Computer.CheckpointID || saved[0].Operation.Kind != "" {
		t.Fatalf("inconsistent saved fleet: %+v", saved)
	}
	raw, err = os.ReadFile(filepath.Join(restored, "gateway", "runtime.json"))
	mustCloudState(t, err)
	var runtime map[string]bool
	mustCloudState(t, json.Unmarshal(raw, &runtime))
	if runtime[current.Computer.ID] {
		t.Fatal("snapshot mixed resumed runtime state with stopped home")
	}
	raw, err = os.ReadFile(filepath.Join(restored, "computers", id, "home", ".config", "settings"))
	mustCloudState(t, err)
	if string(raw) != "home from "+current.Computer.ID {
		t.Fatal("home belongs to a different computer")
	}
	raw, err = os.ReadFile(filepath.Join(restored, "configuration", "kitties.yaml"))
	mustCloudState(t, err)
	original, err := os.ReadFile(a.configPath)
	mustCloudState(t, err)
	if !bytes.Equal(raw, original) {
		t.Fatal("active configuration source missing from recovery")
	}
	raw, err = os.ReadFile(filepath.Join(restored, "manifest.json"))
	mustCloudState(t, err)
	var manifest struct {
		Version  int                 `json:"version"`
		Previous []*kitty.Kitty      `json:"previous_kitties"`
		Homes    []computer.Recovery `json:"homes"`
	}
	mustCloudState(t, json.Unmarshal(raw, &manifest))
	if manifest.Version != 1 || len(manifest.Previous) != 1 || manifest.Previous[0].Availability != computer.Enabled || len(manifest.Homes) != 1 || manifest.Homes[0].Computer.CheckpointID != current.Computer.CheckpointID {
		t.Fatal("recovery manifest lost original intent or checkpoint identity")
	}
}

func TestRecoveryCaptureResumesComputersWhenExportOrSnapshotFails(t *testing.T) {
	for _, failure := range []string{"export", "snapshot", "manifest", "configuration-read", "configuration-directory", "configuration-write"} {
		t.Run(failure, func(t *testing.T) {
			a, f, id := captureApp(t, t.TempDir())
			stage := t.TempDir()
			switch failure {
			case "export":
				f.exportErr = errors.New("verified chunk checksum failed")
			case "snapshot":
				mustCloudState(t, os.Symlink("/missing", filepath.Join(a.cfg.DataDirOr(), "unsafe-link")))
			case "manifest":
				mustCloudState(t, os.Mkdir(filepath.Join(stage, "manifest.json"), 0o700))
			case "configuration-read":
				a.configPath = t.TempDir()
			case "configuration-directory":
				mustCloudState(t, os.WriteFile(filepath.Join(stage, "configuration"), nil, 0o600))
			case "configuration-write":
				mustCloudState(t, os.MkdirAll(filepath.Join(stage, "configuration", "kitties.yaml"), 0o700))
			}
			if err := a.captureRecovery(context.Background(), stage, true, tar.NewWriter(io.Discard)); err == nil {
				t.Fatal("incomplete recovery reported successful")
			}
			current, err := a.fleet.Get(id)
			mustCloudState(t, err)
			if current.Status != kitty.StatusRunning || current.Availability != computer.Enabled || a.fleet.Admission().Active() {
				t.Fatalf("failed capture left source unavailable: %+v", current)
			}
		})
	}
}

func TestRecoveryCaptureDefersBusyWorkAndAllowsMissingConfig(t *testing.T) {
	a, _, id := captureApp(t, t.TempDir())
	release, err := a.fleet.Acquire(context.Background(), id)
	mustCloudState(t, err)
	if err = a.captureRecovery(context.Background(), t.TempDir(), true, tar.NewWriter(io.Discard)); err == nil {
		t.Fatal("automatic capture interrupted admitted work")
	}
	release()
	a.configPath = filepath.Join(t.TempDir(), "missing.yaml")
	mustCloudState(t, a.captureRecovery(context.Background(), t.TempDir(), true, tar.NewWriter(io.Discard)))
}
