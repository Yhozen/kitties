package statefs

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/madkoding/kitties/internal/statelock"
)

func TestLocalAndOutsideStateFilesKeepOrdinaryFilesystemBehavior(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "file")
	moved := filepath.Join(root, "moved")
	must(t, MkdirAll(filepath.Join(root, "sub"), 0700))
	must(t, WriteFile(file, []byte("one"), 0600))
	must(t, AppendFile(file, []byte("two"), 0600))
	must(t, Rename(file, moved))
	must(t, Publish(moved))
	data, err := os.ReadFile(moved)
	must(t, err)
	if string(data) != "onetwo" {
		t.Fatal("local append changed")
	}
	if err := MkdirAll(filepath.Join(moved, "child"), 0700); err == nil {
		t.Fatal("mkdir through file accepted")
	}
	if err := AppendFile(filepath.Join(moved, "child"), nil, 0600); err == nil {
		t.Fatal("append through file accepted")
	}
	if err := Remove(filepath.Join(root, "sub", "missing")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing delete: %v", err)
	}
	must(t, WriteFile(filepath.Join(root, "sub", "keep"), nil, 0600))
	if err := Remove(filepath.Join(root, "sub")); err == nil {
		t.Fatal("removed nonempty directory")
	}
	must(t, RemoveAll(filepath.Join(root, "sub")))
	_, server := newStateService(t)
	cache := filepath.Join(t.TempDir(), "cache")
	store := openTestState(t, cache, server.URL)
	defer store.Close()
	must(t, WriteFile(file, []byte("outside"), 0600))
	must(t, AppendFile(file, []byte("!"), 0600))
	must(t, Rename(file, moved))
	must(t, Remove(moved))
	if err := Publish(filepath.Join(root, "outside")); err == nil {
		t.Fatal("published file outside cloud root")
	}
	if err := Publish(filepath.Join(cache, "missing")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing publish: %v", err)
	}
	must(t, os.Mkdir(filepath.Join(cache, "directory"), 0700))
	if err := Publish(filepath.Join(cache, "directory")); err == nil {
		t.Fatal("published directory")
	}
	must(t, Publish())
	must(t, WriteFile(filepath.Join(cache, "tracked"), []byte("payload"), 0600))
	must(t, Rename(filepath.Join(cache, "tracked"), file))
	must(t, Rename(file, filepath.Join(cache, "returned")))
	if store.revision != 3 {
		t.Fatalf("outside state unexpectedly committed: %d", store.revision)
	}
}

func TestCloudStateRequiresPrivateEndpointAndExclusiveCache(t *testing.T) {
	_, server := newStateService(t)
	root := filepath.Join(t.TempDir(), "cache")
	if Active(root) {
		t.Fatal("no cache should be active")
	}
	for _, endpoint := range []string{"http://example.com", "https://user:password@example.com", "https://example.com/?secret=1", "https://example.com/#fragment", "://bad", "file:///tmp/state"} {
		if _, err := Open(context.Background(), root, endpoint); err == nil {
			t.Fatalf("accepted endpoint %s", endpoint)
		}
		if _, err := Empty(context.Background(), endpoint); err == nil {
			t.Fatal("probe accepted invalid endpoint")
		}
	}
	for _, root := range []string{"relative", "/"} {
		if _, err := Open(context.Background(), root, server.URL); err == nil {
			t.Fatal("accepted nondedicated cache")
		}
	}
	lock, err := statelock.Acquire(root)
	must(t, err)
	if _, err := Open(context.Background(), root, server.URL); !errors.Is(err, statelock.ErrLocked) {
		t.Fatalf("cache not exclusive: %v", err)
	}
	must(t, lock.Close())
	store := openTestState(t, root, server.URL)
	if !Active(root) || Active(root+"-other") {
		t.Fatal("active cache identity wrong")
	}
	if _, err := Open(context.Background(), filepath.Join(t.TempDir(), "other"), server.URL); err == nil {
		t.Fatal("second cloud writer allowed")
	}
	store.Close()
	store.Close()
	if Active(root) {
		t.Fatal("closed cache remains active")
	}
}

