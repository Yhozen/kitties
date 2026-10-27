package backup

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type archiveEntry struct {
	name, link, body string
	kind             byte
}

func tarFixture(t *testing.T, entries ...archiveEntry) []byte {
	t.Helper()
	var output bytes.Buffer
	writer := tar.NewWriter(&output)
	for _, entry := range entries {
		kind := entry.kind
		if kind == 0 {
			kind = tar.TypeReg
		}
		header := &tar.Header{Name: entry.name, Linkname: entry.link, Typeflag: kind, Mode: 0o600, Size: int64(len(entry.body))}
		if kind == tar.TypeDir {
			header.Mode = 0o700
		}
		if kind != tar.TypeReg {
			header.Size = 0
		}
		if err := writer.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if kind == tar.TypeReg {
			if _, err := writer.Write([]byte(entry.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}
func TestHomeArchiveRebasesFilesAndLinksWithoutStaging(t *testing.T) {
	source := tarFixture(t, archiveEntry{name: ".", kind: tar.TypeDir}, archiveEntry{name: ".config", kind: tar.TypeDir}, archiveEntry{name: ".config/settings", body: "state"}, archiveEntry{name: "link", link: ".config/settings", kind: tar.TypeSymlink}, archiveEntry{name: "hard", link: ".config/settings", kind: tar.TypeLink})
	var output bytes.Buffer
	writer := tar.NewWriter(&output)
	if err := AppendTar(context.Background(), writer, bytes.NewReader(source), "computers/mimi/home"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := ExtractArchive(context.Background(), bytes.NewReader(output.Bytes()), dir); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{".config/settings", "link", "hard"} {
		raw, err := os.ReadFile(filepath.Join(dir, "computers/mimi/home", file))
		if err != nil || string(raw) != "state" {
			t.Fatalf("link/content lost: %s %q %v", file, raw, err)
		}
	}
}
func TestArchiveRejectsTraversalAndNeverFollowsLinks(t *testing.T) {
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "file"), []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	cases := [][]archiveEntry{
		{{name: "../escape", body: "unsafe"}},
		{{name: "/absolute", body: "unsafe"}},
		{{name: "bad\\name", body: "unsafe"}},
		{{name: "fifo", kind: tar.TypeFifo}},
		{{name: "link", link: outside, kind: tar.TypeSymlink}, {name: "link/escaped", body: "unsafe"}},
		{{name: "link", link: outside, kind: tar.TypeSymlink}, {name: "link", kind: tar.TypeDir}},
		{{name: "hard", link: "../escape", kind: tar.TypeLink}},
		{{name: "hard", link: "missing", kind: tar.TypeLink}},
		{{name: "file", body: "saved"}, {name: "link", link: "file", kind: tar.TypeSymlink}, {name: "hard", link: "link", kind: tar.TypeLink}},
		{{name: "link", link: outside, kind: tar.TypeSymlink}, {name: "hard", link: "link/file", kind: tar.TypeLink}},
		{{name: "dir", kind: tar.TypeDir}, {name: "hard", link: "dir", kind: tar.TypeLink}},
		{{name: "same", body: "one"}, {name: "same", body: "two"}},
	}
	for i, entries := range cases {
		if err := ExtractArchive(context.Background(), bytes.NewReader(tarFixture(t, entries...)), t.TempDir()); err == nil {
			t.Errorf("accepted unsafe archive %d", i)
		}
	}
	if _, err := os.Stat(filepath.Join(outside, "escaped")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("wrote through archive symlink")
	}
	for _, entries := range [][]archiveEntry{{{name: "../escape", body: "bad"}}, {{name: "hard", link: "../escape", kind: tar.TypeLink}}, {{name: "fifo", kind: tar.TypeFifo}}} {
		writer := tar.NewWriter(io.Discard)
		if err := AppendTar(context.Background(), writer, bytes.NewReader(tarFixture(t, entries...)), "home"); err == nil {
			t.Fatal("unsafe guest archive accepted")
		}
	}
}

type brokenArchiveWriter struct{}

func (brokenArchiveWriter) Write([]byte) (int, error) { return 0, errors.New("storage unavailable") }
func TestArchivePropagatesCancellationCorruptionAndStorageFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	valid := tarFixture(t, archiveEntry{name: "file", body: "value"})
	if err := AppendTar(ctx, tar.NewWriter(io.Discard), bytes.NewReader(valid), "home"); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if err := ExtractArchive(ctx, bytes.NewReader(valid), t.TempDir()); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	for _, broken := range [][]byte{[]byte("corrupt"), valid[:515]} {
		if err := AppendTar(context.Background(), tar.NewWriter(io.Discard), bytes.NewReader(broken), "home"); err == nil {
			t.Fatal("corrupt home accepted")
		}
		if err := ExtractArchive(context.Background(), bytes.NewReader(broken), t.TempDir()); err == nil {
			t.Fatal("corrupt recovery accepted")
		}
	}
	if err := AppendTar(context.Background(), tar.NewWriter(brokenArchiveWriter{}), bytes.NewReader(valid), "home"); err == nil {
		t.Fatal("ignored upload failure")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "state"), []byte("state"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := AppendDirectory(ctx, tar.NewWriter(io.Discard), dir); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if err := AppendDirectory(context.Background(), tar.NewWriter(brokenArchiveWriter{}), dir); err == nil {
		t.Fatal("ignored archive writer failure")
	}
	if err := AppendDirectory(context.Background(), tar.NewWriter(io.Discard), filepath.Join(dir, "missing")); err == nil {
		t.Fatal("accepted missing capture")
	}
	if err := os.Symlink("state", filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	if err := AppendDirectory(context.Background(), tar.NewWriter(io.Discard), dir); err == nil {
		t.Fatal("gateway symlink accepted")
	}
}
func TestMetadataOnlyRestoreSkipsLargeComputerEntries(t *testing.T) {
	data := tarFixture(t, archiveEntry{name: "computers/mimi/home/data", body: strings.Repeat("x", 2<<20)}, archiveEntry{name: "gateway/settings.json", body: "saved"})
	dir := t.TempDir()
	if err := extractArchive(context.Background(), bytes.NewReader(data), dir, func(name string) bool { return !strings.HasPrefix(name, "computers/") }); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "computers")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("metadata recovery staged full homes")
	}
}

// replaceDestination swaps the path after extraction has opened its destination,
// before the archive's first entry is read.
type replaceDestination struct {
	io.Reader
	replace func()
}

func (r *replaceDestination) Read(p []byte) (int, error) {
	if r.replace != nil {
		r.replace()
		r.replace = nil
	}
	return r.Reader.Read(p)
}

func TestArchiveKeepsOpenedDestinationWhenPathIsReplaced(t *testing.T) {
	parent := t.TempDir()
	destination := filepath.Join(parent, "restore")
	moved := filepath.Join(parent, "moved")
	outside := t.TempDir()
	if err := os.Mkdir(destination, 0o700); err != nil {
		t.Fatal(err)
	}
	archive := tarFixture(t,
		archiveEntry{name: "dir", kind: tar.TypeDir},
		archiveEntry{name: "dir/file", body: "saved"},
		archiveEntry{name: "hard", link: "dir/file", kind: tar.TypeLink},
		archiveEntry{name: "link", link: "dir/file", kind: tar.TypeSymlink},
	)
	reader := &replaceDestination{Reader: bytes.NewReader(archive), replace: func() {
		if err := os.Rename(destination, moved); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, destination); err != nil {
			t.Fatal(err)
		}
	}}
	err := ExtractArchive(context.Background(), reader, destination)
	entries, readErr := os.ReadDir(outside)
	if readErr != nil || len(entries) != 0 {
		t.Fatalf("extraction escaped its opened destination: %v %v", entries, readErr)
	}
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"dir/file", "hard", "link"} {
		got, err := os.ReadFile(filepath.Join(moved, name))
		if err != nil || string(got) != "saved" {
			t.Fatalf("opened destination lost %s: %q %v", name, got, err)
		}
	}
}
