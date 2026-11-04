package boat

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func inputGuest(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	work := filepath.Join(dir, "work")
	if err := os.Mkdir(work, 0700); err != nil {
		t.Fatal(err)
	}
	scripts := map[string]string{
		"sudo":      `while [ "$1" != -- ]; do shift; done; shift; exec "$@"`,
		"systemctl": `case "$1" in is-active) [ "$GUARD_MODE" != inactive ];; show) if [ "$GUARD_MODE" = zero-pid ]; then echo 0; else echo 123; fi;; *) exit 1;; esac`,
		"stat": `[ "$GUARD_MODE" != stat-failure ] || exit 1
case "$*" in */proc/*) if [ "$GUARD_MODE" = stale-cwd ]; then echo 1:retired; else echo 1:current; fi;; *) echo 1:current;; esac`,
		"kitty-ready":  `[ "$GUARD_MODE" != not-ready ]`,
		"input-action": `printf 'dispatched\n'; printf '%s\000' "$@"; cat`,
	}
	for name, body := range scripts {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\nset -eu\n"+body+"\n"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return work
}

func TestPreparedGuestGuardRejectsStaleDesktopBeforeInput(t *testing.T) {
	for _, mode := range []string{"inactive", "zero-pid", "stale-cwd", "stat-failure", "not-ready", "ready"} {
		t.Run(mode, func(t *testing.T) {
			work := inputGuest(t)
			m, _, ref, _ := preparedBoundary(t)
			payload := "stdin ' $(do-not-execute)\nsecond line\n"
			args := []string{"input-action", "space argument", "literal;not-code", "quote'\"\nline"}
			m.command = func(ctx context.Context, name string, sshArgs ...string) *exec.Cmd {
				if name != "ssh" {
					t.Fatal("unexpected process", name)
				}
				remote := sshArgs[len(sshArgs)-1]
				if strings.Contains(remote, payload) {
					t.Fatal("text entered argv")
				}
				// Adapt only the fixed guest workspace path to the local fixture.
				remote = strings.ReplaceAll(remote, "/home/kitty/work", work)
				return exec.CommandContext(ctx, "sh", "-c", remote)
			}
			r, err := m.lookup(ref.ID)
			if err != nil {
				t.Fatal(err)
			}
			r.Env = map[string]string{"GUARD_MODE": mode}
			if err := m.put(r); err != nil {
				t.Fatal(err)
			}
			out, err := m.ExecPreparedInput(context.Background(), ref, payload, args...)
			if mode != "ready" {
				if err == nil || strings.Contains(out, "dispatched") {
					t.Fatalf("unhealthy desktop injected input: %q %v", out, err)
				}
				return
			}
			want := "dispatched\n" + strings.Join(args[1:], "\x00") + "\x00" + payload
			if err != nil || out != want {
				t.Fatalf("literal argv/stdin did not survive the guard: %q %v", out, err)
			}
		})
	}
}
