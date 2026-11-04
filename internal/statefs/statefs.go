// Package statefs preserves the gateway's file stores on ephemeral cloud hosts.
// Local deployments use ordinary files. Cloud deployments acknowledge mutations
// only after the private state service commits them durably.
package statefs

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/madkoding/kitties/internal/statelock"
)

type Part struct {
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}
type File struct {
	Path  string `json:"path"`
	Mode  uint32 `json:"mode"`
	Parts []Part `json:"parts"`
}
type Manifest struct {
	Revision int64  `json:"revision"`
	Files    []File `json:"files"`
}
type Mutation struct {
	Op        string `json:"op"`
	Path      string `json:"path"`
	Mode      uint32 `json:"mode"`
	Parts     []Part `json:"parts,omitempty"`
	Recursive bool   `json:"recursive,omitempty"`
}
type commit struct {
	ID           string     `json:"id"`
	BaseRevision int64      `json:"baseRevision"`
	Mutations    []Mutation `json:"mutations"`
}
type Store struct {
	lock           *statelock.Lock
	root, endpoint string
	client         *http.Client
	mu             sync.Mutex
	revision       int64
	appendParts    map[string]int
}

var active atomic.Pointer[Store]
var writeGate sync.RWMutex

// Open hydrates a dedicated disposable cache, then enables durable file writes.
// The endpoint is intercepted privately by the Cloudflare container's outbound handler.
func Open(ctx context.Context, root, endpoint string) (*Store, error) {
	if active.Load() != nil {
		return nil, errors.New("remote state is already open")
	}
	s, err := newStore(root, endpoint)
	if err != nil {
		return nil, err
	}
	lock, err := statelock.Acquire(s.root)
	if err != nil {
		return nil, err
	}
	s.lock = lock
	if err := s.hydrate(ctx); err != nil {
		_ = lock.Close()
		return nil, err
	}
	if !active.CompareAndSwap(nil, s) {
		_ = lock.Close()
		return nil, errors.New("remote state opened concurrently")
	}
	return s, nil
}
func newStore(root, endpoint string) (*Store, error) {
	if !filepath.IsAbs(root) || filepath.Clean(root) == string(filepath.Separator) {
		return nil, errors.New("remote state needs an absolute dedicated cache directory")
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Host == "" {
		return nil, errors.New("invalid state endpoint")
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && (parsed.Hostname() == "kitties-state.internal" || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "localhost")) {
		return nil, errors.New("state endpoint must use HTTPS or the private container bridge")
	}
	s := &Store{appendParts: map[string]int{}, root: filepath.Clean(root), endpoint: strings.TrimRight(endpoint, "/"), client: &http.Client{Timeout: 60 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	return s, nil
}
func (s *Store) Close() {
	if active.CompareAndSwap(s, nil) {
		_ = s.lock.Close()
	}
}
func Active(root string) bool {
	s := active.Load()
	return s != nil && filepath.Clean(root) == s.root
}

func (s *Store) request(ctx context.Context, method, path string, data io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, s.endpoint+path, data)
	if err != nil {
		return nil, err
	}
	if method == http.MethodPost {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("state service request failed: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		response.Body.Close()
		return nil, &statusError{status: response.StatusCode}
	}
	return response, nil
}
func validPath(path string) bool {
	return path != "" && path != "." && path != ".." && !strings.HasPrefix(path, "/") && !strings.Contains(path, "\\") && !strings.ContainsRune(path, 0) && filepath.ToSlash(filepath.Clean(path)) == path && !strings.HasPrefix(path, "../")
}
func reserved(path string) bool {
	return path == ".gateway.lock" || path == "boat/state.lock" || path == ".remote-state-cache"
}
func stagingWrite(path string) bool {
	name := filepath.Base(path)
	return strings.HasSuffix(name, ".tmp") || strings.HasPrefix(name, ".kitties-") || strings.HasPrefix(name, ".gateway-token-")
}
func (s *Store) relative(path string) (string, bool) {
	rel, err := filepath.Rel(s.root, path)
	if err != nil {
		return "", false
	}
	rel = filepath.ToSlash(rel)
	return rel, validPath(rel) && !reserved(rel)
}
func (s *Store) hydrate(ctx context.Context) error {
	marker := filepath.Join(s.root, ".remote-state-cache")
	entries, err := os.ReadDir(s.root)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	nonLock := 0
	for _, entry := range entries {
		if entry.Name() != ".gateway.lock" {
			nonLock++
		}
	}
	if nonLock > 0 {
		data, err := os.ReadFile(marker)
		if err != nil || string(data) != s.endpoint {
			return errors.New("remote state requires an empty cache directory; refusing to replace local gateway data")
		}
	}
	manifest, err := s.manifest(ctx)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.root), 0o700); err != nil {
		return err
	}
	staging, err := os.MkdirTemp(s.root, ".state-hydrate-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	seen := map[string]bool{}
	for _, file := range manifest.Files {
		if !validPath(file.Path) || reserved(file.Path) || seen[file.Path] || file.Mode&^uint32(0o777) != 0 {
			return errors.New("invalid file in remote state manifest")
		}
		seen[file.Path] = true
		s.appendParts[file.Path] = len(file.Parts)
		path := filepath.Join(staging, filepath.FromSlash(file.Path))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return err
		}
		output, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, os.FileMode(file.Mode))
		if err != nil {
			return err
		}
		for _, part := range file.Parts {
			if err = s.download(ctx, part, output); err != nil {
				break
			}
		}
		closeErr := output.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
	}
	if err := os.WriteFile(filepath.Join(staging, ".remote-state-cache"), []byte(s.endpoint), 0o600); err != nil {
		return err
	}
	// Keep the lock inode stable while replacing only this disposable cache.
	if err := os.WriteFile(marker, []byte(s.endpoint), 0o600); err != nil {
		return err
	}
	entries, err = os.ReadDir(s.root)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() == ".gateway.lock" || entry.Name() == filepath.Base(staging) || entry.Name() == ".remote-state-cache" {
			continue
		}
		if err := os.RemoveAll(filepath.Join(s.root, entry.Name())); err != nil {
			return err
		}
	}
	staged, err := os.ReadDir(staging)
	if err != nil {
		return err
	}
	for _, entry := range staged {
		if err := os.Rename(filepath.Join(staging, entry.Name()), filepath.Join(s.root, entry.Name())); err != nil {
			return err
		}
	}
	s.revision = manifest.Revision
	return nil
}
func validPart(part Part) bool {
	raw, err := hex.DecodeString(part.SHA256)
	return err == nil && len(raw) == sha256.Size && part.Size >= 0
}
func (s *Store) download(ctx context.Context, part Part, out io.Writer) error {
	if !validPart(part) {
		return errors.New("invalid state blob")
	}
	response, err := s.request(ctx, http.MethodGet, "/v1/blob/"+part.SHA256, nil)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(out, hash), io.LimitReader(response.Body, part.Size+1))
	if err != nil {
		return err
	}
	if n != part.Size || hex.EncodeToString(hash.Sum(nil)) != part.SHA256 {
		return errors.New("remote state blob failed integrity verification")
	}
	return nil
}
func (s *Store) upload(ctx context.Context, data []byte) (Part, error) {
	digest := sha256.Sum256(data)
	part := Part{SHA256: hex.EncodeToString(digest[:]), Size: int64(len(data))}
	err := retryWrite(ctx, func() error {
		response, err := s.request(ctx, http.MethodPut, "/v1/blob/"+part.SHA256, bytes.NewReader(data))
		if err == nil {
			response.Body.Close()
		}
		return err
	})
	if err != nil {
		return Part{}, err
	}
	return part, nil
}
func (s *Store) commit(ctx context.Context, mutations []Mutation) error {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return err
	}
	payload, err := json.Marshal(commit{ID: hex.EncodeToString(id[:]), BaseRevision: s.revision, Mutations: mutations})
	if err != nil {
		return err
	}
	// Retrying the same request resolves an acknowledgement lost after commit.
	return retryWrite(ctx, func() error {
		response, err := s.request(ctx, http.MethodPost, "/v1/commit", bytes.NewReader(payload))
		if err != nil {
			return err
		}
		var result struct {
			Revision int64 `json:"revision"`
		}
		err = json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&result)
		response.Body.Close()
		if err != nil {
			return err
		}
		if result.Revision != s.revision+1 {
			return errors.New("state service acknowledged an unexpected revision")
		}
		s.revision = result.Revision
		return nil
	})
}

