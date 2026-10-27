package statefs

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

const importBatchBytes = 1 << 20
const importBatchFiles = 256

type importBatch struct {
	ID        string     `json:"id"`
	Index     int        `json:"index"`
	Mutations []Mutation `json:"mutations"`
}

func (s *Store) importFiles(ctx context.Context, mutations []Mutation) error {
	batches, id, err := splitImport(mutations)
	if err != nil {
		return err
	}
	begin := struct {
		ID      string `json:"id"`
		Files   int    `json:"files"`
		Batches int    `json:"batches"`
	}{id, len(mutations), len(batches)}
	next, err := s.importRequest(ctx, "begin", begin, "next")
	if err != nil {
		return err
	}
	if next < 0 || next > int64(len(batches)) {
		return errors.New("state service acknowledged an invalid import position")
	}
	for index := int(next); index < len(batches); index++ {
		next, err = s.importRequest(ctx, "batch", importBatch{id, index, batches[index]}, "next")
		if err != nil {
			return err
		}
		if next != int64(index+1) {
			return errors.New("state service acknowledged an invalid import position")
		}
	}
	revision, err := s.importRequest(ctx, "finalize", struct {
		ID string `json:"id"`
	}{id}, "revision")
	if err != nil {
		return err
	}
	if revision != 1 {
		return errors.New("state service acknowledged an unexpected import revision")
	}
	return nil
}

// The content-derived ID lets a failed upload resume without publishing any
// files. Each bounded batch stays invisible until one final SQL transaction.
func splitImport(mutations []Mutation) ([][]Mutation, string, error) {
	var batches [][]Mutation
	hash := sha256.New()
	start, size := 0, 128
	for index, mutation := range mutations {
		data, err := json.Marshal(mutation)
		if err != nil {
			return nil, "", err
		}
		if len(data)+128 > importBatchBytes {
			return nil, "", errors.New("recovery file has too many blob parts")
		}
		hash.Write(data)
		hash.Write([]byte{'\n'})
		if index-start == importBatchFiles || size+len(data)+1 > importBatchBytes {
			batches = append(batches, mutations[start:index])
			start, size = index, 128
		}
		size += len(data) + 1
	}
	if start < len(mutations) {
		batches = append(batches, mutations[start:])
	}
	return batches, hex.EncodeToString(hash.Sum(nil)), nil
}

func (s *Store) importRequest(ctx context.Context, action string, value any, field string) (int64, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return 0, err
	}
	for attempt := 0; attempt < 3; attempt++ {
		response, requestErr := s.request(ctx, http.MethodPost, "/v1/import/"+action, bytes.NewReader(payload))
		if requestErr != nil {
			err = requestErr
			continue
		}
		var result map[string]int64
		err = json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&result)
		response.Body.Close()
		if err != nil {
			continue
		}
		value, ok := result[field]
		if !ok {
			return 0, errors.New("state service omitted import acknowledgement")
		}
		return value, nil
	}
	return 0, err
}
