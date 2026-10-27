//go:build linux || darwin

package statelock

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestLockExcludesAnotherWriterAndSurvivesOwnerCrash(t *testing.T) {
	if dir := os.Getenv("KITTIES_TEST_LOCK_CHILD"); dir != "" {
		lock, err := Acquire(dir)
		if err != nil {
			t.Fatal(err)
		}
		defer lock.Close()
		fmt.Println("locked")
		time.Sleep(time.Minute)
		return
	}
	dir := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestLockExcludesAnotherWriterAndSurvivesOwnerCrash$")
	child.Env = append(os.Environ(), "KITTIES_TEST_LOCK_CHILD="+dir)
	stdout, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil || line != "locked\n" {
		t.Fatalf("child did not acquire lock: %q %v", line, err)
	}
	if lock, err := Acquire(dir); !errors.Is(err, ErrLocked) {
		if lock != nil {
			_ = lock.Close()
		}
		t.Fatalf("second writer accepted: %v", err)
	}
	if err := child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = child.Wait()
	lock, err := Acquire(dir)
	if err != nil {
		t.Fatalf("crashed process left a stale lock: %v", err)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestStateLockRejectsUnusableDataDirectories(t *testing.T) {
	file := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Acquire(filepath.Join(file, "state")); err == nil {
		t.Fatal("accepted a data root below a file")
	}
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, ".gateway.lock"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := Acquire(dir); err == nil {
		t.Fatal("accepted an unusable lock inode")
	}
}
