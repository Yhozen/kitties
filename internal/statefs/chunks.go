package statefs

import (
	"context"
	"errors"
	"io"
	"os"
)

// Compact append histories into fixed chunks so cold starts do not fetch one
// object per journal entry. Unchanged full chunks keep the same object identity.
func (s *Store) uploadFile(ctx context.Context, path string) ([]Part, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	buffer := make([]byte, 1<<20)
	var parts []Part
	for {
		count, err := io.ReadFull(file, buffer)
		if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, err
		}
		if count > 0 {
			part, uploadErr := s.upload(ctx, buffer[:count])
			if uploadErr != nil {
				return nil, uploadErr
			}
			parts = append(parts, part)
		}
		if err != nil {
			return parts, nil
		}
	}
}
