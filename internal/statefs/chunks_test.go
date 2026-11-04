package statefs

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestJournalCompactionBoundsColdStartReadsAcrossRestarts(t *testing.T) {
	service, server := newStateService(t)
	root := filepath.Join(t.TempDir(), "cache")
	store := openTestState(t, root, server.URL)
	path := filepath.Join(root, "journal.jsonl")
	line := bytes.Repeat([]byte("a journal event\n"), 700)
	for i := 0; i < 127; i++ {
		must(t, AppendFile(path, line, 0600))
	}
	store.Close()
	store = openTestState(t, root, server.URL)
	must(t, AppendFile(path, line, 0600))
	service.mu.Lock()
	parts := len(service.manifest.Files[0].Parts)
	service.mu.Unlock()
	if parts > 2 {
		t.Fatalf("compaction lost across restart: %d objects", parts)
	}
	store.Close()
	fresh := filepath.Join(t.TempDir(), "restored")
	restored := openTestState(t, fresh, server.URL)
	defer restored.Close()
	data, err := os.ReadFile(filepath.Join(fresh, "journal.jsonl"))
	must(t, err)
	if !bytes.Equal(data, bytes.Repeat(line, 128)) {
		t.Fatal("compaction changed journal bytes")
	}
	if err := Snapshot(context.Background(), fresh, t.TempDir()); err != nil {
		t.Fatal(err)
	}
}
