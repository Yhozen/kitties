//go:build !linux && !darwin

package statelock

import (
	"errors"
	"os"
)

func lock(*os.File) error {
	return errors.New("cloud gateway state locking requires Linux or macOS; run the gateway on a Linux host")
}
