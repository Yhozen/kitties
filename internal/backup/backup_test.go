package backup

import (
	"archive/tar"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/madkoding/kitties/internal/maintenance"
)

func TestResticRecoveryRoundTripIntoFreshHost(t *testing.T) {
	if _, err := exec.LookPath("restic"); err != nil {
		t.Skip("restic not installed")
	}
	repository := filepath.Join(t.TempDir(), "encrypted-repository")
	t.Setenv("RESTIC_REPOSITORY", repository)
	t.Setenv("RESTIC_PASSWORD", "fixture-backup-password")
	t.Setenv("RESTIC_CACHE_DIR", t.TempDir())
	t.Setenv("BOAT_DEV_API_KEY", "fixture-boat-secret")
	m, err := New(Options{DataDir: t.TempDir(), Capture: func(_ context.Context, dir string, _ bool) error {
		if err := os.MkdirAll(filepath.Join(dir, "gateway"), 0o700); err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(dir, "gateway", "kitties.json"), []byte(`{"original":"computer-reference"}`), 0o600)
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	if _, err = m.Trigger(); err != nil {
		t.Fatal(err)
	}
	m.wg.Wait()
	status := m.Status()
	if status.LastSuccess.IsZero() || status.SnapshotID == "" {
		t.Fatalf("backup failed: %+v", status)
	}
	destination := filepath.Join(t.TempDir(), "new-host")
	if err = Restore(context.Background(), status.SnapshotID, destination); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(destination, "gateway", "kitties.json"))
	if err != nil || string(raw) != `{"original":"computer-reference"}` {
		t.Fatalf("restore lost state: %q %v", raw, err)
	}
	raw, err = os.ReadFile(filepath.Join(destination, "bootstrap-secrets.json"))
	if err != nil {
		t.Fatal(err)
	}
	var secrets map[string]string
	if err = json.Unmarshal(raw, &secrets); err != nil {
		t.Fatal(err)
	}
	if secrets["BOAT_DEV_API_KEY"] != "fixture-boat-secret" || secrets["RESTIC_PASSWORD"] != "" || strings.Contains(string(raw), "fixture-backup-password") {
		t.Fatal("bootstrap secret scope changed")
	}
	if err = Restore(context.Background(), status.SnapshotID, destination); err == nil {
		t.Fatal("restore overwrote existing host data")
	}
	metadata := filepath.Join(t.TempDir(), "metadata")
	if id, err := RestoreGateway(context.Background(), "latest", metadata); err != nil || id != status.SnapshotID {
		t.Fatalf("metadata-only restore = %s %v", id, err)
	}
	if err = Restore(context.Background(), "deadbeef", filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("unknown snapshot accepted")
	}
}

func TestArchiveStreamsAsOneSnapshotWithScopedRetention(t *testing.T) {
	captured := false
	var commands [][]string
	m, err := New(Options{DataDir: t.TempDir(), Env: []string{"RESTIC_REPOSITORY=fixture", "RESTIC_PASSWORD=fixture"}, Capture: func(_ context.Context, dir string, _ bool) error {
		captured = true
		return os.WriteFile(filepath.Join(dir, "state"), []byte("immutable"), 0o600)
	}, Run: func(_ context.Context, dir string, _ []string, args ...string) ([]byte, error) {
		commands = append(commands, append([]string(nil), args...))
		if args[0] == "tag" {
			return []byte(`{"old_snapshot_id":"abcd","new_snapshot_id":"ef12"}`), nil
		}
		return nil, nil
	}, Stream: func(_ context.Context, _ string, _ []string, input io.Reader, args ...string) ([]byte, error) {
		commands = append(commands, append([]string(nil), args...))
		if _, err := io.Copy(io.Discard, input); err != nil {
			return nil, err
		}
		if !captured {
			t.Fatal("restic completed before consistent capture")
		}
		return []byte("{\"message_type\":\"summary\",\"snapshot_id\":\"abcd\"}\n"), nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	_, err = m.Trigger()
	if err != nil {
		t.Fatal(err)
	}
	m.wg.Wait()
	want := []string{"forget", "--host", Host, "--tag", Tag, "--group-by", "host,tags", "--keep-daily", "7", "--keep-weekly", "4", "--prune"}
	if len(commands) != 4 || !reflect.DeepEqual(commands[3], want) {
		t.Fatalf("unsafe retention scope: %v", commands)
	}
}

func TestBusyCaptureDefersAndFailuresBackOff(t *testing.T) {
	now := time.Date(2026, 10, 27, 3, 0, 0, 0, time.UTC)
	failure := error(maintenance.ErrBusy)
	m, err := New(Options{DataDir: t.TempDir(), Env: []string{"RESTIC_REPOSITORY=fixture", "RESTIC_PASSWORD=secret-password"}, Now: func() time.Time { return now }, Capture: func(context.Context, string, bool) error { return failure }, Run: func(context.Context, string, []string, ...string) ([]byte, error) { return nil, nil }, Stream: func(_ context.Context, _ string, _ []string, r io.Reader, _ ...string) ([]byte, error) {
		_, err := io.Copy(io.Discard, r)
		return nil, err
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	if err = m.launch(true); err != nil {
		t.Fatal(err)
	}
	m.wg.Wait()
	status := m.Status()
	if !status.LastFailure.IsZero() || !status.NextAttempt.Equal(now.Add(time.Minute)) || !status.Overdue {
		t.Fatalf("busy work counted as backup failure: %+v", status)
	}
	failure = errors.New("failed with secret-password")
	for i := 0; i < 2; i++ {
		if _, err = m.Trigger(); err != nil {
			t.Fatal(err)
		}
		m.wg.Wait()
	}
	status = m.Status()
	if status.Failures != 2 || strings.Contains(status.LastError, "secret-password") || !status.NextAttempt.Equal(now.Add(10*time.Minute)) {
		t.Fatalf("failure backoff or redaction broken: %+v", status)
	}
}

func successfulFixture(dataDir string) Options {
	return Options{DataDir: dataDir, Env: []string{"RESTIC_REPOSITORY=fixture", "RESTIC_PASSWORD=fixture"}, Capture: func(context.Context, string, bool) error { return nil }, Run: func(_ context.Context, _ string, _ []string, args ...string) ([]byte, error) {
		if args[0] == "tag" {
			return []byte(`{"old_snapshot_id":"abcd","new_snapshot_id":"ef12"}`), nil
		}
		return nil, nil
	}, Stream: func(_ context.Context, _ string, _ []string, r io.Reader, _ ...string) ([]byte, error) {
		_, err := io.Copy(io.Discard, r)
		return []byte(`{"message_type":"summary","snapshot_id":"abcd"}`), err
	}}
}

func TestBackupRefusesCorruptStatusAndRecoversInterruptedAttempt(t *testing.T) {
	for _, content := range []string{"invalid json", `{"running":true}`} {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "recovery-backups.json"), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		m, err := New(successfulFixture(dir))
		if content == "invalid json" {
			if err == nil {
				m.Close()
				t.Fatal("corrupt status accepted")
			}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		if m.Status().LastFailure.IsZero() || m.Status().Running {
			t.Fatal("interrupted attempt not reported")
		}
		m.Close()
	}
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "recovery-backups.json"), 0o700); err != nil {
		t.Fatal(err)
	}
	if m, err := New(successfulFixture(dir)); err == nil {
		m.Close()
		t.Fatal("unreadable status accepted")
	}
}

func TestBackupAdmissionAndSchedulerRespectShutdown(t *testing.T) {
	disabled, err := New(Options{DataDir: t.TempDir(), Env: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = disabled.Trigger(); err == nil {
		t.Fatal("unconfigured backup accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	disabled.Run(ctx)
	disabled.Close()
	options := successfulFixture(t.TempDir())
	entered, finish := make(chan struct{}), make(chan struct{})
	options.Capture = func(context.Context, string, bool) error { close(entered); <-finish; return nil }
	m, err := New(options)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel = context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { m.Run(ctx); close(done) }()
	<-entered
	if _, err = m.Trigger(); !errors.Is(err, maintenance.ErrBusy) {
		t.Fatal("overlapping backups accepted")
	}
	cancel()
	<-done
	close(finish)
	m.wg.Wait()
	m.Close()
	if _, err = m.Trigger(); err == nil {
		t.Fatal("backup started during shutdown")
	}
}

func TestIncompleteArchivesAreNeverPromoted(t *testing.T) {
	for _, failure := range []string{"capture", "stream", "summary", "promotion", "ack", "retention", "repository"} {
		t.Run(failure, func(t *testing.T) {
			options := successfulFixture(t.TempDir())
			promoted := false
			options.WriteCapture = func(_ context.Context, _ string, _ bool, w *tar.Writer) error {
				if err := w.WriteHeader(&tar.Header{Name: "partial", Mode: 0o600}); err != nil {
					return err
				}
				if failure == "capture" {
					return errors.New("source checksum failed")
				}
				return nil
			}
			options.Stream = func(_ context.Context, _ string, _ []string, r io.Reader, _ ...string) ([]byte, error) {
				_, _ = io.Copy(io.Discard, r)
				if failure == "stream" {
					return nil, errors.New("upload lost")
				}
				if failure == "summary" {
					return nil, nil
				}
				// A stdin consumer can acknowledge EOF despite the producer reporting failure.
				return []byte(`{"message_type":"summary","snapshot_id":"abcd"}`), nil
			}
			options.Run = func(_ context.Context, _ string, _ []string, args ...string) ([]byte, error) {
				if failure == "repository" && args[0] == "cat" {
					return nil, errors.New("repository unreachable")
				}
				if args[0] == "tag" {
					promoted = true
					if failure == "promotion" {
						return nil, errors.New("promotion failed")
					}
					if failure == "ack" {
						return nil, nil
					}
					return []byte(`{"old_snapshot_id":"abcd","new_snapshot_id":"ef12"}`), nil
				}
				if failure == "retention" && args[0] == "forget" {
					return nil, errors.New("retention failed")
				}
				return nil, nil
			}
			m, err := New(options)
			if err != nil {
				t.Fatal(err)
			}
			defer m.Close()
			if _, err = m.Trigger(); err != nil {
				t.Fatal(err)
			}
			m.wg.Wait()
			if m.Status().LastFailure.IsZero() || !m.Status().LastSuccess.IsZero() {
				t.Fatal("failed recovery reported successful")
			}
			if (failure == "capture" || failure == "stream" || failure == "summary" || failure == "repository") && promoted {
				t.Fatal("partial backup promoted to recoverable")
			}
		})
	}
}

func TestBackupRequiresWritableStatusAndCaptureSource(t *testing.T) {
	for _, failure := range []string{"directory", "temporary"} {
		t.Run(failure, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "state")
			m, err := New(successfulFixture(dir))
			if err != nil {
				t.Fatal(err)
			}
			defer m.Close()
			if failure == "directory" {
				if err = os.WriteFile(dir, nil, 0o600); err != nil {
					t.Fatal(err)
				}
			} else {
				if err = os.Mkdir(dir, 0o700); err != nil {
					t.Fatal(err)
				}
				if err = os.Mkdir(filepath.Join(dir, "recovery-backups.json.tmp"), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			if _, err = m.Trigger(); err == nil {
				t.Fatal("started without durable backup status")
			}
		})
	}
	options := successfulFixture(t.TempDir())
	options.Capture = nil
	m, err := New(options)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	if _, err = m.captureAndUpload(context.Background(), true); err == nil {
		t.Fatal("accepted missing capture provider")
	}
	if len(m.redact(strings.Repeat("x", 2000))) > 1000 {
		t.Fatal("unbounded diagnostics")
	}
	for _, args := range [][2]string{{"../bad", t.TempDir()}, {"latest", "relative"}} {
		if err = Restore(context.Background(), args[0], args[1]); err == nil {
			t.Fatal("unsafe restore accepted")
		}
	}
}
