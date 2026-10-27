// Package statelock holds exclusive ownership of a gateway's mutable data directory.
package statelock

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

var ErrLocked = errors.New("another gateway is using this data directory")

type Lock struct {
	file *os.File
	once sync.Once
	err  error
}

func Acquire(dir string) (*Lock, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(filepath.Join(dir, ".gateway.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := lock(file); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("lock %s: %w", dir, err)
	}
	return &Lock{file: file}, nil
}

// Close releases the kernel lock. The file remains in place so competing
// processes always lock the same inode, including after a crash.
func (l *Lock) Close() error {
	l.once.Do(func() { l.err = l.file.Close() })
	return l.err
}
