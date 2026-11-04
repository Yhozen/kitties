package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/madkoding/kitties/internal/agenda"
	"github.com/madkoding/kitties/internal/approvals"
	"github.com/madkoding/kitties/internal/config"
	"github.com/madkoding/kitties/internal/llmauth"
	"github.com/madkoding/kitties/internal/memory"
	"github.com/madkoding/kitties/internal/orchestrator"
	"github.com/madkoding/kitties/internal/statefs"
	"github.com/madkoding/kitties/internal/statelock"
	"github.com/madkoding/kitties/internal/vault"
)

type gatewayStateService struct {
	importID    string
	importNext  int
	importFiles []statefs.Mutation

	mu       sync.Mutex
	revision int64
	files    map[string]statefs.File
	blobs    map[string][]byte
}

func newGatewayStateService(t *testing.T) (*gatewayStateService, string) {
	t.Helper()
	s := &gatewayStateService{files: map[string]statefs.File{}, blobs: map[string][]byte{}}
	server := httptest.NewServer(http.HandlerFunc(s.serve))
	t.Cleanup(server.Close)
	return s, server.URL
}

func (s *gatewayStateService) seed(path, data string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	hash := sha256.Sum256([]byte(data))
	key := hex.EncodeToString(hash[:])
	s.blobs[key] = []byte(data)
	s.files[path] = statefs.File{Path: path, Mode: 0o600, Parts: []statefs.Part{{SHA256: key, Size: int64(len(data))}}}
}

