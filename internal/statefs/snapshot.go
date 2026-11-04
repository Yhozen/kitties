package statefs

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Snapshot copies one committed state revision into an empty backup directory.
// Callers first drain agent work and lifecycle operations. Writes are frozen
// only while making this copy, never while uploading the encrypted backup.
func Snapshot(ctx context.Context, source, destination string) error {
	source, err := filepath.Abs(source)
	if err != nil {
		return err
	}
	destination, err = filepath.Abs(destination)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(source, destination)
	if err != nil || rel == "." || rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return errors.New("backup capture must be outside the live data directory")
	}
	entries, err := os.ReadDir(destination)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if len(entries) != 0 {
		return errors.New("backup capture directory must be empty")
	}
	if err := os.MkdirAll(destination, 0o700); err != nil {
		return err
	}
	writeGate.Lock()
	defer writeGate.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if s := active.Load(); s != nil && s.root == source {
		s.mu.Lock()
		defer s.mu.Unlock()
		manifest, err := s.manifest(ctx)
		if err != nil {
			return err
		}
		if manifest.Revision != s.revision {
			return errors.New("remote state revision changed outside the gateway")
		}
		seen := map[string]bool{}
		for _, file := range manifest.Files {
			if !validPath(file.Path) || reserved(file.Path) || seen[file.Path] || file.Mode&^uint32(0o777) != 0 {
				return errors.New("invalid remote backup manifest")
			}
			seen[file.Path] = true
			path := filepath.Join(destination, filepath.FromSlash(file.Path))
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				return err
			}
			out, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, os.FileMode(file.Mode))
			if err != nil {
				return err
			}
			for _, part := range file.Parts {
				if err = s.download(ctx, part, out); err != nil {
					break
				}
			}
			closeErr := out.Close()
			if err != nil {
				return err
			}
			if closeErr != nil {
				return closeErr
			}
		}
		return nil
	}
	return filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if reserved(rel) {
			return nil
		}
		target := filepath.Join(destination, filepath.FromSlash(rel))
		if entry.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("backup capture refuses non-regular file %s", rel)
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm())
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(out, in)
		closeErr := out.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	})
}
