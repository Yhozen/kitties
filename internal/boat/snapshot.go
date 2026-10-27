package boat

import (
	"archive/tar"
	"bufio"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"sort"
	"strings"
)

const snapshotHome = "__system__/home/kitty"
const maxSnapshotChunk = int64(512 << 20)

type snapshotChunk struct {
	SnapshotID string `json:"snapshotId"`
	Generation int    `json:"generation"`
	Index      int    `json:"chunkIndex"`
	Size       int64  `json:"sizeBytes"`
	SHA256     string `json:"sha256"`
	URL        string `json:"signedUrl"`
}
type snapshotDownload struct {
	SnapshotID string            `json:"snapshotId"`
	Chunks     []snapshotChunk   `json:"chunks"`
	Keys       map[string]string `json:"snapshotDeks"`
}
type inventoryEntry struct {
	Path string `json:"path"`
	Kind string `json:"kind"`
	Size int64  `json:"size"`
}

func homePath(name string) (string, bool) {
	cleaned := path.Clean(name)
	if cleaned == snapshotHome {
		return ".", true
	}
	relative, ok := strings.CutPrefix(cleaned, snapshotHome+"/")
	return relative, ok
}

// bundleExportHome traverses the immutable chain newest-first and emits only the
// first version of each path present in the final inventory. No guest boots and
// no full home is staged: scratch storage is one verified compressed chunk.
func (m *Manager) bundleExportHome(ctx context.Context, r record, w io.Writer) error {
	var download snapshotDownload
	if err := m.json(ctx, "GET", "/snapshots/"+url.PathEscape(r.CheckpointID)+"/download", nil, nil, &download); err != nil {
		return err
	}
	if download.SnapshotID != r.CheckpointID || len(download.Chunks) == 0 {
		return errors.New("Boat returned an incomplete snapshot chain")
	}
	resp, err := m.request(ctx, "GET", "/snapshots/"+url.PathEscape(r.CheckpointID)+"/tree", nil, nil)
	if err != nil {
		return err
	}
	var tree struct {
		Truncated bool             `json:"truncated"`
		Entries   []inventoryEntry `json:"entries"`
	}
	err = jsonDecodeInventory(resp.Body, &tree)
	resp.Body.Close()
	if err != nil {
		return err
	}
	if tree.Truncated {
		return errors.New("Boat truncated the snapshot inventory; refusing an incomplete backup")
	}
	wanted := map[string]inventoryEntry{}
	for _, entry := range tree.Entries {
		if relative, ok := homePath(entry.Path); ok {
			if _, duplicate := wanted[relative]; duplicate {
				return errors.New("duplicate home path in snapshot inventory")
			}
			wanted[relative] = entry
		}
	}
	if len(wanted) == 0 {
		return errors.New("snapshot inventory contains no kitty home")
	}
	for name := range wanted {
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			if e, ok := wanted[parent]; ok && e.Kind != "dir" {
				return errors.New("snapshot inventory contains a file beneath a non-directory")
			}
		}
	}
	groups := map[int][]snapshotChunk{}
	var generations []int
	for _, chunk := range download.Chunks {
		if chunk.Size < 0 || chunk.Size > maxSnapshotChunk || chunk.Index < 0 || chunk.Generation < 0 || len(chunk.SHA256) != 64 {
			return errors.New("snapshot chunk is malformed or exceeds the 512 MiB scratch limit")
		}
		if _, err := hex.DecodeString(chunk.SHA256); err != nil {
			return errors.New("snapshot chunk checksum is invalid")
		}
		if _, ok := groups[chunk.Generation]; !ok {
			generations = append(generations, chunk.Generation)
		}
		groups[chunk.Generation] = append(groups[chunk.Generation], chunk)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(generations)))
	for generation, chunks := range groups {
		sort.Slice(chunks, func(i, j int) bool { return chunks[i].Index < chunks[j].Index })
		for i, c := range chunks {
			if c.Index != i || c.SnapshotID != chunks[0].SnapshotID {
				return errors.New("snapshot generation has missing or duplicate chunks")
			}
		}
		groups[generation] = chunks
	}
	scratch, err := os.MkdirTemp("", "kitties-boat-export-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(scratch)
	writer := tar.NewWriter(w)
	pendingLinks := map[string]*tar.Header{}
	for _, generation := range generations {
		err = m.readSnapshotGeneration(ctx, scratch, groups[generation], download.Keys, func(header *tar.Header, body io.Reader) error {
			relative, ok := homePath(header.Name)
			if !ok {
				return nil
			}
			entry, ok := wanted[relative]
			if !ok {
				return nil
			}
			if header.Typeflag == tar.TypeLink {
				target, inside := homePath(header.Linkname)
				if !inside {
					return errors.New("snapshot home hard link points outside the exported home")
				}
				copy := *header
				copy.Name = relative
				copy.Linkname = target
				pendingLinks[relative] = &copy
				delete(wanted, relative)
				return nil
			}
			copy := *header
			copy.Name = relative
			copy.PAXRecords = cleanPAX(header.PAXRecords)
			switch header.Typeflag {
			case tar.TypeReg, tar.TypeRegA, tar.TypeGNUSparse:
				if entry.Kind != "file" || header.Size != entry.Size {
					return fmt.Errorf("snapshot size or kind mismatch for %s", relative)
				}
				copy.Typeflag = tar.TypeReg
			case tar.TypeDir:
				if entry.Kind != "dir" {
					return fmt.Errorf("snapshot directory mismatch for %s", relative)
				}
			case tar.TypeSymlink:
				if entry.Kind != "symlink" {
					return fmt.Errorf("snapshot symlink mismatch for %s", relative)
				}
			default:
				return fmt.Errorf("unsupported snapshot file type for %s", relative)
			}
			if err := writer.WriteHeader(&copy); err != nil {
				return err
			}
			if copy.Typeflag == tar.TypeReg {
				if _, err := io.CopyN(writer, body, copy.Size); err != nil {
					return err
				}
			}
			delete(wanted, relative)
			return nil
		})
		if err != nil {
			return err
		}
	}
	if len(wanted) != 0 {
		return fmt.Errorf("snapshot chain is missing %d home entries", len(wanted))
	}
	// Hard links come after their targets; they may never refer outside the home.
	remaining := len(pendingLinks)
	for remaining > 0 {
		progressed := false
		for name, header := range pendingLinks {
			if _, waiting := pendingLinks[header.Linkname]; waiting {
				continue
			}
			if _, exists := findInventory(tree.Entries, header.Linkname); !exists {
				return errors.New("snapshot hard link target is absent from the final home")
			}
			header.PAXRecords = cleanPAX(header.PAXRecords)
			if err := writer.WriteHeader(header); err != nil {
				return err
			}
			delete(pendingLinks, name)
			remaining--
			progressed = true
		}
		if !progressed {
			return errors.New("snapshot contains cyclic hard links")
		}
	}
	return writer.Close()
}

