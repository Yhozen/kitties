package boat

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/madkoding/kitties/internal/computer"
)

const preparedInputGuard = `set -eu
systemctl is-active --quiet kitties-desktop.service
pid=$(systemctl show --property=MainPID --value kitties-desktop.service)
case "$pid" in ''|0|*[!0-9]*) exit 1 ;; esac
desktop_cwd=$(stat -Lc '%d:%i' "/proc/$pid/cwd")
workspace=$(stat -Lc '%d:%i' /home/kitty/work)
test "$desktop_cwd" = "$workspace"
kitty-ready
exec "$@"`

// ExecPreparedInput requires the caller's same-computer lifecycle gate and an
// active control grant. It validates this exact identity without restoring it.
func (m *Manager) ExecPreparedInput(ctx context.Context, expected computer.Reference, stdin string, argv ...string) (string, error) {
	if len(argv) == 0 || argv[0] == "" {
		return "", errors.New("a prepared input command is required")
	}
	if err := m.lockLifecycle(ctx); err != nil {
		return "", err
	}
	locked := true
	defer func() {
		if locked {
			<-m.lifecycle
		}
	}()
	r, err := m.lookup(expected.ID)
	if err != nil {
		return "", err
	}
	current := computer.Reference{Runtime: "boat", ID: r.RemoteID, OwnerID: m.ownerID, Generation: r.Generation, CheckpointID: r.CheckpointID}
	if expected != current || r.Removed || r.Template || r.Pending != nil || !remoteIDPattern.MatchString(r.RemoteID) {
		return "", errors.New("prepared Boat identity is no longer available")
	}
	if _, err := guestArgs(r, false, argv); err != nil {
		return "", err
	}
	if err := m.guardGeneration(ctx, r); err != nil {
		return "", err
	}
	s, err := m.get(ctx, r.RemoteID)
	if err != nil {
		return "", err
	}
	if !s.Hydrated || s.DataExpiredAt != "" {
		return "", errors.New("prepared Boat desktop is not hydrated or has expired")
	}
	guarded := append([]string{"sh", "-c", preparedInputGuard, "sh"}, argv...)
	cmd, err := m.sshCommandForSandbox(ctx, r, s, false, false, guarded...)
	if err != nil {
		return "", err
	}
	cmd.Stdin = strings.NewReader(stdin)
	var stdout bytes.Buffer
	stderr := &boundedBuffer{limit: 32 << 10}
	cmd.Stdout, cmd.Stderr = &stdout, stderr
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("Boat prepared input: %w", err)
	}
	<-m.lifecycle
	locked = false
	if err := cmd.Wait(); err != nil {
		return stdout.String(), fmt.Errorf("Boat prepared input: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}
