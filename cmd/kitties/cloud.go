package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/madkoding/kitties/internal/keep"
	"github.com/madkoding/kitties/internal/statefs"
	"github.com/madkoding/kitties/internal/vault"
)

func (a *app) close() error {
	var errs []error
	if a.backups != nil {
		a.backups.Close()
		a.backups = nil
	}
	if a.chats != nil {
		a.chats.Shutdown()
	}
	if a.fleet != nil {
		a.fleet.Accounts().Close()
		a.fleet.Close()
	}
	if a.closeRuntime != nil {
		errs = append(errs, a.closeRuntime())
		a.closeRuntime = nil
	}
	if a.stateLock != nil {
		errs = append(errs, a.stateLock.Close())
		a.stateLock = nil
	}
	if a.remoteState != nil {
		a.remoteState.Close()
		a.remoteState = nil
	}
	return errors.Join(errs...)
}

func openCloudSecretStores(dir string) (*vault.Store, *keep.Store, error) {
	if strings.TrimSpace(os.Getenv(vault.KeyEnv)) == "" {
		if _, err := os.Stat(filepath.Join(dir, "vault.key")); errors.Is(err, os.ErrNotExist) {
			for _, name := range []string{"cloud.keycheck", "vault.json", "backups", "kitties.json", "settings.json", "chats", "accounts", "boat"} {
				if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
					return nil, nil, errors.New("the cloud data directory is missing vault.key; restore its original key or set KITTIES_VAULT_KEY before starting")
				} else if !errors.Is(err, os.ErrNotExist) {
					return nil, nil, err
				}
			}
		} else if err != nil {
			return nil, nil, err
		}
	}
	v, err := vault.Open(dir)
	if err != nil {
		return nil, nil, err
	}
	k, err := keep.Open(dir)
	if err != nil {
		return nil, nil, err
	}
	if err := v.ValidateKey(); err != nil {
		return nil, nil, err
	}
	if err := k.ValidateKey(); err != nil {
		return nil, nil, err
	}
	box, err := vault.NewBox(dir)
	if err != nil {
		return nil, nil, err
	}
	path := filepath.Join(dir, "cloud.keycheck")
	aad := []byte("kitties-cloud-state-v1")
	sealed, err := os.ReadFile(path)
	switch {
	case err == nil:
		plain, err := box.Open(sealed, aad)
		if err != nil || !bytes.Equal(plain, aad) {
			return nil, nil, errors.New("the cloud encryption key does not match this data directory")
		}
	case errors.Is(err, os.ErrNotExist):
		sealed, err := box.Seal(aad, aad)
		if err != nil {
			return nil, nil, err
		}
		if err := statefs.WriteFile(path+".tmp", sealed, 0o600); err != nil {
			return nil, nil, err
		}
		if err := statefs.Rename(path+".tmp", path); err != nil {
			return nil, nil, err
		}
	default:
		return nil, nil, fmt.Errorf("read cloud key check: %w", err)
	}
	return v, k, nil
}

func saveGatewayToken(path, token string) error {
	if err := statefs.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".gateway-token-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.WriteString(token + "\n"); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return statefs.Rename(file.Name(), path)
}