func findInventory(entries []inventoryEntry, relative string) (inventoryEntry, bool) {
	for _, entry := range entries {
		if name, ok := homePath(entry.Path); ok && name == relative {
			return entry, true
		}
	}
	return inventoryEntry{}, false
}
func cleanPAX(original map[string]string) map[string]string {
	copy := map[string]string{}
	for k, v := range original {
		if k != "path" && k != "linkpath" && !strings.HasPrefix(k, "GNU.sparse.") {
			copy[k] = v
		}
	}
	return copy
}

func (m *Manager) readSnapshotGeneration(ctx context.Context, scratch string, chunks []snapshotChunk, keys map[string]string, visit func(*tar.Header, io.Reader) error) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := m.command(ctx, "zstd", "-d", "--stdout", "--quiet", "--memory=128MB")
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "LANG=C"}
	configureProcess(cmd)
	input, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		return err
	}
	stderr := &boundedBuffer{limit: 4096}
	cmd.Stderr = stderr
	if err = cmd.Start(); err != nil {
		input.Close()
		output.Close()
		return fmt.Errorf("snapshot export requires zstd: %w", err)
	}
	fed := make(chan error, 1)
	go func() {
		var failure error
		defer func() { input.Close(); fed <- failure }()
		for _, chunk := range chunks {
			if failure = m.feedChunk(ctx, scratch, chunk, keys[chunk.SnapshotID], input); failure != nil {
				return
			}
		}
	}()
	reader := tar.NewReader(output)
	for {
		header, e := reader.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			err = e
			break
		}
		if err = visit(header, reader); err != nil {
			break
		}
	}
	if err != nil {
		cancel()
		output.Close()
	} else {
		_, err = io.Copy(io.Discard, output)
	}
	feedErr := <-fed
	waitErr := cmd.Wait()
	if feedErr != nil {
		return feedErr
	}
	if err != nil {
		return fmt.Errorf("read snapshot archive: %w", err)
	}
	if waitErr != nil {
		return fmt.Errorf("decode snapshot archive: %w: %s", waitErr, stderr.String())
	}
	return nil
}