func (s *gatewayStateService) serve(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case r.URL.Path == "/v1/manifest":
		manifest := statefs.Manifest{Revision: s.revision}
		for _, file := range s.files {
			manifest.Files = append(manifest.Files, file)
		}
		_ = json.NewEncoder(w).Encode(manifest)
	case strings.HasPrefix(r.URL.Path, "/v1/blob/"):
		key := strings.TrimPrefix(r.URL.Path, "/v1/blob/")
		if r.Method == http.MethodPut {
			data, err := io.ReadAll(r.Body)
			if err != nil {
				http.Error(w, "read blob", 400)
				return
			}
			s.blobs[key] = data
			w.WriteHeader(http.StatusNoContent)
			return
		}
		data, ok := s.blobs[key]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(data)

	case strings.HasPrefix(r.URL.Path, "/v1/import/"):
		var input struct {
			ID        string             `json:"id"`
			Index     int                `json:"index"`
			Mutations []statefs.Mutation `json:"mutations"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			http.Error(w, "json", 400)
			return
		}
		switch strings.TrimPrefix(r.URL.Path, "/v1/import/") {
		case "begin":
			if s.revision != 0 || s.importID != "" && s.importID != input.ID {
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
			if s.revision == 0 {
				for _, m := range s.importFiles {
					s.files[m.Path] = statefs.File{Path: m.Path, Mode: m.Mode, Parts: m.Parts}
				}
				s.revision = 1
			}

			_ = json.NewEncoder(w).Encode(map[string]int64{"revision": 1})
		default:
			http.NotFound(w, r)
		}
	case r.URL.Path == "/v1/commit":
		var commit struct {
			BaseRevision int64              `json:"baseRevision"`
			Mutations    []statefs.Mutation `json:"mutations"`
		}
		if err := json.NewDecoder(r.Body).Decode(&commit); err != nil || commit.BaseRevision != s.revision {
			http.Error(w, "invalid revision", http.StatusConflict)
			return
		}
		for _, mutation := range commit.Mutations {
			switch mutation.Op {
			case "put":
				s.files[mutation.Path] = statefs.File{Path: mutation.Path, Mode: mutation.Mode, Parts: mutation.Parts}
			case "append":
				file := s.files[mutation.Path]
				file.Path, file.Mode = mutation.Path, mutation.Mode
				file.Parts = append(file.Parts, mutation.Parts...)
				s.files[mutation.Path] = file
			case "delete":
				for path := range s.files {
					if path == mutation.Path || mutation.Recursive && strings.HasPrefix(path, mutation.Path+"/") {
						delete(s.files, path)
					}
				}
			}
		}
		s.revision++
		_ = json.NewEncoder(w).Encode(map[string]int64{"revision": s.revision})
	default:
		http.NotFound(w, r)
	}
}

func TestRemoteStateHydratesBeforeConfigAndReleasesStartupLock(t *testing.T) {
	t.Setenv(vault.KeyEnv, "")
	for _, valid := range []bool{true, false} {
		t.Run(fmt.Sprint(valid), func(t *testing.T) {
			service, endpoint := newGatewayStateService(t)
			body := "containers:\n  runtime: boat\n"
			if !valid {
				body = "containers:\n  runtime: invalid-runtime\n"
			}
			service.seed("kitties.yaml", body)
			dir := filepath.Join(t.TempDir(), "empty-cache")
			t.Setenv("KITTIES_STATE_URL", endpoint)
			t.Setenv("KITTIES_DATA_DIR", dir)
			t.Setenv("KITTIES_CONFIG", filepath.Join(dir, "kitties.yaml"))
			var output bytes.Buffer
			code := run([]string{"providers"}, strings.NewReader(""), &output, &output)
			if (code == 0) != valid {
				t.Fatalf("startup code=%d valid=%v: %s", code, valid, output.String())
			}
			if statefs.Active(dir) {
				t.Fatal("startup retained the remote state handle")
			}
			lock, err := statelock.Acquire(dir)
			if err != nil {
				t.Fatalf("startup retained the data lock: %v", err)
			}
			_ = lock.Close()
			service.mu.Lock()
			_, keySaved := service.files["vault.key"]
			service.mu.Unlock()
			if keySaved != valid {
				t.Fatalf("secret-store initialization before config validation: key=%v valid=%v", keySaved, valid)
			}
		})
	}
}

func TestRemoteGatewayStoresSurviveReplacementContainer(t *testing.T) {
	t.Setenv(vault.KeyEnv, "")
	_, endpoint := newGatewayStateService(t)
	dir := filepath.Join(t.TempDir(), "first-container")
	remote, err := statefs.Open(context.Background(), dir, endpoint)
	mustCloudState(t, err)
	a := cloudApp(t, dir)
	a.remoteState = remote
	t.Cleanup(func() { _ = a.close() })
	mustCloudState(t, a.open("providers"))
	mustCloudState(t, a.fleet.SetProvider("fixture", config.Provider{Kind: "openai", APIKey: "fixture-key", Model: "fixture-model"}))
	noDesktop := false
	k, err := a.fleet.Create(context.Background(), orchestrator.Spec{Name: "mimi", Provider: "fixture", Desktop: &noDesktop})
	mustCloudState(t, err)
	session, err := a.chats.Create("Persisted conversation", []string{k.ID})
	mustCloudState(t, err)
	_, err = a.agenda.AddGoal(agenda.Goal{Kitty: k.ID, Title: "Saved goal", Every: "0 9 * * *", Enabled: true})
	mustCloudState(t, err)
	for _, text := range []string{"first entry", "second entry"} {
		mustCloudState(t, a.agenda.Note(agenda.Entry{Kitty: k.ID, Kind: agenda.KindLearned, Text: text}))
	}
	_, err = a.approvals.SetRule(approvals.Rule{Kitty: k.ID, Connector: "phone", Mode: approvals.ModeAsk})
	mustCloudState(t, err)
	a.budget.AddTokens(k.ID, 41)
	_, err = a.memory.Remember(k.ID, memory.ScopeUser, "Keep this preference", "person", true)
	mustCloudState(t, err)
	mustCloudState(t, a.vault.Put("fixture-login", "fixture-secret", []string{k.ID}))
	mustCloudState(t, a.keep.Save(k.ID, []byte("saved desktop session")))
	_, err = a.skills.Propose("retained", "# Retained\nProcedure")
	mustCloudState(t, err)
	_, err = a.skills.Save("retained", "# Retained\nAccepted procedure")
	mustCloudState(t, err)
	_, err = a.arts.Put("report.tmp", []byte("important report"), k.ID)
	mustCloudState(t, err)
	_, err = a.arts.Put("removed.txt", []byte("discard"), k.ID)
	mustCloudState(t, err)
	mustCloudState(t, a.arts.Delete("removed.txt"))
	accounts := llmauth.NewStore(filepath.Join(dir, "accounts"))
	mustCloudState(t, accounts.Save(llmauth.Credential{Kind: "codex", AccessToken: "fixture-access"}))
	mustCloudState(t, accounts.Save(llmauth.Credential{Kind: "copilot", AccessToken: "removed-access"}))
	mustCloudState(t, accounts.Delete("copilot"))
	a.closeRuntime = func() error {
		if !statefs.Active(dir) {
			t.Error("durable state closed before runtime drained")
		}
		return saveGatewayToken(filepath.Join(dir, "gateway.token"), "saved-during-close")
	}
	mustCloudState(t, a.close())
	want := gatewayStateFiles(t, dir)
	fresh := filepath.Join(t.TempDir(), "replacement-container")
	restored, err := statefs.Open(context.Background(), fresh, endpoint)
	mustCloudState(t, err)
	b := cloudApp(t, fresh)
	b.remoteState = restored
	t.Cleanup(func() { _ = b.close() })
	got := gatewayStateFiles(t, fresh)
	if len(want) != len(got) {
		t.Fatalf("restored %d files, expected %d", len(got), len(want))
	}
	for path, data := range want {
		if !bytes.Equal(data, got[path]) {
			t.Errorf("durable data changed or disappeared: %s", path)
		}
	}
	mustCloudState(t, b.open("providers"))
	_, err = b.chats.Get(session.ID)
	mustCloudState(t, err)
	secret, err := b.vault.Get("fixture-login", k.ID)
	mustCloudState(t, err)
	if secret != "fixture-secret" || b.budget.Today(k.ID).Tokens != 41 || len(b.agenda.Recent(k.ID, 10)) != 2 {
		t.Fatal("replacement container did not reopen the original encrypted state, budget, and journal")
	}
}

func gatewayStateFiles(t *testing.T, root string) map[string][]byte {
	t.Helper()
	files := map[string][]byte{}
	mustCloudState(t, filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || entry.Name() == ".gateway.lock" || entry.Name() == ".remote-state-cache" {
			return nil
		}
		name, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		files[name], err = os.ReadFile(path)
		return err
	}))
	return files
}

func mustCloudState(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
