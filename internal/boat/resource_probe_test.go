package boat

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// Run separately from the unit suite when validating a gateway memory budget.
// Preparation is a separate process so fixture construction is not measured.
func TestSnapshotResourceProbe(t *testing.T) {
	mode := os.Getenv("KITTIES_SNAPSHOT_PROBE")
	if mode == "" {
		t.Skip("opt-in 512 MiB resource probe")
	}
	dir := os.Getenv("KITTIES_SNAPSHOT_PROBE_DIR")
	if dir == "" {
		t.Fatal("probe directory required")
	}
	name := filepath.Join(dir, "encrypted-512m.chunk")
	key := bytes.Repeat([]byte{7}, 32)
	if mode == "prepare" {
		f, e := os.Create(name)
		if e != nil {
			t.Fatal(e)
		}
		defer f.Close()
		frame := sealedFrame(t, make([]byte, (64<<20)-16), key, "resource-probe")
		for i := 0; i < 7; i++ {
			if _, e = f.Write(frame); e != nil {
				t.Fatal(e)
			}
		}
		last := sealedFrame(t, make([]byte, (64<<20)-200), key, "resource-probe")
		if _, e = f.Write(last); e != nil {
			t.Fatal(e)
		}
		return
	}
	f, e := os.Open(name)
	if e != nil {
		t.Fatal(e)
	}
	hash := sha256.New()
	n, e := io.Copy(hash, f)
	f.Close()
	if e != nil || n != maxSnapshotChunk {
		t.Fatalf("fixture %d %v", n, e)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		file, e := os.Open(name)
		if e != nil {
			t.Error(e)
			return
		}
		defer file.Close()
		_, _ = io.Copy(w, file)
	}))
	defer server.Close()
	m, _ := testManager(t, fixture())
	m.baseURL = server.URL
	if e = m.feedChunk(context.Background(), t.TempDir(), snapshotChunk{SnapshotID: "resource-probe", Size: n, SHA256: hex.EncodeToString(hash.Sum(nil)), URL: server.URL}, base64.StdEncoding.EncodeToString(key), io.Discard); e != nil {
		t.Fatal(e)
	}
}
