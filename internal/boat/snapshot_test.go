package boat

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
)

type archiveFile struct {
	name, body, link string
	kind             byte
}

func snapshotArchive(t *testing.T, files ...archiveFile) []byte {
	t.Helper()
	var b bytes.Buffer
	w := tar.NewWriter(&b)
	for _, f := range files {
		if f.kind == 0 {
			f.kind = tar.TypeReg
		}
		h := &tar.Header{Name: snapshotHome + "/" + f.name, Typeflag: f.kind, Mode: 0600, Linkname: f.link}
		if f.kind == tar.TypeReg {
			h.Size = int64(len(f.body))
		}
		if err := w.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(w, f.body); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func snapshotHarness(t *testing.T, archives [][]byte, inventory []inventoryEntry, change func(*snapshotDownload)) (*Manager, record) {
	t.Helper()
	m, _ := testManager(t, fixture())
	r := record{CheckpointID: "final"}
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch req.URL.Path {
		case "/snapshots/final/download":
			if req.Header.Get("Authorization") != "Bearer test-key" {
				t.Error("missing API authorization")
			}
			d := snapshotDownload{SnapshotID: "final"}
			for i, data := range archives {
				sum := sha256.Sum256(data)
				d.Chunks = append(d.Chunks, snapshotChunk{SnapshotID: string(rune('a' + i)), Generation: i, Index: 0, Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:]), URL: server.URL + "/chunk/" + string(rune('a'+i))})
			}
			if change != nil {
				change(&d)
			}
			_ = json.NewEncoder(w).Encode(d)
		case "/snapshots/final/tree":
			_ = json.NewEncoder(w).Encode(map[string]any{"entries": inventory})
		default:
			if req.Header.Get("Authorization") != "" {
				t.Error("gateway credential leaked to signed download")
			}
			i := int(req.URL.Path[len(req.URL.Path)-1] - 'a')
			if i < 0 || i >= len(archives) {
				http.NotFound(w, req)
				return
			}
			_, _ = w.Write(archives[i])
		}
	}))
	t.Cleanup(server.Close)
	m.baseURL = server.URL
	m.command = func(ctx context.Context, _ string, _ ...string) *exec.Cmd { return exec.CommandContext(ctx, "cat") }
	return m, r
}
func homeEntry(name, kind string, size int64) inventoryEntry {
	return inventoryEntry{Path: snapshotHome + "/" + name, Kind: kind, Size: size}
}
func TestSnapshotExportUsesLatestPathsAndFinalInventory(t *testing.T) {
	old := snapshotArchive(t, archiveFile{name: "keep", body: "old"}, archiveFile{name: "deleted", body: "gone"}, archiveFile{name: "untouched", body: "original"})
	latest := snapshotArchive(t, archiveFile{name: "keep", body: "new"}, archiveFile{name: "link", kind: tar.TypeSymlink, link: "keep"}, archiveFile{name: "hard", kind: tar.TypeLink, link: snapshotHome + "/keep"})
	entries := []inventoryEntry{homeEntry("keep", "file", 3), homeEntry("untouched", "file", 8), homeEntry("link", "symlink", 0), homeEntry("hard", "file", 3)}
	m, r := snapshotHarness(t, [][]byte{old, latest}, entries, nil)
	var out bytes.Buffer
	if err := m.bundleExportHome(context.Background(), r, &out); err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	tr := tar.NewReader(&out)
	for {
		h, e := tr.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			t.Fatal(e)
		}
		body, e := io.ReadAll(tr)
		if e != nil {
			t.Fatal(e)
		}
		got[h.Name] = string(body)
		if h.Name == "link" && h.Linkname != "keep" {
			t.Fatal(h)
		}
		if h.Name == "hard" && (h.Typeflag != tar.TypeLink || h.Linkname != "keep") {
			t.Fatal(h)
		}
	}
	if len(got) != 4 || got["keep"] != "new" || got["untouched"] != "original" {
		t.Fatalf("wrong reconstructed home: %v", got)
	}
}
func TestSnapshotExportRejectsIncompleteOrTamperedChains(t *testing.T) {
	archive := snapshotArchive(t, archiveFile{name: "file", body: "abc"})
	tests := []struct {
		name    string
		entries []inventoryEntry
		change  func(*snapshotDownload)
		want    string
	}{
		{"identity", []inventoryEntry{homeEntry("file", "file", 3)}, func(d *snapshotDownload) { d.SnapshotID = "other" }, "incomplete"},
		{"empty", nil, nil, "no kitty home"},
		{"duplicate", []inventoryEntry{homeEntry("file", "file", 3), homeEntry("file", "file", 3)}, nil, "duplicate"},
		{"symlink parent", []inventoryEntry{homeEntry("file", "symlink", 0), homeEntry("file/child", "file", 0)}, nil, "non-directory"},
		{"missing file", []inventoryEntry{homeEntry("missing", "file", 1)}, nil, "missing 1"},
		{"wrong size", []inventoryEntry{homeEntry("file", "file", 4)}, nil, "size or kind"},
		{"checksum", []inventoryEntry{homeEntry("file", "file", 3)}, func(d *snapshotDownload) { d.Chunks[0].SHA256 = strings.Repeat("0", 64) }, "SHA-256"},
		{"malformed checksum", []inventoryEntry{homeEntry("file", "file", 3)}, func(d *snapshotDownload) { d.Chunks[0].SHA256 = strings.Repeat("z", 64) }, "checksum is invalid"},
		{"oversized chunk", []inventoryEntry{homeEntry("file", "file", 3)}, func(d *snapshotDownload) { d.Chunks[0].Size = maxSnapshotChunk + 1 }, "512 MiB"},
		{"missing chunk", []inventoryEntry{homeEntry("file", "file", 3)}, func(d *snapshotDownload) { d.Chunks[0].Index = 1 }, "missing or duplicate"},
		{"insecure URL", []inventoryEntry{homeEntry("file", "file", 3)}, func(d *snapshotDownload) { d.Chunks[0].URL = "http://untrusted.example/chunk" }, "HTTPS"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m, r := snapshotHarness(t, [][]byte{archive}, tt.entries, tt.change)
			if err := m.bundleExportHome(context.Background(), r, io.Discard); err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("got %v; want %s", err, tt.want)
			}
		})
	}
}
func TestSnapshotExportRejectsUnsafeHardLinksAndTypes(t *testing.T) {
	for _, tt := range []struct {
		name    string
		files   []archiveFile
		entries []inventoryEntry
		want    string
	}{
		{"outside", []archiveFile{{name: "link", kind: tar.TypeLink, link: "etc/shadow"}}, []inventoryEntry{homeEntry("link", "file", 1)}, "outside"},
		{"missing target", []archiveFile{{name: "link", kind: tar.TypeLink, link: snapshotHome + "/absent"}}, []inventoryEntry{homeEntry("link", "file", 1)}, "absent"},
		{"cycle", []archiveFile{{name: "a", kind: tar.TypeLink, link: snapshotHome + "/b"}, {name: "b", kind: tar.TypeLink, link: snapshotHome + "/a"}}, []inventoryEntry{homeEntry("a", "file", 1), homeEntry("b", "file", 1)}, "cyclic"},
		{"special", []archiveFile{{name: "fifo", kind: tar.TypeFifo}}, []inventoryEntry{homeEntry("fifo", "file", 0)}, "unsupported"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			m, r := snapshotHarness(t, [][]byte{snapshotArchive(t, tt.files...)}, tt.entries, nil)
			if err := m.bundleExportHome(context.Background(), r, io.Discard); err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("got %v", err)
			}
		})
	}
}
func sealedFrame(t *testing.T, data, key []byte, id string) []byte {
	t.Helper()
	block, e := aes.NewCipher(key)
	if e != nil {
		t.Fatal(e)
	}
	aead, e := cipher.NewGCM(block)
	if e != nil {
		t.Fatal(e)
	}
	nonce := make([]byte, 12)
	sealed := aead.Seal(nil, nonce, data, []byte("snapshot-frame:"+id))
	var out bytes.Buffer
	out.WriteString("ASCENC1")
	_ = binary.Write(&out, binary.LittleEndian, uint32(len(sealed)))
	out.Write(nonce)
	out.Write(sealed)
	return out.Bytes()
}
func TestSnapshotEncryptionAuthenticatesEachFrameInPlace(t *testing.T) {
	key := bytes.Repeat([]byte{3}, 32)
	encoded := base64.StdEncoding.EncodeToString(key)
	frame := sealedFrame(t, []byte("first"), key, "a")
	two := append(append([]byte{}, frame...), sealedFrame(t, []byte("second"), key, "a")...)
	var out bytes.Buffer
	if e := copySnapshotChunk(&out, bytes.NewReader(two), encoded, "a"); e != nil || out.String() != "firstsecond" {
		t.Fatalf("%q %v", out.String(), e)
	}
	for _, tt := range []struct {
		name          string
		data          []byte
		key, id, want string
	}{
		{"missing key", frame, "", "a", "valid 256-bit"}, {"wrong source", frame, encoded, "b", "authentication"}, {"short frame", frame[:len(frame)-1], encoded, "a", "unexpected EOF"}, {"empty", []byte("ASCENC1"), encoded, "a", "EOF"}, {"too large", append([]byte("ASCENC1"), 0, 0, 0, 5), encoded, "a", "frame size"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			e := copySnapshotChunk(io.Discard, bytes.NewReader(tt.data), tt.key, tt.id)
			if e == nil || !strings.Contains(e.Error(), tt.want) {
				t.Fatalf("got %v", e)
			}
		})
	}
}