func TestConcurrentCloudOpenElectsExactlyOneWriter(t *testing.T) {
	arrived := make(chan struct{}, 2)
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		arrived <- struct{}{}
		<-release
		io.WriteString(w, `{"revision":0,"files":[]}`)
	}))
	defer server.Close()
	var wg sync.WaitGroup
	results := make(chan *Store, 2)
	for i := 0; i < 2; i++ {
		root := filepath.Join(t.TempDir(), "cache")
		wg.Add(1)
		go func() { defer wg.Done(); store, _ := Open(context.Background(), root, server.URL); results <- store }()
	}
	<-arrived
	<-arrived
	close(release)
	wg.Wait()
	close(results)
	count := 0
	for store := range results {
		if store != nil {
			count++
			store.Close()
		}
	}
	if count != 1 {
		t.Fatalf("elected %d writers", count)
	}
}

func TestMalformedManifestCannotBecomeGatewayState(t *testing.T) {
	for _, body := range []string{
		`{`, `{"revision":-1}`, `{"revision":0,"files":[{"path":"x","mode":4096}]}`,
		`{"revision":0,"files":[{"path":"x","mode":384},{"path":"x","mode":384}]}`,
		`{"revision":0,"files":[{"path":"x","mode":384},{"path":"x/y","mode":384}]}`,
		`{"revision":0,"files":[{"path":"x","mode":384,"parts":[{"sha256":"invalid","size":1}]}]}`,
	} {
		t.Run(body, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, body) }))
			defer server.Close()
			root := filepath.Join(t.TempDir(), "cache")
			if _, err := Open(context.Background(), root, server.URL); err == nil {
				t.Fatal("accepted malformed state")
			}
			lock, err := statelock.Acquire(root)
			must(t, err)
			must(t, lock.Close())
		})
	}
}

func TestStateProtocolRejectsBadAcknowledgementsAndUnavailableBlobs(t *testing.T) {
	for _, body := range []string{`{`, `{"revision":0}`, `{"revision":2}`} {
		t.Run(body, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, body) }))
			defer server.Close()
			store, err := newStore(t.TempDir(), server.URL)
			must(t, err)
			if err := store.commit(context.Background(), []Mutation{{Op: "delete", Path: "removed"}}); err == nil || store.revision != 0 {
				t.Fatalf("bad acknowledgement advanced state: %v", err)
			}
		})
	}
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()
	store, err := newStore(t.TempDir(), server.URL)
	must(t, err)
	if err := store.download(context.Background(), Part{SHA256: strings.Repeat("0", 64), Size: 1}, io.Discard); err == nil {
		t.Fatal("missing blob accepted")
	}
	if _, err := store.request(context.Background(), "bad\nmethod", "", nil); err == nil {
		t.Fatal("invalid HTTP request accepted")
	}
	if _, err := store.uploadFile(context.Background(), filepath.Join(t.TempDir(), "missing")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing chunk source: %v", err)
	}
	if _, err := store.uploadFile(context.Background(), t.TempDir()); err == nil {
		t.Fatal("directory chunk source accepted")
	}
}

