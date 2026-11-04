package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestVMDemoProviderInspectionNeedsNoComputer(t *testing.T) {
	t.Setenv("KITTIES_DATA_DIR", t.TempDir())
	t.Setenv("KITTIES_CONFIG", filepath.Join(t.TempDir(), "missing.yaml"))
	if code, out, diagnostic := exec(t, "", "-vm-demo", "providers"); code != 0 || !strings.Contains(out, "demo/scripted") {
		t.Fatalf("inspect VM demo without allocating a machine: %d %s %s", code, out, diagnostic)
	}
	for _, args := range [][]string{{"-vm-demo", "-demo", "providers"}, {"-vm-demo", "-config", "example.yaml", "providers"}} {
		if code, _, _ := exec(t, "", args...); code != 2 {
			t.Fatalf("ambiguous VM demo flags accepted: %v", args)
		}
	}
}

func TestVMDemoKeepsItsStateSeparateFromTheConfiguredFleet(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("Lima requires macOS or Linux")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("KITTIES_DATA_DIR", "")
	configured := filepath.Join(home, "existing-fleet")
	path := filepath.Join(home, "kitties.yaml")
	if err := os.WriteFile(path, []byte("data_dir: "+configured+"\ncontainers:\n  runtime: docker\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KITTIES_CONFIG", path)
	limaCLIForInspection(t, "case \"$1\" in --version) echo 'limactl version 2.0.0';; *) exit 64;; esac\n")
	if code, out, diagnostic := exec(t, "", "-vm-demo", "ls"); code != 0 || !strings.Contains(out, "no kitties yet") || !strings.Contains(diagnostic, "VM demo") || strings.Contains(diagnostic, "brain-only") {
		t.Fatalf("VM demo did not select Lima: %d %s %s", code, out, diagnostic)
	}
	if _, err := os.Stat(filepath.Join(home, ".kitties-lima-demo")); err != nil {
		t.Fatalf("VM demo has no isolated state: %v", err)
	}
	if _, err := os.Stat(configured); !os.IsNotExist(err) {
		t.Fatalf("VM demo touched the configured fleet: %v", err)
	}
}

func TestUnavailableLimaFailsBeforeCreatingAVMDemoKitty(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("Lima requires macOS or Linux")
	}
	directory := t.TempDir()
	t.Setenv("KITTIES_DATA_DIR", directory)
	t.Setenv("KITTIES_CONFIG", filepath.Join(t.TempDir(), "missing.yaml"))
	limaCLIForInspection(t, "echo 'fixture Lima unavailable' >&2\nexit 17\n")
	if code, out, diagnostic := exec(t, "", "-vm-demo", "create", "mimi"); code != 1 || out != "" || !strings.Contains(diagnostic, "Lima does not answer") || strings.Contains(diagnostic, "brain-only") {
		t.Fatalf("unavailable Lima silently changed runtime: %d %s %s", code, out, diagnostic)
	}
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 0 {
		t.Fatalf("failed runtime detection created fleet state: %v %v", entries, err)
	}
}

func limaCLIForInspection(t *testing.T, body string) {
	t.Helper()
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "limactl"), []byte("#!/bin/sh\nset -eu\n"+body), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
}