type rejectingWriter struct{}

func (rejectingWriter) Write([]byte) (int, error) { return 0, errors.New("sink closed") }
func TestSnapshotExportSinkFailureAndCancellationReapDecoder(t *testing.T) {
	archive := snapshotArchive(t, archiveFile{name: "file", body: "abc"})
	m, r := snapshotHarness(t, [][]byte{archive}, []inventoryEntry{homeEntry("file", "file", 3)}, nil)
	if err := m.bundleExportHome(context.Background(), r, rejectingWriter{}); err == nil {
		t.Fatal("accepted broken destination")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := m.bundleExportHome(ctx, r, io.Discard); !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
}

func TestSnapshotDecodeFailuresNeverSucceedWithPartialOutput(t *testing.T) {
	for _, mode := range []string{"missing decoder", "decoder failed", "corrupt tar", "tree malformed", "tree truncated", "tree unavailable"} {
		t.Run(mode, func(t *testing.T) {
			data := snapshotArchive(t, archiveFile{name: "file", body: "abc"})
			if mode == "corrupt tar" {
				data = []byte("not tar")
			}
			m, r := snapshotHarness(t, [][]byte{data}, []inventoryEntry{homeEntry("file", "file", 3)}, nil)
			if mode == "missing decoder" {
				m.command = func(c context.Context, _ string, _ ...string) *exec.Cmd {
					return exec.CommandContext(c, "/nonexistent/decoder")
				}
			}
			if mode == "decoder failed" {
				m.command = func(c context.Context, _ string, _ ...string) *exec.Cmd {
					return exec.CommandContext(c, "sh", "-c", "cat >/dev/null; echo decoder-failed >&2; exit 2")
				}
			}
			if strings.HasPrefix(mode, "tree") {
				old := m.baseURL
				s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
					if strings.HasSuffix(q.URL.Path, "/tree") {
						switch mode {
						case "tree malformed":
							_, _ = w.Write([]byte("{"))
						case "tree truncated":
							_, _ = w.Write([]byte(`{"truncated":true}`))
						case "tree unavailable":
							http.Error(w, "unavailable", 503)
						}
						return
					}
					request, _ := http.NewRequest("GET", old+q.URL.Path, nil)
					request.Header.Set("Authorization", "Bearer test-key")
					resp, e := http.DefaultClient.Do(request)
					if e != nil {
						t.Error(e)
						return
					}
					defer resp.Body.Close()
					_, _ = io.Copy(w, resp.Body)
				}))
				defer s.Close()
				m.baseURL = s.URL
			}
			if e := m.bundleExportHome(context.Background(), r, io.Discard); e == nil {
				t.Fatal("accepted incomplete archive")
			}
		})
	}
}
func TestSnapshotPreservesDirectoryMetadataButRejectsKindMismatch(t *testing.T) {
	for _, kind := range []string{"dir", "file"} {
		t.Run(kind, func(t *testing.T) {
			m, r := snapshotHarness(t, [][]byte{snapshotArchive(t, archiveFile{name: ".", kind: tar.TypeDir})}, []inventoryEntry{homeEntry(".", kind, 0)}, nil)
			e := m.bundleExportHome(context.Background(), r, io.Discard)
			if (e == nil) != (kind == "dir") {
				t.Fatalf("got %v", e)
			}
		})
	}
	if got := cleanPAX(map[string]string{"path": "unsafe", "linkpath": "unsafe", "GNU.sparse.major": "1", "SCHILY.xattr.user.note": "kept"}); len(got) != 1 || got["SCHILY.xattr.user.note"] != "kept" {
		t.Fatal(got)
	}
}
func TestSnapshotSignedDownloadFailsWithoutLeakingAuthorization(t *testing.T) {
	f := fixture()
	m, _ := testManager(t, f)
	for _, raw := range []string{"https://user:pass@example.com/chunk", "http://example.com/chunk", "not-a-url"} {
		if e := m.feedChunk(context.Background(), t.TempDir(), snapshotChunk{URL: raw}, "", io.Discard); e == nil {
			t.Fatal("invalid URL accepted")
		}
	}
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("API token forwarded")
		}
		http.Error(w, "expired", 403)
	}))
	m.baseURL = s.URL
	if e := m.feedChunk(context.Background(), t.TempDir(), snapshotChunk{URL: s.URL}, "", io.Discard); e == nil || !strings.Contains(e.Error(), "403") {
		t.Fatal(e)
	}
	s.Close()
	if e := m.feedChunk(context.Background(), t.TempDir(), snapshotChunk{URL: s.URL}, "", io.Discard); e == nil || strings.Contains(e.Error(), s.URL) {
		t.Fatalf("transport leaked signed URL: %v", e)
	}
}
