package statefs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/madkoding/kitties/internal/statelock"
)

type stateService struct {
	importID    string
	importNext  int
	importFiles []Mutation

	mu          sync.Mutex
	manifest    Manifest
	blobs       map[string][]byte
	commits     map[string]int64
	commitIDs   []string
	loseACK     bool
	unavailable bool
	failWrites  bool
	corrupt     bool
}

func newStateService(t *testing.T) (*stateService, *httptest.Server) {
	t.Helper()
	service := &stateService{blobs: map[string][]byte{}, commits: map[string]int64{}}
	server := httptest.NewServer(http.HandlerFunc(service.serve))
	t.Cleanup(server.Close)
	return service, server
}
func (s *stateService) serve(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.unavailable || s.failWrites && r.Method == "PUT" {
		http.Error(w, "unavailable", 503)
		return
	}
	switch {
	case r.URL.Path == "/v1/manifest":
		json.NewEncoder(w).Encode(s.manifest)
	case strings.HasPrefix(r.URL.Path, "/v1/blob/"):
		hash := strings.TrimPrefix(r.URL.Path, "/v1/blob/")
		if r.Method == "PUT" {
			data, _ := io.ReadAll(r.Body)
			sum := sha256.Sum256(data)
			if hex.EncodeToString(sum[:]) != hash {
				http.Error(w, "checksum", 400)
				return
			}
			s.blobs[hash] = data
			w.WriteHeader(204)
			return
		}
		if s.corrupt {
			w.Write([]byte("corrupt"))
			return
		}
		data, ok := s.blobs[hash]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(data)

	case strings.HasPrefix(r.URL.Path, "/v1/import/"):
		var input struct {
			ID        string     `json:"id"`
			Index     int        `json:"index"`
			Mutations []Mutation `json:"mutations"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			http.Error(w, "json", 400)
			return
		}
		switch strings.TrimPrefix(r.URL.Path, "/v1/import/") {
		case "begin":
			if s.manifest.Revision != 0 || s.importID != "" && s.importID != input.ID {
				http.Error(w, "occupied", 409)
				return
			}
			s.importID = input.ID
			_ = json.NewEncoder(w).Encode(map[string]int{"next": s.importNext})
		case "batch":
			if input.ID != s.importID || input.Index > s.importNext || len(input.Mutations) > 256 {
				http.Error(w, "invalid batch", 409)
				return
			}
			if input.Index == s.importNext {
				s.importFiles = append(s.importFiles, input.Mutations...)
				s.importNext++
			}
			_ = json.NewEncoder(w).Encode(map[string]int{"next": s.importNext})
		case "finalize":
			if input.ID != s.importID {
				http.Error(w, "invalid import", 409)
				return
			}
			if s.manifest.Revision == 0 {
				for _, m := range s.importFiles {
					s.manifest.Files = append(s.manifest.Files, File{Path: m.Path, Mode: m.Mode, Parts: m.Parts})
				}
				s.manifest.Revision = 1
			}
			if s.loseACK {
				s.loseACK = false
				connection, _, err := w.(http.Hijacker).Hijack()
				if err == nil {
					connection.Close()
				}
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]int64{"revision": 1})
		default:
			http.NotFound(w, r)
		}
	case r.URL.Path == "/v1/commit":
		var c commit
		if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
			http.Error(w, "json", 400)
			return
		}
		s.commitIDs = append(s.commitIDs, c.ID)
		if revision, ok := s.commits[c.ID]; ok {
			json.NewEncoder(w).Encode(map[string]int64{"revision": revision})
			return
		}
		if c.BaseRevision != s.manifest.Revision {
			http.Error(w, "stale", 409)
			return
		}
		for _, m := range c.Mutations {
			var existing *File
			for i := range s.manifest.Files {
				if s.manifest.Files[i].Path == m.Path {
					existing = &s.manifest.Files[i]
					break
				}
			}
			switch m.Op {
			case "put":
				file := File{Path: m.Path, Mode: m.Mode, Parts: m.Parts}
				if existing != nil {
					*existing = file
				} else {
					s.manifest.Files = append(s.manifest.Files, file)
				}
			case "append":
				if existing != nil {
					existing.Parts = append(existing.Parts, m.Parts...)
				} else {
					s.manifest.Files = append(s.manifest.Files, File{Path: m.Path, Mode: m.Mode, Parts: m.Parts})
				}
			case "delete":
				kept := s.manifest.Files[:0]
				for _, f := range s.manifest.Files {
					if f.Path == m.Path || m.Recursive && strings.HasPrefix(f.Path, m.Path+"/") {
						continue
					}
					kept = append(kept, f)
				}
				s.manifest.Files = kept
			}
		}
		s.manifest.Revision++
		s.commits[c.ID] = s.manifest.Revision
		if s.loseACK {
			s.loseACK = false
			connection, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				connection.Close()
			}
			return
		}
		json.NewEncoder(w).Encode(map[string]int64{"revision": s.manifest.Revision})
	default:
		http.NotFound(w, r)
	}
}
func openTestState(t *testing.T, root, endpoint string) *Store {
	t.Helper()
	store, err := Open(context.Background(), root, endpoint)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)
	return store
}
func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestRemoteStateSurvivesFreshCacheAndPreservesFileContracts(t *testing.T) {
	service, server := newStateService(t)
	root := filepath.Join(t.TempDir(), "state")
	store := openTestState(t, root, server.URL)
	must(t, WriteFile(filepath.Join(root, "vault.key"), []byte("original-key"), 0o600))
	must(t, WriteFile(filepath.Join(root, "settings.json.tmp"), []byte(`{"v":1}`), 0o600))
	if store.revision != 1 {
		t.Fatal("temporary file was published")
	}
	must(t, Rename(filepath.Join(root, "settings.json.tmp"), filepath.Join(root, "settings.json")))
	must(t, AppendFile(filepath.Join(root, "journal.jsonl"), []byte("one\n"), 0o600))
	must(t, AppendFile(filepath.Join(root, "journal.jsonl"), []byte("two\n"), 0o600))
	must(t, os.MkdirAll(filepath.Join(root, "artifacts"), 0o700))
	must(t, WriteFile(filepath.Join(root, "artifacts", "example.tmp.tmp"), []byte("legitimate temp-named artifact"), 0o600))
	must(t, Rename(filepath.Join(root, "artifacts", "example.tmp.tmp"), filepath.Join(root, "artifacts", "example.tmp")))
	must(t, WriteFile(filepath.Join(root, "discard"), []byte("remove"), 0o600))
	must(t, Remove(filepath.Join(root, "discard")))
	must(t, os.WriteFile(filepath.Join(root, "ssh-private"), []byte("generated-private"), 0o600))
	must(t, os.WriteFile(filepath.Join(root, "ssh-public"), []byte("generated-public"), 0o644))
	before := store.revision
	must(t, Publish(filepath.Join(root, "ssh-private"), filepath.Join(root, "ssh-public")))
	if store.revision != before+1 {
		t.Fatal("external key pair was not committed atomically")
	}
	store.Close()
	fresh := filepath.Join(t.TempDir(), "new-image-state")
	restored := openTestState(t, fresh, server.URL)
	for file, want := range map[string]string{"vault.key": "original-key", "settings.json": `{"v":1}`, "journal.jsonl": "one\ntwo\n", "artifacts/example.tmp": "legitimate temp-named artifact", "ssh-private": "generated-private"} {
		data, err := os.ReadFile(filepath.Join(fresh, file))
		must(t, err)
		if string(data) != want {
			t.Fatalf("%s restored %q", file, data)
		}
	}
	info, err := os.Stat(filepath.Join(fresh, "vault.key"))
	must(t, err)
	if info.Mode().Perm() != 0o600 {
		t.Fatal("secret permissions lost")
	}
	if _, err := os.Stat(filepath.Join(fresh, "discard")); !os.IsNotExist(err) {
		t.Fatal("deleted file returned")
	}
	if _, err := statelock.Acquire(fresh); err == nil {
		t.Fatal("hydrated cache is not exclusively owned")
	}
	must(t, RemoveAll(filepath.Join(fresh, "artifacts")))
	restored.Close()
	service.mu.Lock()
	defer service.mu.Unlock()
	for _, file := range service.manifest.Files {
		if strings.HasPrefix(file.Path, "artifacts/") {
			t.Fatal("recursive deletion not durable")
		}
	}
}

func TestLostCommitAcknowledgementRetriesSameRequest(t *testing.T) {
	service, server := newStateService(t)
	root := filepath.Join(t.TempDir(), "state")
	store := openTestState(t, root, server.URL)
	service.mu.Lock()
	service.loseACK = true
	service.mu.Unlock()
	must(t, WriteFile(filepath.Join(root, "boat.json"), []byte("remote ID"), 0o600))
	service.mu.Lock()
	defer service.mu.Unlock()
	if len(service.commitIDs) != 2 || service.commitIDs[0] != service.commitIDs[1] || store.revision != 1 || service.manifest.Revision != 1 {
		t.Fatalf("ambiguous commit retried unsafely: %+v", service.commitIDs)
	}
}

func TestRemoteWriteFailureCannotBeIgnored(t *testing.T) {
	if endpoint := os.Getenv("KITTIES_TEST_STATE_ENDPOINT"); endpoint != "" {
		root := os.Getenv("KITTIES_TEST_STATE_ROOT")
		_, err := Open(context.Background(), root, endpoint)
		if err != nil {
			t.Fatal(err)
		}
		// Even net/http's panic recovery must not let this process keep running.
		handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_ = WriteFile(filepath.Join(root, "pending.json"), []byte("before external action"), 0o600)
			_ = os.WriteFile(filepath.Join(root, "external-effect"), []byte("unsafe"), 0o600)
		})
		local := httptest.NewServer(handler)
		_, _ = http.Get(local.URL)
		t.Fatal("gateway continued after durability failure")
		return
	}
	service, server := newStateService(t)
	service.mu.Lock()
	service.failWrites = true
	service.mu.Unlock()
	root := filepath.Join(t.TempDir(), "child-state")
	cmd := exec.Command(os.Args[0], "-test.run=^TestRemoteWriteFailureCannotBeIgnored$")
	cmd.Env = append(os.Environ(), "KITTIES_TEST_STATE_ENDPOINT="+server.URL, "KITTIES_TEST_STATE_ROOT="+root)
	out, err := cmd.CombinedOutput()
	if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 1 {
		t.Fatalf("durability failure did not stop process: %v %s", err, out)
	}
	if !strings.Contains(string(out), "durable gateway state unavailable") {
		t.Fatalf("unexpected failure: %s", out)
	}
	if _, err := os.Stat(filepath.Join(root, "external-effect")); !os.IsNotExist(err) {
		t.Fatal("external action ran after persistence failed")
	}
}

func TestHydrationRejectsCorruptionAndForeignLocalData(t *testing.T) {
	service, server := newStateService(t)
	root := filepath.Join(t.TempDir(), "state")
	store := openTestState(t, root, server.URL)
	must(t, WriteFile(filepath.Join(root, "vault.key"), []byte("key"), 0o600))
	store.Close()
	service.mu.Lock()
	service.corrupt = true
	service.mu.Unlock()
	if _, err := Open(context.Background(), root, server.URL); err == nil {
		t.Fatal("corrupt remote blob accepted")
	}
	data, err := os.ReadFile(filepath.Join(root, "vault.key"))
	must(t, err)
	if string(data) != "key" {
		t.Fatal("failed hydration destroyed previous cache")
	}
	service.mu.Lock()
	service.corrupt = false
	service.manifest.Files = append(service.manifest.Files, File{Path: "../escape", Mode: 0o600})
	service.mu.Unlock()
	if _, err := Open(context.Background(), root, server.URL); err == nil {
		t.Fatal("manifest path traversal accepted")
	}
	foreign := filepath.Join(t.TempDir(), "existing")
	must(t, os.MkdirAll(foreign, 0o700))
	must(t, os.WriteFile(filepath.Join(foreign, "settings.json"), []byte("user data"), 0o600))
	if _, err := Open(context.Background(), foreign, server.URL); err == nil {
		t.Fatal("local deployment silently replaced by cloud state")
	}
}
