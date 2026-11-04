package keep

import (
	"errors"
	"fmt"
	"os"
	"strings"
)

// ValidateKey checks existing session backups without rewriting them.
func (s *Store) ValidateKey() error {
	entries, err := os.ReadDir(s.dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".bin") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Size() > Max+64 {
			return fmt.Errorf("session backup %s exceeds the maximum size", entry.Name())
		}
		id := strings.TrimSuffix(entry.Name(), ".bin")
		if _, _, err := s.Load(id); err != nil {
			return fmt.Errorf("cannot open session backup %s: %w", entry.Name(), err)
		}
	}
	return nil
}
