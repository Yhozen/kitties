package statefs

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestLargeRecoveryImportResumesWithoutExposingPartialState(t *testing.T) {
	service, _ := newStateService(t)
	source := t.TempDir()
	for i := 0; i < 300; i++ {
		must(t, os.WriteFile(filepath.Join(source, fmt.Sprintf("file-%03d", i)), []byte("restored"), 0600))
	}
	var fail atomic.Bool
	fail.Store(true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/import/batch" {
			service.mu.Lock()
			visible, next := len(service.manifest.Files), service.importNext
			service.mu.Unlock()
			if visible != 0 {
				t.Error("staged files became authoritative before finalization")
			}
			if next == 1 && fail.Load() {
				http.Error(w, "temporary storage failure", 503)
				return
			}
		}
		service.serve(w, r)
	}))
	defer server.Close()
	if err := Import(context.Background(), source, server.URL); err == nil {
		t.Fatal("failed batch was acknowledged")
	}
	service.mu.Lock()
	visible, next, revision := len(service.manifest.Files), service.importNext, service.manifest.Revision
	service.mu.Unlock()
	if visible != 0 || next != 1 || revision != 0 {
		t.Fatalf("partial import escaped: visible=%d next=%d revision=%d", visible, next, revision)
	}
	fail.Store(false)
	must(t, Import(context.Background(), source, server.URL))
	service.mu.Lock()
	defer service.mu.Unlock()
	if service.manifest.Revision != 1 || len(service.manifest.Files) != 300 || service.importNext != 2 {
		t.Fatal("complete recovery was not published in one revision")
	}
}

func TestImportBoundsMetadataBatches(t *testing.T) {
	mutations := make([]Mutation, 300)
	for index := range mutations {
		mutations[index] = Mutation{Op: "put", Path: strings.Repeat("a", 5000) + fmt.Sprint(index), Mode: 0600}
	}
	batches, first, err := splitImport(mutations)
	must(t, err)
	if len(batches) < 2 {
		t.Fatal("metadata byte limit was ignored")
	}
	count := 0
	for index, batch := range batches {
		data, err := json.Marshal(importBatch{first, index, batch})
		must(t, err)
		if len(data) > importBatchBytes || len(batch) > importBatchFiles {
			t.Fatal("oversized import batch")
		}
		count += len(batch)
	}
	if count != len(mutations) {
		t.Fatal("batching lost files")
	}
	_, second, err := splitImport(mutations)
	must(t, err)
	if first != second {
		t.Fatal("identical recovery cannot resume")
	}
	mutations[0].Path = "changed"
	_, changed, err := splitImport(mutations)
	must(t, err)
	if first == changed {
		t.Fatal("different recovery reused the same receipt")
	}
	_, _, err = splitImport([]Mutation{{Op: "put", Path: strings.Repeat("a", importBatchBytes)}})
	if err == nil {
		t.Fatal("unbounded single-file metadata accepted")
	}
}

func TestImportRejectsMalformedAcknowledgements(t *testing.T) {
	for _, test := range []struct{ action, reply string }{
		{"begin", `{"next":-1}`}, {"begin", `{"next":2}`}, {"begin", `{}`},
		{"batch", `{"next":0}`}, {"batch", `not-json`},
		{"finalize", `{"revision":2}`},
	} {
		t.Run(test.action+test.reply, func(t *testing.T) {
			service, _ := newStateService(t)
			source := t.TempDir()
			must(t, os.WriteFile(filepath.Join(source, "vault.key"), []byte("key"), 0600))
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/v1/import/"+test.action {
					_, _ = w.Write([]byte(test.reply))
					return
				}
				service.serve(w, r)
			}))
			defer server.Close()
			if err := Import(context.Background(), source, server.URL); err == nil {
				t.Fatal("malformed acknowledgement accepted")
			}
		})
	}
}
