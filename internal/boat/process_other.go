//go:build !linux && !darwin

package boat

import (
	"errors"
	"os/exec"
)

func lockFile(string) (func(), error) {
	return nil, errors.New("the Boat gateway requires Linux or macOS")
}
func configureProcess(*exec.Cmd) {}
