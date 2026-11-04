//go:build !linux && !darwin

package lima

import (
	"errors"
	"os/exec"
)

func configureProcess(*exec.Cmd) {}

func lockFile(string) (func(), error) {
	return nil, errors.New("Lima is only supported on macOS and Linux")
}
