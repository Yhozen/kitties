package main

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/madkoding/kitties/internal/backup"
	"github.com/madkoding/kitties/internal/boat"
	"github.com/madkoding/kitties/internal/computer"
	"github.com/madkoding/kitties/internal/config"
	"github.com/madkoding/kitties/internal/kitty"
	"github.com/madkoding/kitties/internal/orchestrator"
	"github.com/madkoding/kitties/internal/statefs"
)

func (a *app) captureRecovery(ctx context.Context, directory string, idleOnly bool, archive *tar.Writer) (err error) {
	ctx, leave, err := a.fleet.BeginMaintenance(ctx, idleOnly)
	if err != nil {
		return err
	}
	defer leave()
	previous := a.fleet.List()
	homes, resume, err := a.fleet.CaptureHomesTo(ctx, func(name string, export func(io.Writer) error) error {
		reader, writer := io.Pipe()
		finished := make(chan error, 1)
		go func() { exportErr := export(writer); _ = writer.CloseWithError(exportErr); finished <- exportErr }()
		copyErr := backup.AppendTar(ctx, archive, reader, path.Join("computers", name, "home"))
		_ = reader.CloseWithError(copyErr)
		return errors.Join(copyErr, <-finished)
	})
	if resume != nil {
		defer func() { err = errors.Join(err, resume()) }()
	}
	if err != nil {
		return err
	}
	if err = statefs.Snapshot(ctx, a.cfg.DataDirOr(), filepath.Join(directory, "gateway")); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(directory, "gateway", orchestrator.RecoveryFreezeFile)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	manifest := struct {
		Version  int                 `json:"version"`
		Created  time.Time           `json:"created"`
		Homes    []computer.Recovery `json:"homes"`
		Previous []*kitty.Kitty      `json:"previous_kitties"`
	}{1, time.Now().UTC(), homes, previous}
	raw, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(directory, "manifest.json"), raw, 0o600); err != nil {
		return err
	}
	if a.configPath != "" {
		configuration, readErr := os.ReadFile(a.configPath)
		if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
			return readErr
		}
		if readErr == nil {
			if err = os.MkdirAll(filepath.Join(directory, "configuration"), 0o700); err != nil {
				return err
			}
			if err = os.WriteFile(filepath.Join(directory, "configuration", "kitties.yaml"), configuration, 0o600); err != nil {
				return err
			}
		}
	}
	return nil
}

func cmdRestore(args []string, out, errOut io.Writer) int {
	if len(args) < 1 || len(args) > 2 {
		fmt.Fprintln(errOut, "usage: kitties restore <absolute-empty-directory> [snapshot-id]")
		return 2
	}
	snapshot := "latest"
	if len(args) == 2 {
		snapshot = args[1]
	}
	ctx, cancel := notifyContext()
	defer cancel()
	if err := backup.Restore(ctx, snapshot, args[0]); err != nil {
		fmt.Fprintf(errOut, "kitties: restore failed: %v\n", err)
		return 1
	}
	fmt.Fprintf(out, "Recovery package restored to %s. Follow docs/BACKUPS.md to start a replacement gateway.\n", args[0])
	return 0
}

const restoreMarker = "recovery-source.json"
const restoredConfig = "recovered-config.yaml"

type restoreReceipt struct {
	Requested string `json:"requested"`
	Snapshot  string `json:"snapshot"`
}

