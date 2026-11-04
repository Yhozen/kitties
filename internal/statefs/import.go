package statefs

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/madkoding/kitties/internal/statelock"
)

// Import restores a recovery directory into a fresh, exclusively owned cloud
// state service. It never replaces an existing manifest. Uploaded blobs become
// authoritative together in one revision after every file has been verified.
func Import(ctx context.Context, source, endpoint string) error {
	if active.Load() != nil {
		return errors.New("close active remote state before importing recovery")
	}
	s, err := newStore(source, endpoint)
	if err != nil {
		return err
	}
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("recovery source must be a directory")
	}
	lock, err := statelock.Acquire(source)
	if err != nil {
		return err
	}
	defer lock.Close()
	writeGate.Lock()
	defer writeGate.Unlock()
	manifest, err := s.manifest(ctx)
	if err != nil {
		return err
	}
	if manifest.Revision != 0 || len(manifest.Files) != 0 {
		return errors.New("recovery import requires a fresh empty cloud state service")
	}
	var mutations []Mutation
	err = filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if path == source {
			return nil
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if reserved(rel) {
			return nil
		}
		if !validPath(rel) {
			return errors.New("invalid recovery path")
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return errors.New("recovery import refuses links and special files")
		}
		parts, err := s.uploadFile(ctx, path)
		if err != nil {
			return err
		}
		mutations = append(mutations, Mutation{Op: "put", Path: rel, Mode: uint32(info.Mode().Perm()), Parts: parts})
		return nil
	})
	if err != nil {
		return err
	}
	if len(mutations) == 0 {
		return errors.New("recovery source contains no files")
	}
	return s.importFiles(ctx, mutations)
}
