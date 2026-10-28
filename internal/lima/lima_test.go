package lima

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/madkoding/kitties/internal/container"
)

func fakeLima(t *testing.T) *Manager {
	t.Helper()
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "limactl"), nil, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	t.Setenv("KITTIES_LIMA_HELPER", "1")
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	m := New(filepath.Join(t.TempDir(), "lima"))
	m.command = func(ctx context.Context, _ string, args ...string) *exec.Cmd {
		return exec.CommandContext(ctx, exe, append([]string{"-test.run=^TestLimaProcess$", "--"}, args...)...)
	}
	return m
}

func own(t *testing.T, m *Manager, name string) {
	t.Helper()
	if err := m.prepare(); err != nil {
		t.Fatal(err)
	}
	path, err := m.marker(name)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"kitty":"mimi"}`), 0o600); err != nil {
		t.Fatal(err)
	}
}

// TestLimaProcess is the external process boundary, not a fake implementation of Manager.
func TestLimaProcess(t *testing.T) {
	if os.Getenv("KITTIES_LIMA_HELPER") != "1" {
		return
	}
	args := os.Args[slices.Index(os.Args, "--")+1:]
	if args[0] != "--tty=false" {
		os.Exit(3)
	}
	args = args[1:]
	if os.Getenv("KITTIES_LIMA_FAIL") == args[0] {
		_, _ = os.Stderr.WriteString("provider command failed\n")
		os.Exit(19)
	}
	switch args[0] {
	case "create":
		data, _ := io.ReadAll(os.Stdin)
		if !strings.Contains(string(data), "mounts: []") {
			os.Exit(4)
		}
		name := args[slices.Index(args, "--name")+1]
		_ = os.MkdirAll(filepath.Join(os.Getenv("LIMA_HOME"), name), 0o700)
		if os.Getenv("KITTIES_LIMA_PARTIAL_CREATE") == "1" {
			os.Exit(20)
		}
	case "start", "stop", "delete":
	case "list":
		if os.Getenv("KITTIES_LIMA_BAD_INVENTORY") == "1" {
			fmt.Print("broken inventory")
			os.Exit(0)
		}
		status := "Running"
		if os.Getenv("KITTIES_LIMA_STOPPED") == "1" {
			status = "Stopped"
		}
		fmt.Printf("{\"name\":\"kitty-mimi\",\"status\":%q}\n", status)
		fmt.Println(`{"name":"kitty-unowned","status":"Stopped"}`)
		fmt.Println(`{"name":"personal","status":"Running"}`)
	case "shell":
		switch {
		case slices.Contains(args, "KITTY_DESKTOP_RESTART=1"):
			input, _ := io.ReadAll(os.Stdin)
			if path := os.Getenv("KITTIES_LIMA_UPGRADE"); path != "" {
				data, _ := json.Marshal(struct {
					Args  []string
					Input string
				}{args, string(input)})
				_ = os.WriteFile(path, data, 0o600)
			}
			if os.Getenv("KITTIES_LIMA_UPGRADE_FAIL") == "1" {
				os.Exit(21)
			}
		case slices.Contains(args, desktopReadyCommand):
			if path := os.Getenv("KITTIES_LIMA_READY_PROBES"); path != "" {
				data, _ := os.ReadFile(path)
				count, _ := strconv.Atoi(string(data))
				_ = os.WriteFile(path, []byte(strconv.Itoa(count+1)), 0o600)
				if count == 0 {
					_, _ = os.Stderr.WriteString("window manager is still starting\n")
					os.Exit(1)
				}
			}
		case slices.Contains(args, "capture-diagnostics"):
			_, _ = os.Stdout.WriteString("stdout\n")
			_, _ = os.Stderr.WriteString("stderr\n")
		case slices.Contains(args, "kitty-shot"):
			_, _ = os.Stderr.WriteString("SSH diagnostic\n")
			_, _ = os.Stdout.Write([]byte{137, 80, 78, 71, 0, 255})
		case slices.Contains(args, "kitty-stream"):
			_, _ = os.Stderr.WriteString("stream diagnostic\n")
			_ = container.WriteFrame(os.Stdout, []byte{0, 255, 128})
			if os.Getenv("KITTIES_LIMA_HUNG_STREAM") == "1" {
				time.Sleep(time.Minute)
			}
			_, _ = io.Copy(io.Discard, os.Stdin)
		case slices.Contains(args, "capture"):
			input, _ := io.ReadAll(os.Stdin)
			_ = json.NewEncoder(os.Stdout).Encode(struct {
				Args  []string
				Input string
				Home  string
				SSH   string
			}{args, string(input), os.Getenv("LIMA_HOME"), os.Getenv("SSH_AUTH_SOCK")})
		}
	default:
		os.Exit(5)
	}
	os.Exit(0)
}

func TestGuestBoundaryKeepsArgumentsLiteralAndInputOffCommandLine(t *testing.T) {
	m := fakeLima(t)
	own(t, m, "kitty-mimi")
	t.Setenv("LIMA_HOME", "/someone-elses-vms")
	t.Setenv("SSH_AUTH_SOCK", "/host-agent")
	payload := "$(touch /host); `whoami` ' \"\n"
	out, err := m.ExecInput(context.Background(), "kitty-mimi", "private-input", "capture", payload)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Args             []string
		Input, Home, SSH string
	}
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatal(err)
	}
	if result.Args[len(result.Args)-1] != payload || result.Input != "private-input" || slices.Contains(result.Args, "private-input") {
		t.Fatalf("argument/stdin boundary lost: %+v", result)
	}
	if result.Home != m.home || result.SSH != "" {
		t.Fatalf("host integration leaked: %+v", result)
	}
	if !slices.Contains(result.Args, "DISPLAY=:99") || !slices.Contains(result.Args, "kitty") {
		t.Fatalf("guest identity missing: %v", result.Args)
	}
	wantPrefix := []string{"shell", "--workdir", "/", "kitty-mimi", "sudo", "-n", "-H", "-u", "kitty", "sh", "-c", `cd /home/kitty/work && exec "$@"`, "--", "env", "--"}
	if !slices.Equal(result.Args[:len(wantPrefix)], wantPrefix) {
		t.Fatalf("private workspace must be entered after sudo: %v", result.Args)
	}
	out, err = m.Exec(context.Background(), "kitty-mimi", "capture-diagnostics")
	if err != nil || !strings.Contains(out, "stdout\n") || !strings.Contains(out, "stderr\n") {
		t.Fatalf("successful text command lost diagnostics: %q, %v", out, err)
	}
}

func TestOnlyOwnedInstancesCanBeExecutedOrDestroyed(t *testing.T) {
	m := fakeLima(t)
	for _, name := range []string{"personal", "kitty-unowned", "../kitty-mimi", "kitty-mimi --force"} {
		if err := m.Remove(context.Background(), name); err == nil {
			t.Fatalf("removed unowned %q", name)
		}
		if _, err := m.Exec(context.Background(), name, "true"); err == nil {
			t.Fatalf("executed in unowned %q", name)
		}
	}
	if _, err := m.Up(context.Background(), container.Spec{Name: "kitty-mimi", KittyName: "mimi"}); err != nil {
		t.Fatal(err)
	}
	infos, err := m.List(context.Background())
	if err != nil || len(infos) != 1 || infos[0].Name != "kitty-mimi" || !infos[0].Running {
		t.Fatalf("inventory = %+v, %v", infos, err)
	}
	if err := m.Stop(context.Background(), "kitty-mimi"); err != nil {
		t.Fatal(err)
	}
	if err := m.Remove(context.Background(), "kitty-mimi"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.owned("kitty-mimi"); err == nil {
		t.Fatal("deleted VM remains owned")
	}
}

func TestDisplayTransportPreservesBinaryOutputAndClosesProcess(t *testing.T) {
	m := fakeLima(t)
	own(t, m, "kitty-mimi")
	png, err := m.Screenshot(context.Background(), "kitty-mimi")
	if err != nil || !slices.Equal(png, []byte{137, 80, 78, 71, 0, 255}) {
		t.Fatalf("PNG corrupted: %q, %v", png, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	stream, err := m.Stream(ctx, "kitty-mimi", 8, 70)
	if err != nil {
		t.Fatal(err)
	}
	frame, err := container.ReadFrame(bufio.NewReader(stream))
	if err != nil || !slices.Equal(frame, []byte{0, 255, 128}) {
		t.Fatalf("frame corrupted: %q, %v", frame, err)
	}
	if err := stream.Close(); err != nil {
		t.Fatal(err)
	}
	if stream.(*displayStream).command.ProcessState == nil {
		t.Fatal("stream process was not reaped")
	}
	if err := stream.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestVMConfigurationSharesNoHostFilesOrCredentialSockets(t *testing.T) {
	config, err := configuration(container.Spec{Name: "kitty-mimi", Workspace: "/private/host/files", MemoryMB: 4096, CPUs: 2.5})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"mounts: []", "forwardAgent: false", "loadDotSSHPubKeys: false", "forwardX11: false", "ignore: true", "propagateProxyEnv: false", "cpus: 3", `memory: "4096MiB"`} {
		if !strings.Contains(config, want) {
			t.Errorf("missing isolation setting %q", want)
		}
	}
	if strings.Contains(config, "/private/host/files") {
		t.Fatal("host workspace was included in VM configuration")
	}
	if _, err := configuration(container.Spec{Name: "kitty-mimi", Network: "host"}); err == nil {
		t.Fatal("Docker network silently ignored")
	}
}

func TestMissingVMReservationCanRecoverWithoutConcurrentCreation(t *testing.T) {
	m := fakeLima(t)
	own(t, m, "kitty-mimi")
	unlock, err := m.lock("kitty-mimi")
	if err != nil {
		t.Fatal(err)
	}
	other := New(m.home)
	if release, err := other.lock("kitty-mimi"); err == nil {
		release()
		t.Fatal("another lifecycle operation acquired an owned lock")
	}
	unlock()
	if _, err := m.Up(context.Background(), container.Spec{Name: "kitty-mimi", KittyName: "mimi"}); err != nil {
		t.Fatalf("an owned reservation without a VM must be recoverable: %v", err)
	}
	own(t, m, "kitty-other")
	if _, err := m.Up(context.Background(), container.Spec{Name: "kitty-other", KittyName: "other"}); err == nil {
		t.Fatal("a reservation owned by a different kitty was overwritten")
	}
}

func TestStartWaitsForTheDisplayAndWindowManager(t *testing.T) {
	m := fakeLima(t)
	own(t, m, "kitty-mimi")
	probes := filepath.Join(t.TempDir(), "probes")
	t.Setenv("KITTIES_LIMA_READY_PROBES", probes)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.Start(ctx, "kitty-mimi"); err != nil {
		t.Fatalf("transient desktop startup failure was not retried: %v", err)
	}
	data, err := os.ReadFile(probes)
	if err != nil || string(data) != "2" {
		t.Fatalf("expected a readiness retry, got %q: %v", data, err)
	}
}

func TestFailedLifecycleKeepsEnoughOwnershipToRecover(t *testing.T) {
	for _, failure := range []string{"create", "partial-create", "start", "delete"} {
		t.Run(failure, func(t *testing.T) {
			m := fakeLima(t)
			spec := container.Spec{Name: "kitty-mimi", KittyName: "mimi"}
			if failure == "partial-create" {
				t.Setenv("KITTIES_LIMA_PARTIAL_CREATE", "1")
			} else {
				t.Setenv("KITTIES_LIMA_FAIL", failure)
			}
			_, err := m.Up(context.Background(), spec)
			if failure == "delete" {
				if err != nil {
					t.Fatal(err)
				}
				err = m.Remove(context.Background(), spec.Name)
			}
			if err == nil {
				t.Fatal("failed provider operation was acknowledged")
			}
			_, ownerErr := m.owned(spec.Name)
			if failure == "create" {
				if !errors.Is(ownerErr, os.ErrNotExist) {
					t.Fatalf("failed creation left an unusable reservation: %v", ownerErr)
				}
			} else if ownerErr != nil {
				t.Fatalf("recoverable VM lost ownership after failure: %v", ownerErr)
			}
		})
	}
}

func TestUnsafeProvisioningRequestsNeverCreateAnOwnershipReservation(t *testing.T) {
	m := fakeLima(t)
	for _, spec := range []container.Spec{
		{Name: "../escape"},
		{Name: "kitty-mimi", MemoryMB: -1},
		{Name: "kitty-mimi", CPUs: math.NaN()},
		{Name: "kitty-mimi", Env: map[string]string{"BAD=KEY": "value"}},
		{Name: "kitty-mimi", Env: map[string]string{"OK": "bad\x00value"}},
	} {
		if _, err := m.Up(context.Background(), spec); err == nil {
			t.Fatalf("unsafe spec was accepted: %+v", spec)
		}
	}
	if _, err := os.Stat(filepath.Join(m.home, "_kitties")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("rejected request changed ownership: %v", err)
	}
}

func TestSavedEnvironmentCannotOverrideGuestIdentity(t *testing.T) {
	m := fakeLima(t)
	if _, err := m.Up(context.Background(), container.Spec{Name: "kitty-mimi", KittyName: "mimi", Env: map[string]string{"DISPLAY": ":0", "KITTY_NAME": "someone-else", "TZ": "UTC", "CUSTOM": "a b; $(whoami)"}}); err != nil {
		t.Fatal(err)
	}
	out, err := m.Exec(context.Background(), "kitty-mimi", "capture")
	if err != nil {
		t.Fatal(err)
	}
	var got struct{ Args []string }
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"CUSTOM=a b; $(whoami)", "TZ=UTC", "DISPLAY=:99", "KITTY_NAME=mimi"} {
		if !slices.Contains(got.Args, value) {
			t.Fatalf("lost literal guest environment %q", value)
		}
	}
	if slices.Contains(got.Args, "DISPLAY=:0") || slices.Contains(got.Args, "KITTY_NAME=someone-else") {
		t.Fatal("environment overrode guest identity")
	}
	if _, err := m.Exec(context.Background(), "kitty-mimi"); err == nil {
		t.Fatal("empty execution was accepted")
	}
}

func TestExistingOrDamagedOwnershipCannotBeReplaced(t *testing.T) {
	m := fakeLima(t)
	own(t, m, "kitty-mimi")
	path, _ := m.marker("kitty-mimi")
	if err := os.WriteFile(path, []byte("corrupted ownership"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Up(context.Background(), container.Spec{Name: "kitty-mimi", KittyName: "mimi"}); err == nil {
		t.Fatal("corrupt ownership was overwritten")
	}
	own(t, m, "kitty-mimi")
	if err := os.MkdirAll(filepath.Join(m.home, "kitty-mimi"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Up(context.Background(), container.Spec{Name: "kitty-mimi", KittyName: "mimi"}); err == nil {
		t.Fatal("existing guest was replaced")
	}
	if err := m.Pull(context.Background(), "new-image"); err == nil {
		t.Fatal("persistent disk allowed image replacement")
	}
	stale, err := m.ImageStale(context.Background(), "kitty-mimi", "new-image")
	if err != nil || stale || m.Capabilities().ImageUpdates {
		t.Fatal("persistent disk scheduled automatic replacement")
	}
}

func TestReadinessCancellationAndHungViewerReleaseExternalProcesses(t *testing.T) {
	m := fakeLima(t)
	own(t, m, "kitty-mimi")
	probes := filepath.Join(t.TempDir(), "readiness-probes")
	t.Setenv("KITTIES_LIMA_READY_PROBES", probes)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := make(chan error, 1)
	go func() { started <- m.Start(ctx, "kitty-mimi") }()
	deadline := time.After(5 * time.Second)
	for {
		if _, err := os.Stat(probes); err == nil {
			break
		}
		select {
		case <-deadline:
			t.Fatal("desktop readiness was never probed")
		case <-time.After(10 * time.Millisecond):
		}
	}
	cancel()
	if err := <-started; !errors.Is(err, context.Canceled) {
		t.Fatalf("readiness ignored cancellation: %v", err)
	}
	if _, err := m.owned("kitty-mimi"); err != nil {
		t.Fatalf("cancelled readiness lost persistent guest: %v", err)
	}
	t.Setenv("KITTIES_LIMA_HUNG_STREAM", "1")
	stream, err := m.Stream(context.Background(), "kitty-mimi", 8, 70)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := container.ReadFrame(bufio.NewReader(stream)); err != nil {
		t.Fatal(err)
	}
	if err := stream.Close(); err != nil {
		t.Fatal(err)
	}
	if stream.(*displayStream).command.ProcessState == nil {
		t.Fatal("hung viewer process was not reaped")
	}
	if err := stream.(*displayStream).command.Cancel(); !errors.Is(err, os.ErrProcessDone) {
		t.Fatalf("cancel after exit: %v", err)
	}
}

func TestInventoryErrorsAndInvalidViewersCannotMasqueradeAsHealthy(t *testing.T) {
	m := fakeLima(t)
	own(t, m, "kitty-mimi")
	t.Setenv("KITTIES_LIMA_BAD_INVENTORY", "1")
	if _, err := m.List(context.Background()); err == nil {
		t.Fatal("malformed inventory was accepted")
	}
	t.Setenv("KITTIES_LIMA_FAIL", "list")
	if _, err := m.List(context.Background()); err == nil {
		t.Fatal("provider inventory failure was hidden")
	}
	if _, err := m.Stream(context.Background(), "kitty-mimi", 0, 70); err == nil {
		t.Fatal("invalid stream rate accepted")
	}
	if _, err := m.Stream(context.Background(), "kitty-unowned", 8, 70); err == nil {
		t.Fatal("unowned viewer accepted")
	}
	if _, err := m.Screenshot(context.Background(), "kitty-unowned"); err == nil {
		t.Fatal("unowned screenshot accepted")
	}
	if err := m.Start(context.Background(), "kitty-unowned"); err == nil {
		t.Fatal("unowned guest started")
	}
	if err := m.Stop(context.Background(), "kitty-unowned"); err == nil {
		t.Fatal("unowned guest stopped")
	}
}

func TestUnusableStateDirectoryFailsBeforeProviderExecution(t *testing.T) {
	m := fakeLima(t)
	m.home = "relative-state"
	if _, err := m.List(context.Background()); err == nil {
		t.Fatal("relative VM home accepted")
	}
	m.home = filepath.Join(t.TempDir(), "blocked")
	if err := os.WriteFile(m.home, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.Start(context.Background(), "kitty-mimi"); err == nil {
		t.Fatal("start used blocked state directory")
	}
	if err := m.Stop(context.Background(), "kitty-mimi"); err == nil {
		t.Fatal("stop used blocked state directory")
	}
	if _, err := m.Up(context.Background(), container.Spec{Name: "kitty-mimi"}); err == nil {
		t.Fatal("creation used blocked state directory")
	}
}

func TestDetectionReportsActualCommandFailure(t *testing.T) {
	bin := t.TempDir()
	path := filepath.Join(bin, "limactl")
	t.Setenv("PATH", bin)
	if err := os.WriteFile(path, []byte("#!/bin/sh\necho Lima test\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := Detect(context.Background()); err != nil {
		t.Fatalf("working CLI rejected: %v", err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\necho CLI-broken >&2\nexit 7\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := Detect(context.Background()); err == nil || !strings.Contains(err.Error(), "CLI-broken") {
		t.Fatalf("CLI failure lost diagnostic: %v", err)
	}
}

func TestFailedViewerLaunchDoesNotLeaveOpenPipes(t *testing.T) {
	m := fakeLima(t)
	own(t, m, "kitty-mimi")
	m.command = func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
		return exec.CommandContext(ctx, filepath.Join(t.TempDir(), "missing-cli"))
	}
	if stream, err := m.Stream(context.Background(), "kitty-mimi", 8, 70); err == nil || stream != nil {
		t.Fatal("failed viewer launch was acknowledged")
	}
}
