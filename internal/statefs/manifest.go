package statefs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

func (s *Store) manifest(ctx context.Context) (Manifest, error) {
	response, err := s.request(ctx, http.MethodGet, "/v1/manifest", nil)
	if err != nil {
		return Manifest{}, err
	}
	defer response.Body.Close()
	var manifest Manifest
	if err := json.NewDecoder(io.LimitReader(response.Body, 64<<20)).Decode(&manifest); err != nil {
		return Manifest{}, fmt.Errorf("read state manifest: %w", err)
	}
	if manifest.Revision < 0 {
		return Manifest{}, errors.New("invalid state revision")
	}
	return manifest, nil
}

// Empty checks whether a fresh cloud state service can accept a recovery import.
// It does not acquire a local cache or modify the remote service.
func Empty(ctx context.Context, endpoint string) (bool, error) {
	s, err := newStore("/state", endpoint)
	if err != nil {
		return false, err
	}
	manifest, err := s.manifest(ctx)
	if err != nil {
		return false, err
	}
	return manifest.Revision == 0 && len(manifest.Files) == 0, nil
}