func TestImportPreflightCannotTreatUnreadableStateAsEmpty(t *testing.T) {
	service, server := newStateService(t)
	empty, err := Empty(context.Background(), server.URL)
	must(t, err)
	if !empty {
		t.Fatal("fresh service not empty")
	}
	service.mu.Lock()
	service.manifest.Revision = 1
	service.mu.Unlock()
	empty, err = Empty(context.Background(), server.URL)
	must(t, err)
	if empty {
		t.Fatal("old state considered fresh")
	}
	service.mu.Lock()
	service.unavailable = true
	service.mu.Unlock()
	if _, err := Empty(context.Background(), server.URL); err == nil {
		t.Fatal("unavailable state considered empty")
	}
	if err := Import(context.Background(), "relative", server.URL); err == nil {
		t.Fatal("relative recovery path accepted")
	}
	source := filepath.Join(t.TempDir(), "absent")
	if err := Import(context.Background(), source, server.URL); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing source: %v", err)
	}
	must(t, os.WriteFile(source, nil, 0600))
	if err := Import(context.Background(), source, server.URL); err == nil {
		t.Fatal("regularfile source accepted")
	}
	dir := t.TempDir()
	lock, err := statelock.Acquire(dir)
	must(t, err)
	defer lock.Close()
	if err := Import(context.Background(), dir, server.URL); !errors.Is(err, statelock.ErrLocked) {
		t.Fatalf("locked recovery modified: %v", err)
	}
}

func TestStateDownloadsDoNotFollowRedirectsOrAcceptTruncation(t *testing.T) {
	destinationCalled := false
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { destinationCalled = true }))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, http.StatusFound) }))
	defer redirect.Close()
	if _, err := Empty(context.Background(), redirect.URL); err == nil {
		t.Fatal("followed redirect from private state service")
	}
	if destinationCalled {
		t.Fatal("private state request escaped service")
	}
	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "10")
		io.WriteString(w, "x")
	}))
	defer broken.Close()
	store, err := newStore(t.TempDir(), broken.URL)
	must(t, err)
	if err := store.download(context.Background(), Part{SHA256: strings.Repeat("0", 64), Size: 10}, io.Discard); err == nil {
		t.Fatal("accepted truncated blob")
	}
}

func TestRecoveryCaptureRejectsFilesystemConflicts(t *testing.T) {
	source := t.TempDir()
	must(t, os.WriteFile(filepath.Join(source, "vault.key"), []byte("key"), 0600))
	destination := filepath.Join(t.TempDir(), "file")
	must(t, os.WriteFile(destination, nil, 0600))
	if err := Snapshot(context.Background(), source, destination); err == nil {
		t.Fatal("backup destination was regular file")
	}
	if err := Snapshot(context.Background(), filepath.Join(t.TempDir(), "missing"), t.TempDir()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing source: %v", err)
	}
	must(t, os.WriteFile(filepath.Join(source, "back\\slash"), nil, 0600))
	_, server := newStateService(t)
	if err := Import(context.Background(), source, server.URL); err == nil {
		t.Fatal("nonportable recovery filename accepted")
	}
	if os.Getuid() != 0 {
		locked := t.TempDir()
		must(t, os.Chmod(locked, 0500))
		defer os.Chmod(locked, 0700)
		if err := Snapshot(context.Background(), source, filepath.Join(locked, "new")); err == nil {
			t.Fatal("unwritable backup destination accepted")
		}
		must(t, os.Chmod(filepath.Join(source, "vault.key"), 0000))
		defer os.Chmod(filepath.Join(source, "vault.key"), 0600)
		if err := Snapshot(context.Background(), source, t.TempDir()); err == nil {
			t.Fatal("unreadable recovery file accepted")
		}
	}
}

func TestCloudManifestCannotAliasDirectoriesAndFiles(t *testing.T) {
	for _, files := range [][]File{
		{{Path: "x", Mode: 0600}, {Path: "x/y", Mode: 0600}},
		{{Path: "x/y", Mode: 0600}, {Path: "x", Mode: 0600}},
	} {
		t.Run(files[0].Path, func(t *testing.T) {
			service, server := newStateService(t)
			root := filepath.Join(t.TempDir(), "cache")
			store := openTestState(t, root, server.URL)
			service.mu.Lock()
			service.manifest.Files = files
			service.mu.Unlock()
			if err := Snapshot(context.Background(), root, t.TempDir()); err == nil {
				t.Fatal("aliased snapshot paths accepted")
			}
			store.Close()
			if _, err := Open(context.Background(), root, server.URL); err == nil {
				t.Fatal("aliased hydration paths accepted")
			}
		})
	}
}
