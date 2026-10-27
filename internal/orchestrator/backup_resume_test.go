package orchestrator

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/madkoding/kitties/internal/computer"
	"github.com/madkoding/kitties/internal/kitty"
)

func TestBackupResumeIntentSurvivesAbruptReloadAndRetriesWithoutNewComputer(t *testing.T) {
	for _, interruption := range []string{"before-stop", "during-stop", "during-export", "during-resume"} {
		t.Run(interruption, func(t *testing.T) {
			ctx := context.Background()
			cfg := testConfig(t)
			f := &exportingComputer{remoteComputer: newRemote(), export: func(context.Context, string, io.Writer) error { return errors.New("stream interrupted") }}
			m, err := New(cfg, WithContainers(f, nil))
			if err != nil {
				t.Fatal(err)
			}
			k, err := m.Create(ctx, Spec{Name: "mimi"})
			if err != nil {
				t.Fatal(err)
			}
			if err = m.Start(ctx, k.ID); err != nil {
				t.Fatal(err)
			}
			switch interruption {
			case "before-stop":
				if err = m.setBackupResume(k.ID, true); err != nil {
					t.Fatal(err)
				}
			case "during-stop":
				f.fail = "stop"
				if err = m.sleepForBackup(ctx, k.ID); err == nil {
					t.Fatal("stop should fail")
				}
			default:
				owned, leave, err := m.BeginMaintenance(ctx, true)
				if err != nil {
					t.Fatal(err)
				}
				_, resume, captureErr := m.CaptureHomesTo(owned, func(_ string, stream func(io.Writer) error) error { return stream(io.Discard) })
				if captureErr == nil {
					t.Fatal("export should fail")
				}
				if interruption == "during-resume" {
					f.fail = "start"
					if err = resume(); err == nil {
						t.Fatal("resume should fail")
					}
				}
				// Discarding the resume closure models termination before deferred cleanup can run.
				leave()
			}
			m.Close()
			f.fail = ""
			m, err = New(cfg, WithContainers(f, nil))
			if err != nil {
				t.Fatal(err)
			}
			defer m.Close()
			current, _ := m.Get(k.ID)
			if !current.ResumeAfterBackup {
				t.Fatal("restart lost backup resume intent")
			}
			if _, _, err = m.BeginMaintenance(ctx, true); err == nil {
				t.Fatal("new backup replaced incomplete recovery")
			}
			m.now = func() time.Time { return time.Now().Add(time.Hour) }
			f.calls = nil
			restored := 0
			m.Check(ctx, func(*kitty.Kitty, string) { restored++ }, t.Logf)
			current, _ = m.Get(k.ID)
			if restored != 1 || current.Status != kitty.StatusRunning || current.Availability != computer.Enabled || current.ResumeAfterBackup || current.Operation.Kind != "" {
				t.Fatalf("recovery state: %+v, restored=%d", current, restored)
			}
			for _, call := range f.calls {
				if call == "up" || strings.HasPrefix(call, "exec") {
					t.Fatalf("recovery allocated a replacement or replayed work: %s", call)
				}
			}
			m.Close()
			m, err = New(cfg, WithContainers(f, nil))
			if err != nil {
				t.Fatal(err)
			}
			defer m.Close()
			f.calls = nil
			m.Check(ctx, func(*kitty.Kitty, string) { t.Error("completed recovery replayed") }, t.Logf)
			if len(f.calls) != 1 || f.calls[0] != "list" {
				t.Fatalf("reloaded completed recovery changed runtime: %v", f.calls)
			}
		})
	}
}

func TestExplicitLifecycleSupersedesInterruptedBackupResume(t *testing.T) {
	for _, action := range []string{"stop", "sleep", "remove", "async-stop", "async-sleep", "failed-resume-stop"} {
		t.Run(action, func(t *testing.T) {
			m, f, id := cloudFleet(t)
			if err := m.sleepForBackup(context.Background(), id); err != nil {
				t.Fatal(err)
			}
			if action == "failed-resume-stop" {
				f.fail = "start"
				if err := m.resumeBackup(context.Background(), id); err == nil {
					t.Fatal("resume should fail")
				}
				f.fail = ""
			}
			switch action {
			case "stop":
				if err := m.Stop(context.Background(), id); err != nil {
					t.Fatal(err)
				}
			case "sleep":
				if err := m.Sleep(context.Background(), id); err != nil {
					t.Fatal(err)
				}
			case "remove":
				if err := m.Remove(context.Background(), id); err != nil {
					t.Fatal(err)
				}
			default:
				requested := strings.TrimPrefix(action, "async-")
				if action == "failed-resume-stop" {
					requested = "stop"
				}
				if _, err := m.LifecycleInBackground(id, requested); err != nil {
					t.Fatal(err)
				}
				m.backgroundWG.Wait()
			}
			f.calls = nil
			m.Check(context.Background(), func(*kitty.Kitty, string) { t.Error("manual intent was undone") }, t.Logf)
			if action == "remove" {
				if _, err := m.Get(id); !errors.Is(err, ErrNotFound) {
					t.Fatal("removed kitty returned")
				}
				return
			}
			k, _ := m.Get(id)
			if k.ResumeAfterBackup || k.Status == kitty.StatusRunning {
				t.Fatalf("manual intent lost: %+v", k)
			}
		})
	}
}

func TestSleepingComputerDoesNotGainBackupResumeIntent(t *testing.T) {
	m, _, id := cloudFleet(t)
	if err := m.Sleep(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if err := m.sleepForBackup(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if err := m.resumeBackup(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	k, _ := m.Get(id)
	if k.ResumeAfterBackup || k.Status != kitty.StatusSleeping {
		t.Fatal("backup woke a deliberately sleeping computer")
	}
}

func TestStartupWatchdogResumesBackupBeforeFirstPeriodicCheck(t *testing.T) {
	m, _, id := cloudFleet(t)
	if err := m.sleepForBackup(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	restored := make(chan struct{}, 1)
	go func() {
		defer close(done)
		m.Watch(ctx, time.Hour, func(*kitty.Kitty, string) { restored <- struct{}{} }, t.Logf)
	}()
	select {
	case <-restored:
	case <-time.After(time.Second):
		t.Fatal("startup waited for periodic watchdog before recovery")
	}
	cancel()
	<-done
	k, _ := m.Get(id)
	if k.ResumeAfterBackup || k.Status != kitty.StatusRunning {
		t.Fatalf("startup recovery incomplete: %+v", k)
	}
}
