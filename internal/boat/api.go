// Package boat runs persistent kitty computers on Boat's virtual machines.
package boat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const apiBase = "https://boat.dev/api/v1"
const ownerLabel = "kitties.deployment"
const kittyLabel = "kitties.kitty"
const generationLabel = "kitties.generation"

type APIError struct {
	Status                   int
	Code, RequestID, Message string
}

func (e *APIError) Error() string { return fmt.Sprintf("Boat %d %s: %s", e.Status, e.Code, e.Message) }
func isStatus(err error, status int) bool {
	var e *APIError
	return errors.As(err, &e) && e.Status == status
}
func isCode(err error, code string) bool {
	var e *APIError
	return errors.As(err, &e) && e.Code == code
}

type sandbox struct {
	Access             string                              `json:"access"`
	ID                 string                              `json:"id"`
	Name               string                              `json:"name"`
	State              string                              `json:"state"`
	Error              string                              `json:"error"`
	Labels             map[string]string                   `json:"labels"`
	DataExpiredAt      string                              `json:"dataExpiredAt"`
	Hydrated           bool                                `json:"hydrated"`
	SnapshotAvailable  bool                                `json:"snapshotAvailable"`
	LastSnapshotStatus string                              `json:"lastSnapshotStatus"`
	Stop               *struct{ ID, Status, Error string } `json:"stop"`
}

func (s sandbox) running() bool {
	return s.State == "ready" || s.State == "idle" || s.State == "running"
}
func (s sandbox) active() bool { return s.State != "archived" && s.State != "cancelled" }

type savedSnapshot struct {
	Name            string `json:"name"`
	Status          string `json:"status"`
	Error           string `json:"error"`
	SourceSandboxID string `json:"sourceSandboxId"`
	SnapshotID      string `json:"snapshotId"`
}

type createRequest struct {
	Name       string            `json:"name"`
	Type       string            `json:"type"`
	TTLSeconds int               `json:"ttlSeconds"`
	Visibility string            `json:"visibility"`
	NoEnv      bool              `json:"noEnv"`
	Snapshots  bool              `json:"snapshots"`
	Labels     map[string]string `json:"labels"`
	From       string            `json:"from,omitempty"`
}

func (m *Manager) request(ctx context.Context, method, path string, body []byte, headers map[string]string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, m.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+m.apiKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	client := m.client
	if strings.HasPrefix(path, "/snapshots/") {
		copy := *m.client
		copy.Timeout = 0
		client = &copy
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Boat request failed: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		var data struct{ Code, Message, RequestID string }
		_ = json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&data)
		if data.Message == "" {
			data.Message = http.StatusText(resp.StatusCode)
		}
		data.Message = strings.ReplaceAll(data.Message, m.apiKey, "[redacted]")
		return nil, &APIError{Status: resp.StatusCode, Code: data.Code, Message: data.Message, RequestID: data.RequestID}
	}
	return resp, nil
}
func (m *Manager) json(ctx context.Context, method, path string, body any, headers map[string]string, out any) error {
	var raw []byte
	var err error
	if bytes, ok := body.(json.RawMessage); ok {
		raw = bytes
	} else if body != nil {
		raw, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	resp, err := m.request(ctx, method, path, raw, headers)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if out == nil {
		_, err = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		return err
	}
	if err = json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(out); err != nil {
		return fmt.Errorf("decode Boat response: %w", err)
	}
	return nil
}
func (m *Manager) get(ctx context.Context, id string) (sandbox, error) {
	var reply struct {
		Sandbox sandbox `json:"sandbox"`
	}
	err := m.json(ctx, "GET", "/sandboxes/"+url.PathEscape(id), nil, nil, &reply)
	if err == nil && reply.Sandbox.ID != id {
		return sandbox{}, errors.New("Boat returned a different sandbox identity")
	}
	return reply.Sandbox, err
}
func (m *Manager) inventory(ctx context.Context) ([]sandbox, error) {
	var all []sandbox
	cursor := ""
	seen := map[string]bool{}
	for {
		q := url.Values{"limit": {"100"}, "label": {ownerLabel + "=" + m.ownerID}}
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		var page struct {
			Sandboxes []sandbox `json:"sandboxes"`
			PageInfo  struct {
				NextCursor string `json:"nextCursor"`
				HasMore    bool   `json:"hasMore"`
			} `json:"pageInfo"`
		}
		if err := m.json(ctx, "GET", "/sandboxes?"+q.Encode(), nil, nil, &page); err != nil {
			return nil, err
		}
		for _, s := range page.Sandboxes {
			if s.Labels[ownerLabel] == m.ownerID {
				all = append(all, s)
			}
		}
		if !page.PageInfo.HasMore {
			return m.includeReceipts(ctx, all)
		}
		cursor = page.PageInfo.NextCursor
		if cursor == "" || seen[cursor] {
			return nil, errors.New("Boat inventory pagination did not advance")
		}
		seen[cursor] = true
	}
}
func (m *Manager) saved(ctx context.Context, name string) (savedSnapshot, error) {
	var reply struct {
		Snapshot savedSnapshot `json:"snapshot"`
	}
	err := m.json(ctx, "GET", "/saved-snapshots/"+url.PathEscape(name), nil, nil, &reply)
	return reply.Snapshot, err
}
func (m *Manager) delay(ctx context.Context) error {
	t := time.NewTimer(m.poll)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
func (m *Manager) waitReady(ctx context.Context, r record) (sandbox, error) {
	for {
		s, err := m.get(ctx, r.RemoteID)
		if err != nil {
			return sandbox{}, err
		}
		if err = m.checkOwner(r, s); err != nil {
			return sandbox{}, err
		}
		if s.running() && s.Hydrated {
			return s, nil
		}
		if s.State == "error" || s.State == "cancelled" || s.State == "archived" {
			return sandbox{}, fmt.Errorf("Boat computer is %s: %s", s.State, s.Error)
		}
		if err = m.delay(ctx); err != nil {
			return sandbox{}, err
		}
	}
}

func (m *Manager) includeReceipts(ctx context.Context, all []sandbox) ([]sandbox, error) {
	seen := map[string]bool{}
	for _, s := range all {
		seen[s.ID] = true
	}
	for _, r := range m.records() {
		if r.Removed || r.Receipt == nil || r.Receipt.SourceCheckpointID == "" || r.Receipt.ID != r.RemoteID || r.Receipt.Generation != r.Generation || seen[r.RemoteID] {
			continue
		}
		s, err := m.get(ctx, r.RemoteID)
		if isStatus(err, 404) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if err = m.checkOwner(r, s); err != nil {
			return nil, err
		}
		all = append(all, s)
		seen[s.ID] = true
	}
	return all, nil
}