// A remote persistence failure is fatal: several legacy stores ignore write
// errors, so returning one would allow further external effects with lost state.
func durable(err error) {
	if err != nil {
		fmt.Fprintf(os.Stderr, "durable gateway state unavailable: %v\n", err)
		os.Exit(1)
	}
}

func WriteFile(path string, data []byte, mode os.FileMode) error {
	writeGate.RLock()
	defer writeGate.RUnlock()
	s := active.Load()
	if s == nil {
		return os.WriteFile(path, data, mode)
	}
	rel, tracked := s.relative(path)
	if !tracked {
		return os.WriteFile(path, data, mode)
	}
	if stagingWrite(rel) {
		err := os.WriteFile(path, data, mode)
		durable(err)
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	durable(os.WriteFile(path, data, mode))
	part, err := s.upload(context.Background(), data)
	durable(err)
	durable(s.commit(context.Background(), []Mutation{{Op: "put", Path: rel, Mode: uint32(mode.Perm()), Parts: []Part{part}}}))
	return nil
}
func AppendFile(path string, data []byte, mode os.FileMode) error {
	writeGate.RLock()
	defer writeGate.RUnlock()
	s := active.Load()
	tracked := false
	if s != nil {
		_, tracked = s.relative(path)
	}
	if s != nil {
		s.mu.Lock()
		defer s.mu.Unlock()
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, mode)
	if err != nil {
		if tracked {
			durable(err)
		}
		return err
	}
	_, err = f.Write(data)
	closeErr := f.Close()
	if err != nil {
		if tracked {
			durable(err)
		}
		return err
	}
	if closeErr != nil {
		if tracked {
			durable(closeErr)
		}
		return closeErr
	}
	if s != nil {
		if rel, ok := s.relative(path); ok {
			s.appendParts[rel]++
			mutation := Mutation{Op: "append", Path: rel, Mode: uint32(mode.Perm())}
			if s.appendParts[rel] >= 128 {
				parts, err := s.uploadFile(context.Background(), path)
				durable(err)
				mutation.Op, mutation.Parts = "put", parts
				s.appendParts[rel] = 0
			} else {
				part, err := s.upload(context.Background(), data)
				durable(err)
				mutation.Parts = []Part{part}
			}
			durable(s.commit(context.Background(), []Mutation{mutation}))
		}
	}
	return nil
}
func Rename(from, to string) error {
	writeGate.RLock()
	defer writeGate.RUnlock()
	s := active.Load()
	if s == nil {
		return os.Rename(from, to)
	}
	target, tracked := s.relative(to)
	source, sourceTracked := s.relative(from)
	if !tracked && !sourceTracked {
		return os.Rename(from, to)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := os.ReadFile(from)
	durable(err)
	info, err := os.Stat(from)
	durable(err)
	durable(os.Rename(from, to))
	var mutations []Mutation
	if tracked {
		part, err := s.upload(context.Background(), data)
		durable(err)
		mutations = append(mutations, Mutation{Op: "put", Path: target, Mode: uint32(info.Mode().Perm()), Parts: []Part{part}})
	}
	if sourceTracked && source != target {
		mutations = append(mutations, Mutation{Op: "delete", Path: source})
	}
	durable(s.commit(context.Background(), mutations))
	return nil
}
func Remove(path string) error    { return remove(path, false) }
func RemoveAll(path string) error { return remove(path, true) }
func remove(path string, recursive bool) error {
	writeGate.RLock()
	defer writeGate.RUnlock()
	s := active.Load()
	if s != nil {
		s.mu.Lock()
		defer s.mu.Unlock()
	}
	var err error
	if recursive {
		err = os.RemoveAll(path)
	} else {
		err = os.Remove(path)
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		if s != nil {
			if _, tracked := s.relative(path); tracked {
				durable(err)
			}
		}
		return err
	}
	if s != nil {
		if rel, ok := s.relative(path); ok {
			durable(s.commit(context.Background(), []Mutation{{Op: "delete", Path: rel, Recursive: recursive}}))
		}
	}
	return err
}

// Publish persists files created by an external process (the SSH key generator)
// as one manifest transaction before they may be used for remote side effects.
func Publish(paths ...string) error {
	writeGate.RLock()
	defer writeGate.RUnlock()
	s := active.Load()
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var mutations []Mutation
	for _, path := range paths {
		rel, ok := s.relative(path)
		if !ok {
			return errors.New("cannot publish a file outside the state directory")
		}
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		part, err := s.upload(context.Background(), data)
		durable(err)
		mutations = append(mutations, Mutation{Op: "put", Path: rel, Mode: uint32(info.Mode().Perm()), Parts: []Part{part}})
	}
	if len(mutations) > 0 {
		durable(s.commit(context.Background(), mutations))
	}
	return nil
}

// MkdirAll preserves ordinary local behavior, but cloud state cannot continue
// after a filesystem failure that a legacy caller might otherwise ignore.
func MkdirAll(path string, mode os.FileMode) error {
	writeGate.RLock()
	defer writeGate.RUnlock()
	err := os.MkdirAll(path, mode)
	if err != nil {
		if s := active.Load(); s != nil {
			if _, tracked := s.relative(path); tracked || filepath.Clean(path) == s.root {
				durable(err)
			}
		}
	}
	return err
}
