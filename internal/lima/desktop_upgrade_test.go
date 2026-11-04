package lima

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/madkoding/kitties/internal/guest"
)

func TestOnlyStoppedLimaGuestsReceiveDesktopUpgrades(t *testing.T) {
	for _, stopped := range []bool{false, true} {
		t.Run(map[bool]string{false: "running", true: "stopped"}[stopped], func(t *testing.T) {
			m := fakeLima(t)
			own(t, m, "kitty-mimi")
			capture := filepath.Join(t.TempDir(), "upgrade.json")
			t.Setenv("KITTIES_LIMA_UPGRADE", capture)
			if stopped {
				t.Setenv("KITTIES_LIMA_STOPPED", "1")
			}
			if err := m.Start(context.Background(), "kitty-mimi"); err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(capture)
			if !stopped {
				if !os.IsNotExist(err) {
					t.Fatalf("running guest received an upgrade: %s, %v", data, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var command struct {
				Args  []string
				Input string
			}
			if err := json.Unmarshal(data, &command); err != nil {
				t.Fatal(err)
			}
			want := []string{"shell", "--workdir", "/", "kitty-mimi", "sudo", "-n", "-H", "env", "KITTY_DESKTOP_RESTART=1", "bash", "-s"}
			if !slices.Equal(command.Args, want) || command.Input != guest.Script {
				t.Fatal("cold upgrade must run the current root payload over stdin")
			}
		})
	}
}

func TestFailedColdLimaUpgradeDoesNotAcknowledgeReadiness(t *testing.T) {
	m := fakeLima(t)
	own(t, m, "kitty-mimi")
	t.Setenv("KITTIES_LIMA_STOPPED", "1")
	t.Setenv("KITTIES_LIMA_UPGRADE_FAIL", "1")
	probes := filepath.Join(t.TempDir(), "probes")
	t.Setenv("KITTIES_LIMA_READY_PROBES", probes)
	if err := m.Start(context.Background(), "kitty-mimi"); err == nil {
		t.Fatal("failed upgrade acknowledged")
	}
	if _, err := os.Stat(probes); !os.IsNotExist(err) {
		t.Fatal("readiness checked after failed upgrade")
	}
	if _, err := m.owned("kitty-mimi"); err != nil {
		t.Fatal("failed upgrade lost the existing disk ownership")
	}
}

func TestInterruptedColdLimaUpgradeRetriesAfterGatewayRestart(t *testing.T) {
	m := fakeLima(t)
	own(t, m, "kitty-mimi")
	t.Setenv("KITTIES_LIMA_STOPPED", "1")
	t.Setenv("KITTIES_LIMA_UPGRADE_FAIL", "1")
	if err := m.Start(context.Background(), "kitty-mimi"); err == nil {
		t.Fatal("failed upgrade acknowledged")
	}
	owner, err := m.owned("kitty-mimi")
	if err != nil || !owner.DesktopUpgradePending {
		t.Fatalf("failed update lost pending cold intent: %+v %v", owner, err)
	}
	restarted := New(m.home)
	restarted.command = m.command
	t.Setenv("KITTIES_LIMA_STOPPED", "0")
	t.Setenv("KITTIES_LIMA_UPGRADE_FAIL", "0")
	capture := filepath.Join(t.TempDir(), "retry.json")
	t.Setenv("KITTIES_LIMA_UPGRADE", capture)
	if err := restarted.Start(context.Background(), "kitty-mimi"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(capture); err != nil {
		t.Fatal("running guest silently skipped the interrupted cold upgrade", err)
	}
	owner, err = restarted.owned("kitty-mimi")
	if err != nil || owner.DesktopUpgradePending {
		t.Fatalf("successful retry left cold intent: %+v %v", owner, err)
	}
	if err := os.Remove(capture); err != nil {
		t.Fatal(err)
	}
	if err := restarted.Start(context.Background(), "kitty-mimi"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(capture); !os.IsNotExist(err) {
		t.Fatal("subsequent warm Start reran the installer")
	}
}