func prepareCloudRestore(ctx context.Context, endpoint string) error {
	requested := os.Getenv("KITTIES_RESTORE_SNAPSHOT")
	if requested == "" {
		return nil
	}
	empty, err := statefs.Empty(ctx, endpoint)
	if err != nil || !empty {
		return err
	}
	directory, err := os.MkdirTemp("", "kitties-cloud-restore-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(directory)
	snapshot, err := backup.RestoreGateway(ctx, requested, directory)
	if err != nil {
		return err
	}
	gateway, err := validateRecoveryBindings(directory)
	if err != nil {
		return err
	}
	if err = os.Remove(filepath.Join(gateway, orchestrator.RecoveryFreezeFile)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err = checkRecoveryRuntime(ctx, directory); err != nil {
		return err
	}
	configuration, configErr := os.ReadFile(filepath.Join(directory, "configuration", "kitties.yaml"))
	if configErr != nil && !errors.Is(configErr, os.ErrNotExist) {
		return configErr
	}
	if configErr == nil {
		if err = os.WriteFile(filepath.Join(gateway, restoredConfig), configuration, 0o600); err != nil {
			return err
		}
	}
	raw, err := json.Marshal(restoreReceipt{Requested: requested, Snapshot: snapshot})
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(gateway, restoreMarker), raw, 0o600); err != nil {
		return err
	}
	return statefs.Import(ctx, gateway, endpoint)
}
func verifyCloudRestore(directory string) error {
	requested := os.Getenv("KITTIES_RESTORE_SNAPSHOT")
	if requested == "" {
		return nil
	}
	raw, err := os.ReadFile(filepath.Join(directory, restoreMarker))
	var receipt restoreReceipt
	if err != nil || json.Unmarshal(raw, &receipt) != nil || receipt.Requested != requested || receipt.Snapshot == "" {
		return errors.New("restore requires a fresh state service or an existing import of the same recovery snapshot")
	}
	return nil
}
func cmdRestoreGateway(args []string, out, errOut io.Writer) int {
	if len(args) < 1 || len(args) > 2 {
		fmt.Fprintln(errOut, "usage: kitties restore-gateway <absolute-empty-directory> [snapshot-id]")
		return 2
	}
	snapshot := "latest"
	if len(args) == 2 {
		snapshot = args[1]
	}
	ctx, cancel := notifyContext()
	defer cancel()
	id, err := backup.RestoreGateway(ctx, snapshot, args[0])
	if err != nil {
		fmt.Fprintf(errOut, "kitties: gateway restore failed: %v\n", err)
		return 1
	}
	fmt.Fprintf(out, "Gateway recovery %s restored to %s\n", id, args[0])
	return 0
}
func cmdImportState(args []string, out, errOut io.Writer) int {
	endpoint := os.Getenv("KITTIES_STATE_URL")
	if len(args) != 1 || endpoint == "" {
		fmt.Fprintln(errOut, "usage: KITTIES_STATE_URL=<new-state-service> kitties import-state <absolute-gateway-directory>")
		return 2
	}
	ctx, cancel := notifyContext()
	defer cancel()
	if err := statefs.Import(ctx, args[0], endpoint); err != nil {
		fmt.Fprintf(errOut, "kitties: state import failed: %v\n", err)
		return 1
	}
	fmt.Fprintln(out, "Gateway state imported atomically; configure the original secret bindings before startup.")
	return 0
}

func restoredConfiguration(explicit string) string {
	if explicit != "" {
		return explicit
	}
	if os.Getenv("KITTIES_RESTORE_SNAPSHOT") != "" && verifyCloudRestore(os.Getenv("KITTIES_DATA_DIR")) == nil {
		path := filepath.Join(os.Getenv("KITTIES_DATA_DIR"), restoredConfig)
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
			return path
		}
	}
	return config.DefaultPath()
}