func (m *Manager) feedChunk(ctx context.Context, scratch string, chunk snapshotChunk, key string, out io.Writer) error {
	u, err := url.Parse(chunk.URL)
	if err != nil || u.User != nil || u.Host == "" || u.Fragment != "" {
		return errors.New("snapshot chunk has an invalid signed URL")
	}
	trustedTest := strings.HasPrefix(m.baseURL, "http://") && u.Scheme == "http" && u.Host == mustHost(m.baseURL)
	if u.Scheme != "https" && !trustedTest {
		return errors.New("snapshot chunks require HTTPS")
	}
	req, err := http.NewRequestWithContext(ctx, "GET", chunk.URL, nil)
	if err != nil {
		return errors.New("invalid snapshot chunk request")
	}
	client := *m.client
	client.Timeout = 0
	response, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("snapshot chunk download failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("snapshot chunk download returned HTTP %d", response.StatusCode)
	}
	file, err := os.CreateTemp(scratch, "chunk-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, chunk.Size+1))
	if err != nil {
		return errors.New("snapshot chunk download was interrupted")
	}
	if size != chunk.Size || hex.EncodeToString(hash.Sum(nil)) != strings.ToLower(chunk.SHA256) {
		return errors.New("snapshot chunk failed size or SHA-256 verification")
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	return copySnapshotChunk(out, file, key, chunk.SnapshotID)
}
func mustHost(base string) string { u, _ := url.Parse(base); return u.Host }
func copySnapshotChunk(out io.Writer, in io.Reader, key, snapshotID string) error {
	reader := bufio.NewReader(in)
	magic, err := reader.Peek(7)
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	if string(magic) != "ASCENC1" {
		_, err = io.Copy(out, reader)
		return err
	}
	decoded, err := base64.StdEncoding.DecodeString(key)
	if err != nil || len(decoded) != 32 {
		return errors.New("encrypted snapshot chunk requires a valid 256-bit key")
	}
	defer clear(decoded)
	block, err := aes.NewCipher(decoded)
	if err != nil {
		return err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	var sealed []byte
	defer func() { clear(sealed) }()
	for {
		next, e := reader.Peek(7)
		if e == io.EOF && len(next) == 0 {
			return nil
		}
		if e != nil && e != io.EOF {
			return e
		}
		if string(next) == "ASCENC1" {
			_, _ = reader.Discard(7)
		}
		var length uint32
		if err = binary.Read(reader, binary.LittleEndian, &length); err != nil {
			return err
		}
		if length < 16 || length > 64<<20 {
			return errors.New("invalid encrypted snapshot frame size")
		}
		nonce := make([]byte, aead.NonceSize())
		if _, err = io.ReadFull(reader, nonce); err != nil {
			return err
		}
		if cap(sealed) < int(length) {
			sealed = make([]byte, int(length))
		} else {
			sealed = sealed[:length]
		}
		if _, err = io.ReadFull(reader, sealed); err != nil {
			return err
		}
		opened, e := aead.Open(sealed[:0], nonce, sealed, []byte("snapshot-frame:"+snapshotID))
		if e != nil {
			return errors.New("snapshot frame failed authentication")
		}
		if _, err = out.Write(opened); err != nil {
			return err
		}
	}
}

func jsonDecodeInventory(reader io.Reader, out any) error {
	if err := json.NewDecoder(io.LimitReader(reader, 64<<20)).Decode(out); err != nil {
		return fmt.Errorf("read snapshot inventory: %w", err)
	}
	return nil
}
