package backup

import (
	"archive/tar"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

func archivePath(name string) (string, error) {
	name = strings.TrimPrefix(name, "./")
	if name == "." || name == "" {
		return "", nil
	}
	if !fs.ValidPath(strings.TrimSuffix(name, "/")) || strings.Contains(name, "\\") || strings.HasPrefix(name, "/") {
		return "", errors.New("unsafe recovery archive path")
	}
	return strings.TrimSuffix(name, "/"), nil
}

// AppendTar rebases a streamed home archive into the single encrypted recovery archive.
func AppendTar(ctx context.Context, destination *tar.Writer, source io.Reader, prefix string) error {
	reader := tar.NewReader(source)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		name, err := archivePath(header.Name)
		if err != nil {
			return err
		}
		if name == "" {
			continue
		}
		copyHeader := *header
		copyHeader.Name = path.Join(prefix, name)
		copyHeader.PAXRecords = nil
		if header.Typeflag == tar.TypeLink {
			target, err := archivePath(header.Linkname)
			if err != nil || target == "" {
				return errors.New("unsafe recovery hard link")
			}
			copyHeader.Linkname = path.Join(prefix, target)
		}
		switch header.Typeflag {
		case tar.TypeReg, tar.TypeRegA, tar.TypeDir, tar.TypeSymlink, tar.TypeLink:
		default:
			return fmt.Errorf("unsupported recovery entry %q", header.Name)
		}
		if err = destination.WriteHeader(&copyHeader); err != nil {
			return err
		}
		if _, err = io.Copy(destination, reader); err != nil {
			return err
		}
	}
}
func AppendDirectory(ctx context.Context, writer *tar.Writer, root string) error {
	return filepath.WalkDir(root, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		rel, err := filepath.Rel(root, name)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.IsDir() && !info.Mode().IsRegular() {
			return errors.New("gateway capture contains a non-regular file")
		}
		header, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		header.Name = filepath.ToSlash(rel)
		if err = writer.WriteHeader(header); err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		file, err := os.Open(name)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(writer, file)
		return errors.Join(copyErr, file.Close())
	})
}

// ExtractArchive never follows an archive-created symlink or replaces an existing file.
func ExtractArchive(ctx context.Context, source io.Reader, destination string) error {
	return extractArchive(ctx, source, destination, nil)
}
func extractArchive(ctx context.Context, source io.Reader, destination string, include func(string) bool) error {
	root, err := os.OpenRoot(destination)
	if err != nil {
		return err
	}
	defer root.Close()
	directoryModes := map[string]os.FileMode{}
	reader := tar.NewReader(source)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			directories := make([]string, 0, len(directoryModes))
			for directory := range directoryModes {
				directories = append(directories, directory)
			}
			sort.Slice(directories, func(i, j int) bool { return len(directories[i]) > len(directories[j]) })
			for _, directory := range directories {
				file, err := root.Open(directory)
				if err != nil {
					return err
				}
				if err := errors.Join(file.Chmod(directoryModes[directory]), file.Close()); err != nil {
					return err
				}
			}
			return nil
		}
		if err != nil {
			return err
		}
		name, err := archivePath(header.Name)
		if err != nil {
			return err
		}
		if name == "" {
			continue
		}
		if include != nil && !include(name) {
			continue
		}
		target := filepath.FromSlash(name)
		parent := "."
		for _, component := range strings.Split(path.Dir(name), "/") {
			if component == "." {
				continue
			}
			parent = filepath.Join(parent, component)
			if err = root.Mkdir(parent, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
				return err
			}
			info, err := root.Lstat(parent)
			if err != nil {
				return err
			}
			if !info.IsDir() {
				return errors.New("recovery entry traverses a non-directory")
			}
		}
		switch header.Typeflag {
		case tar.TypeDir:
			directoryModes[target] = os.FileMode(header.Mode).Perm()
			if err = root.Mkdir(target, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
				return err
			}
			info, err := root.Lstat(target)
			if err != nil {
				return err
			}
			if !info.IsDir() {
				return errors.New("recovery directory conflicts with existing file")
			}
		case tar.TypeReg, tar.TypeRegA:
			file, err := root.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, os.FileMode(header.Mode).Perm())
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(file, reader)
			if err = errors.Join(copyErr, file.Close()); err != nil {
				return err
			}
		case tar.TypeSymlink:
			if err = root.Symlink(header.Linkname, target); err != nil {
				return err
			}
		case tar.TypeLink:
			linked, err := archivePath(header.Linkname)
			if err != nil || linked == "" {
				return errors.New("unsafe recovery hard link")
			}
			original := filepath.FromSlash(linked)
			info, err := root.Lstat(original)
			if err != nil {
				return err
			}
			if !info.Mode().IsRegular() {
				return errors.New("recovery hard link is not a regular file")
			}
			if err = root.Link(original, target); err != nil {
				return err
			}
		default:
			return errors.New("unsupported recovery archive entry")
		}
	}
}