func validateRecoveryBindings(directory string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(directory, "bootstrap-secrets.json"))
	if err != nil {
		return "", err
	}
	var secrets map[string]string
	if err = json.Unmarshal(raw, &secrets); err != nil {
		return "", err
	}
	for _, key := range []string{"BOAT_DEV_API_KEY", "OPENAI_API_KEY", "KITTIES_TOKEN", "KITTIES_VAULT_KEY"} {
		if secrets[key] != "" && strings.TrimSpace(os.Getenv(key)) == "" {
			return "", fmt.Errorf("recovery needs stable deployment binding %s before importing; restore it from the encrypted bootstrap-secrets file", key)
		}
	}
	if original := secrets["KITTIES_VAULT_KEY"]; original != "" {
		expected, decodeErr := base64.StdEncoding.DecodeString(strings.TrimSpace(original))
		configured, keyErr := base64.StdEncoding.DecodeString(strings.TrimSpace(os.Getenv("KITTIES_VAULT_KEY")))
		if decodeErr != nil || keyErr != nil || len(expected) != 32 || !bytes.Equal(expected, configured) {
			return "", errors.New("configured KITTIES_VAULT_KEY does not match the recovery snapshot; configure its original key before import")
		}
	}
	gateway := filepath.Join(directory, "gateway")
	if _, _, err = openCloudSecretStores(gateway); err != nil {
		return "", fmt.Errorf("recovery encryption readiness: %w", err)
	}
	return gateway, nil
}

func cmdVerifyRecovery(args []string, out, errOut io.Writer) (code int) {
	if (len(args) != 1 && len(args) != 3) || len(args[0]) != 64 || strings.Trim(args[0], "0123456789abcdef") != "" || len(args) == 3 && (args[1] != "--freeze" || !recoveryOperationID.MatchString(args[2])) {
		fmt.Fprintln(errOut, "usage: kitties verify-recovery <full-64-character-snapshot-id> [--freeze <operation-id>]")
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	if len(args) == 3 {
		defer func() {
			if code != 0 {
				if err := releaseRecovery(args[2]); err != nil {
					fmt.Fprintf(errOut, "kitties: recovery release failed: %v\n", err)
				}
			}
		}()
		if err := recoveryControl(ctx, "prepare", args[2]); err != nil {
			fmt.Fprintf(errOut, "kitties: recovery freeze failed: %v\n", err)
			return 1
		}
	}
	directory, err := os.MkdirTemp("", "kitties-verify-recovery-")
	if err != nil {
		fmt.Fprintln(errOut, "kitties: cannot create recovery verification directory")
		return 1
	}
	defer os.RemoveAll(directory)
	snapshot, err := backup.RestoreGateway(ctx, args[0], directory)
	if err == nil && snapshot != args[0] {
		err = errors.New("recovery snapshot identity changed")
	}
	if err == nil {
		_, err = validateRecoveryBindings(directory)
	}
	if err == nil {
		raw, readErr := os.ReadFile(filepath.Join(directory, "manifest.json"))
		err = readErr
		if err == nil {
			var manifest struct {
				Version int                 `json:"version"`
				Homes   []computer.Recovery `json:"homes"`
			}
			if json.Unmarshal(raw, &manifest) != nil || manifest.Version != 1 {
				err = errors.New("unsupported recovery manifest")
			} else {
				for _, home := range manifest.Homes {
					if home.Name == "" || home.Computer.CheckpointID == "" {
						err = errors.New("recovery manifest has an incomplete computer identity")
						break
					}
				}
			}
		}
	}
	if err == nil {
		err = checkRecoveryRuntime(ctx, directory)
	}
	if err != nil {
		fmt.Fprintf(errOut, "kitties: recovery verification failed: %v\n", err)
		return 1
	}
	fmt.Fprintf(out, "Recovery verified: %s\n", snapshot)
	return 0
}

func checkRecoveryRuntime(ctx context.Context, directory string) error {
	stateDir := filepath.Join(directory, "gateway", "boat")
	if _, err := os.Stat(filepath.Join(stateDir, "state.json")); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	runtime, err := boat.New(boat.Options{StateDir: stateDir, APIKey: os.Getenv("BOAT_DEV_API_KEY")})
	if err != nil {
		return fmt.Errorf("recovery Boat ownership: %w", err)
	}
	defer runtime.Close()
	if err = runtime.CheckAccess(ctx); err != nil {
		return fmt.Errorf("recovery Boat readiness: %w", err)
	}
	return nil
}
